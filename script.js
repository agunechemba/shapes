const canvas = document.querySelector("canvas"),
  toolBtns = document.querySelectorAll(".tool"),
  fillColor = document.querySelector("#fill-color"),
  sizeSlider = document.querySelector("#size-slider"),
  colorPicker = document.querySelector("#color-picker"),
  clearCanvas = document.querySelector(".clear-canvas"),
  saveImg = document.querySelector(".save-img"),
  deleteShapeBtn = document.querySelector(".delete-shape"),
  ctx = canvas.getContext("2d");

const STORAGE_KEY = "shapes-drawing-app:v1";
const SAVE_DELAY = 300;
let saveTimer = null;
let isRestoring = false;

// global state
let objects = [];
let selectedTool = "brush";
let brushWidth = 5;
let selectedColor = "#000000";

let selectedShape = null;
let currentShape = null;
let currentBrush = null;

let isDrawing = false;
let isMoving = false;
let isResizing = false;
let activeHandle = null;

let dragStart = { x: 0, y: 0 };
let originalObject = null;
let originalBBox = null;
let originalPoints = null;
let prevMouseX = 0,
  prevMouseY = 0;

/* ------------------------- geometry helpers ------------------------- */

const getBBox = (obj) => {
  if (obj.type === "brush") {
    const pts = obj.points || [];
    if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    const pad = (obj.lineWidth || brushWidth) / 2;
    return {
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
    };
  }

  const x = Math.min(obj.x1, obj.x2);
  const y = Math.min(obj.y1, obj.y2);
  const w = Math.abs(obj.x2 - obj.x1);
  const h = Math.abs(obj.y2 - obj.y1);
  return { x, y, w, h };
};

const distToSegment = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);

  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

const pointInObject = (obj, px, py, extra = 4) => {
  if (obj.type === "brush") {
    const tol = (obj.lineWidth || brushWidth) / 2 + extra;
    const pts = obj.points || [];
    if (!pts.length) return false;

    if (pts.length === 1) {
      return Math.hypot(px - pts[0].x, py - pts[0].y) <= tol;
    }

    for (let i = 1; i < pts.length; i++) {
      if (distToSegment(px, py, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tol) {
        return true;
      }
    }
    return false;
  }

  const b = getBBox(obj);
  const tol = Math.max(6, (obj.lineWidth || brushWidth) / 2) + extra;

  return (
    px >= b.x - tol &&
    px <= b.x + b.w + tol &&
    py >= b.y - tol &&
    py <= b.y + b.h + tol
  );
};

const getHandles = (obj) => {
  const b = getBBox(obj);
  return [
    { id: "nw", x: b.x, y: b.y },
    { id: "n", x: b.x + b.w / 2, y: b.y },
    { id: "ne", x: b.x + b.w, y: b.y },
    { id: "e", x: b.x + b.w, y: b.y + b.h / 2 },
    { id: "se", x: b.x + b.w, y: b.y + b.h },
    { id: "s", x: b.x + b.w / 2, y: b.y + b.h },
    { id: "sw", x: b.x, y: b.y + b.h },
    { id: "w", x: b.x, y: b.y + b.h / 2 },
  ];
};

const getHandleAt = (obj, px, py) => {
  for (const h of getHandles(obj)) {
    if (Math.hypot(px - h.x, py - h.y) <= 8) return h.id;
  }
  return null;
};

const cursorForHandle = (handle) => {
  return (
    {
      nw: "nwse-resize",
      n: "ns-resize",
      ne: "nesw-resize",
      e: "ew-resize",
      se: "nwse-resize",
      s: "ns-resize",
      sw: "nesw-resize",
      w: "ew-resize",
    }[handle] || "default"
  );
};

/* ------------------------- local storage ------------------------- */

const normalizeColor = (value) => {
  if (typeof value !== "string") return "#000000";
  let c = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(c)) {
    c = "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
  }
  return /^#[0-9a-f]{6}$/.test(c) ? c : "#000000";
};

const sanitizeObject = (obj) => {
  if (!obj || typeof obj !== "object") return null;
  const type = obj.type;
  if (!["brush", "rectangle", "circle", "triangle"].includes(type)) return null;

  const color = normalizeColor(obj.color);
  const lineWidth = Number(obj.lineWidth);
  if (!Number.isFinite(lineWidth) || lineWidth <= 0) return null;

  if (type === "brush") {
    if (!Array.isArray(obj.points)) return null;
    const points = obj.points
      .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ x: p.x, y: p.y }));
    if (!points.length) return null;
    return { type, points, color, lineWidth };
  }

  const x1 = Number(obj.x1);
  const y1 = Number(obj.y1);
  const x2 = Number(obj.x2);
  const y2 = Number(obj.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;

  return { type, x1, y1, x2, y2, color, lineWidth, fill: !!obj.fill };
};

const getSerializableState = () => ({
  version: 1,
  objects,
  selectedTool,
  brushWidth,
  selectedColor: normalizeColor(selectedColor),
  fillColor: fillColor.checked,
  colorPickerValue: colorPicker.value,
  customColor: pickerSwatch.classList.contains("selected"),
});

const saveState = () => {
  if (isRestoring) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getSerializableState()));
  } catch (err) {
    console.warn("Could not save drawing to localStorage:", err);
  }
};

const scheduleSave = () => {
  if (isRestoring) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, SAVE_DELAY);
};

const restoreState = () => {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn("Could not read localStorage:", err);
    return;
  }
  if (!raw) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.warn("Saved drawing data is corrupted:", err);
    return;
  }
  if (!data || data.version !== 1) return;

  isRestoring = true;

  if (Array.isArray(data.objects)) {
    objects = data.objects.map(sanitizeObject).filter(Boolean);
  } else {
    objects = [];
  }

  if (
    typeof data.selectedTool === "string" &&
    ["select", "brush", "eraser", "rectangle", "circle", "triangle"].includes(
      data.selectedTool
    )
  ) {
    selectedTool = data.selectedTool;
    document.querySelectorAll(".tool").forEach((btn) => btn.classList.remove("active"));
    const btn = document.getElementById(selectedTool);
    if (btn) btn.classList.add("active");
  }

  if (Number.isFinite(data.brushWidth)) {
    brushWidth = Math.min(30, Math.max(1, data.brushWidth));
    sizeSlider.value = brushWidth;
  }

  fillColor.checked = !!data.fillColor;

  if (
    typeof data.colorPickerValue === "string" &&
    /^#[0-9a-f]{6}$/i.test(data.colorPickerValue)
  ) {
    colorPicker.value = data.colorPickerValue;
  }

  if (typeof data.selectedColor === "string") {
    selectedColor = normalizeColor(data.selectedColor);
  }

  swatchButtons.forEach((s) => s.classList.remove("selected"));
  if (data.customColor) {
    pickerSwatch.style.background = selectedColor;
    pickerSwatch.classList.add("selected");
  } else {
    let matched = null;
    swatchButtons.forEach((btn) => {
      if (btn === pickerSwatch) return;
      const c = normalizeColor(btn.dataset.color);
      if (c === selectedColor) matched = btn;
    });
    if (matched) {
      matched.classList.add("selected");
    } else {
      pickerSwatch.style.background = selectedColor;
      pickerSwatch.classList.add("selected");
    }
  }

  isRestoring = false;
  redraw();
};

/* ------------------------- drawing ------------------------- */

const drawObject = (context, obj) => {
  context.save();
  context.lineWidth = obj.lineWidth || brushWidth;
  context.strokeStyle = obj.color;
  context.fillStyle = obj.color;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (obj.type === "brush") {
    const pts = obj.points || [];
    if (!pts.length) {
      context.restore();
      return;
    }

    context.beginPath();
    context.moveTo(pts[0].x, pts[0].y);

    for (let i = 1; i < pts.length; i++) {
      context.lineTo(pts[i].x, pts[i].y);
    }

    if (pts.length === 1) {
      context.lineTo(pts[0].x + 0.01, pts[0].y + 0.01);
    }

    context.stroke();
    context.restore();
    return;
  }

  const { x, y, w, h } = getBBox(obj);
  context.beginPath();

  if (obj.type === "rectangle") {
    context.rect(x, y, w, h);
  } else if (obj.type === "circle") {
    context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (obj.type === "triangle") {
    context.moveTo(x + w / 2, y);
    context.lineTo(x + w, y + h);
    context.lineTo(x, y + h);
    context.closePath();
  }

  if (obj.fill) {
    context.fill();
    context.stroke();
  } else {
    context.stroke();
  }

  context.restore();
};

const drawSelection = (context, obj) => {
  const b = getBBox(obj);

  context.save();
  context.strokeStyle = "#6DD400";
  context.lineWidth = 1;
  context.setLineDash([5, 4]);
  context.strokeRect(b.x, b.y, b.w, b.h);
  context.setLineDash([]);

  context.fillStyle = "#fff";
  context.strokeStyle = "#6DD400";
  context.lineWidth = 1.5;

  getHandles(obj).forEach((h) => {
    context.fillRect(h.x - 4, h.y - 4, 8, 8);
    context.strokeRect(h.x - 4, h.y - 4, 8, 8);
  });

  context.restore();
};

const redraw = () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  objects.forEach((obj) => drawObject(ctx, obj));

  if (currentShape) drawObject(ctx, currentShape);
  if (currentBrush) drawObject(ctx, currentBrush);

  if (selectedShape && selectedTool === "select") {
    drawSelection(ctx, selectedShape);
  }
};

/* ------------------------- selection interactions ------------------------- */

const updateCursor = (x, y) => {
  if (selectedShape) {
    const handle = getHandleAt(selectedShape, x, y);
    if (handle) {
      canvas.style.cursor = cursorForHandle(handle);
      return;
    }
  }

  const hit = [...objects].reverse().find((obj) => pointInObject(obj, x, y));
  canvas.style.cursor = hit ? "move" : "default";
};

const handleSelectDown = (x, y) => {
  if (selectedShape) {
    const handle = getHandleAt(selectedShape, x, y);
    if (handle) {
      isResizing = true;
      activeHandle = handle;
      dragStart = { x, y };
      originalBBox = getBBox(selectedShape);
      originalPoints =
        selectedShape.type === "brush"
          ? selectedShape.points.map((p) => ({ ...p }))
          : null;
      return;
    }
  }

  const hit = [...objects].reverse().find((obj) => pointInObject(obj, x, y));

  if (!hit) {
    selectedShape = null;
    redraw();
    return;
  }

  selectedShape = hit;
  isMoving = true;
  dragStart = { x, y };

  if (hit.type === "brush") {
    originalObject = { points: hit.points.map((p) => ({ ...p })) };
  } else {
    originalObject = {
      x1: hit.x1,
      y1: hit.y1,
      x2: hit.x2,
      y2: hit.y2,
    };
  }

  redraw();
};

const handleSelectMove = (x, y) => {
  if (!selectedShape) return;

  if (isMoving && originalObject) {
    const dx = x - dragStart.x;
    const dy = y - dragStart.y;

    if (selectedShape.type === "brush") {
      selectedShape.points = originalObject.points.map((p) => ({
        x: p.x + dx,
        y: p.y + dy,
      }));
    } else {
      selectedShape.x1 = originalObject.x1 + dx;
      selectedShape.y1 = originalObject.y1 + dy;
      selectedShape.x2 = originalObject.x2 + dx;
      selectedShape.y2 = originalObject.y2 + dy;
    }

    redraw();
    return;
  }

  if (isResizing && activeHandle && originalBBox) {
    let left = originalBBox.x;
    let top = originalBBox.y;
    let right = originalBBox.x + originalBBox.w;
    let bottom = originalBBox.y + originalBBox.h;

    const dx = x - dragStart.x;
    const dy = y - dragStart.y;

    if (activeHandle.includes("w")) left += dx;
    if (activeHandle.includes("e")) right += dx;
    if (activeHandle.includes("n")) top += dy;
    if (activeHandle.includes("s")) bottom += dy;

    if (right - left < 1) {
      if (activeHandle.includes("w")) left = right - 1;
      else right = left + 1;
    }

    if (bottom - top < 1) {
      if (activeHandle.includes("n")) top = bottom - 1;
      else bottom = top + 1;
    }

    const newBBox = {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top,
    };

    if (selectedShape.type === "brush") {
      const sx = originalBBox.w > 0 ? newBBox.w / originalBBox.w : 1;
      const sy = originalBBox.h > 0 ? newBBox.h / originalBBox.h : 1;

      selectedShape.points = originalPoints.map((p) => ({
        x: newBBox.x + (p.x - originalBBox.x) * sx,
        y: newBBox.y + (p.y - originalBBox.y) * sy,
      }));
    } else {
      selectedShape.x1 = newBBox.x;
      selectedShape.y1 = newBBox.y;
      selectedShape.x2 = newBBox.x + newBBox.w;
      selectedShape.y2 = newBBox.y + newBBox.h;
    }

    redraw();
  }
};

/* ------------------------- eraser ------------------------- */

const removeObjectsAt = (px, py, radius) => {
  objects = objects.filter((obj) => !pointInObject(obj, px, py, radius));
  if (selectedShape && !objects.includes(selectedShape)) {
    selectedShape = null;
  }
};

/* ------------------------- mouse events ------------------------- */

const startDraw = (e) => {
  const x = e.offsetX;
  const y = e.offsetY;

  if (selectedTool === "select") {
    handleSelectDown(x, y);
    return;
  }

  if (selectedTool === "brush") {
    isDrawing = true;
    currentBrush = {
      type: "brush",
      points: [{ x, y }],
      color: selectedColor,
      lineWidth: brushWidth,
    };
    redraw();
    return;
  }

  if (selectedTool === "eraser") {
    isDrawing = true;
    prevMouseX = x;
    prevMouseY = y;
    removeObjectsAt(x, y, brushWidth / 2);
    redraw();
    return;
  }

  isDrawing = true;
  currentShape = {
    type: selectedTool,
    x1: x,
    y1: y,
    x2: x,
    y2: y,
    color: selectedColor,
    fill: fillColor.checked,
    lineWidth: brushWidth,
  };
  redraw();
};

const drawing = (e) => {
  const x = e.offsetX;
  const y = e.offsetY;

  if (selectedTool === "select") {
    if (isMoving || isResizing) {
      handleSelectMove(x, y);
    } else {
      updateCursor(x, y);
    }
    return;
  }

  if (!isDrawing) return;

  if (selectedTool === "brush" && currentBrush) {
    currentBrush.points.push({ x, y });
    redraw();
    return;
  }

  if (selectedTool === "eraser") {
    const steps = Math.max(
      1,
      Math.ceil(
        Math.hypot(x - prevMouseX, y - prevMouseY) / Math.max(1, brushWidth / 2)
      )
    );

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = prevMouseX + (x - prevMouseX) * t;
      const py = prevMouseY + (y - prevMouseY) * t;
      removeObjectsAt(px, py, brushWidth / 2);
    }

    prevMouseX = x;
    prevMouseY = y;
    redraw();
    return;
  }

  if (currentShape) {
    currentShape.x2 = x;
    currentShape.y2 = y;
    redraw();
  }
};

const stopDraw = () => {
  if (selectedTool === "select") {
    isMoving = false;
    isResizing = false;
    activeHandle = null;
    originalObject = null;
    originalBBox = null;
    originalPoints = null;
    scheduleSave();
    return;
  }

  if (!isDrawing) return;

  if (selectedTool === "brush" && currentBrush) {
    if (currentBrush.points.length > 0) {
      objects.push(currentBrush);
    }
    currentBrush = null;
  } else if (currentShape) {
    const b = getBBox(currentShape);
    if (b.w > 1 || b.h > 1) {
      objects.push(currentShape);
    }
    currentShape = null;
  }

  isDrawing = false;
  redraw();
  scheduleSave();
};

/* ------------------------- tool buttons ------------------------- */

toolBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const active = document.querySelector(".options .active");
    if (active) active.classList.remove("active");

    btn.classList.add("active");
    selectedTool = btn.id;

    selectedShape = null;
    currentShape = null;
    currentBrush = null;
    isDrawing = false;
    isMoving = false;
    isResizing = false;

    canvas.style.cursor = selectedTool === "select" ? "default" : "crosshair";
    redraw();
    scheduleSave();
  });
});

sizeSlider.addEventListener("change", () => {
  brushWidth = Number(sizeSlider.value);
  scheduleSave();
});

fillColor.addEventListener("change", scheduleSave);

/* ------------------------- colors ------------------------- */

const swatchButtons = document.querySelectorAll(".colors .option");
const pickerSwatch = colorPicker.parentElement;

const selectSwatch = (swatch, color) => {
  swatchButtons.forEach((s) => s.classList.remove("selected"));
  swatch.classList.add("selected");
  selectedColor = normalizeColor(color);
  scheduleSave();
};

// Preset swatches — use data-color, listen on pointerdown (fires before
// click, works for mouse and touch, and is not affected by the
// ::before "selected" ring that overlays the swatch centre).
swatchButtons.forEach((btn) => {
  if (btn === pickerSwatch) return;

  const pickPreset = () => {
    const color = btn.dataset.color;
    if (!color) return;
    selectSwatch(btn, color);
  };

  btn.addEventListener("pointerdown", pickPreset);
  // Fallback for very old browsers without pointer events
  if (!("onpointerdown" in window)) {
    btn.addEventListener("click", pickPreset);
  }
});

// Custom picker swatch — listen to both `input` (fires live while the
// native dialog is open) and `change` (fires when it closes) so we
// never miss the final value, regardless of browser.
const handlePickerChange = () => {
  const value = colorPicker.value;
  if (!value) return;

  pickerSwatch.style.background = value;
  selectSwatch(pickerSwatch, value);
};

colorPicker.addEventListener("input", handlePickerChange);
colorPicker.addEventListener("change", handlePickerChange);

/* ------------------------- buttons ------------------------- */

clearCanvas.addEventListener("click", () => {
  objects = [];
  selectedShape = null;
  currentShape = null;
  currentBrush = null;
  isDrawing = false;
  isMoving = false;
  isResizing = false;
  redraw();
  scheduleSave();
});

deleteShapeBtn.addEventListener("click", () => {
  if (!selectedShape) return;
  objects = objects.filter((obj) => obj !== selectedShape);
  selectedShape = null;
  redraw();
  scheduleSave();
});

/* ------------------------- SVG export ------------------------- */

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const buildSVG = () => {
  const w = canvas.width;
  const h = canvas.height;
  const parts = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
  );
  // Opaque white background
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>`);

  objects.forEach((obj) => {
    const color = escapeXml(obj.color || "#000");
    const lw = obj.lineWidth || brushWidth;
    const common =
      `stroke="${color}" stroke-width="${lw}" ` +
      `stroke-linecap="round" stroke-linejoin="round"`;

    if (obj.type === "brush") {
      const pts = obj.points || [];
      if (!pts.length) return;

      const d = pts
        .map((p, i) =>
          `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`
        )
        .join(" ");

      // Single-point stroke → render a tiny visible dot
      const finalD =
        pts.length === 1
          ? `M${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)} ` +
            `L${(pts[0].x + 0.01).toFixed(2)} ${(pts[0].y + 0.01).toFixed(2)}`
          : d;

      parts.push(`<path d="${finalD}" fill="none" ${common}/>`);
      return;
    }

    const { x, y, w: bw, h: bh } = getBBox(obj);
    const fill = obj.fill ? color : "none";

    if (obj.type === "rectangle") {
      parts.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" ` +
          `width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" ` +
          `fill="${fill}" ${common}/>`
      );
    } else if (obj.type === "circle") {
      parts.push(
        `<ellipse cx="${(x + bw / 2).toFixed(2)}" ` +
          `cy="${(y + bh / 2).toFixed(2)}" ` +
          `rx="${(bw / 2).toFixed(2)}" ry="${(bh / 2).toFixed(2)}" ` +
          `fill="${fill}" ${common}/>`
      );
    } else if (obj.type === "triangle") {
      const points =
        `${(x + bw / 2).toFixed(2)},${y.toFixed(2)} ` +
        `${(x + bw).toFixed(2)},${(y + bh).toFixed(2)} ` +
        `${x.toFixed(2)},${(y + bh).toFixed(2)}`;

      parts.push(
        `<polygon points="${points}" fill="${fill}" ${common}/>`
      );
    }
  });

  parts.push(`</svg>`);
  return parts.join("\n");
};

saveImg.addEventListener("click", () => {
  const svg = buildSVG();
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.download = `${Date.now()}.svg`;
  link.href = url;
  link.click();

  // Release the blob URL once the browser has started the download
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

/* ------------------------- init & keyboard ------------------------- */

window.addEventListener("load", () => {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  objects = [];
  selectedShape = null;
  redraw();
  restoreState();
  canvas.style.cursor = selectedTool === "select" ? "default" : "crosshair";
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
    if (selectedShape) {
      e.preventDefault();
      deleteShapeBtn.click();
    }
  }

  if (e.key === "Escape") {
    selectedShape = null;
    redraw();
  }
});

canvas.addEventListener("mousedown", startDraw);
canvas.addEventListener("mousemove", drawing);
canvas.addEventListener("mouseup", stopDraw);
canvas.addEventListener("mouseleave", () => {
  if (isDrawing || isMoving || isResizing) stopDraw();
});

window.addEventListener("beforeunload", saveState);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveState();
});
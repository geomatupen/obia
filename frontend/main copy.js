/* =========================
 * Map init
 * ========================= */
const map = L.map('map').setView([47.899167, 17.007472], 18);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 22,
  attribution: '© OpenStreetMap'
}).addTo(map);

/* =========================
 * Global state
 * ========================= */
let layers = {}; // name -> { type:'raster'|'segment', leafletLayer?, geojson?, visible?, bounds?, rasterId?, segmentId?, style?, hasSamples? }
let activeLayerName = null;

let segmentLayer = null;               // pointer to the current selectable Leaflet layer (for resetSelections)
let segmentLayerName = null;

let classColors = {};                  // { class_key: color }
let classData = {};                    // { class_key: [segment_ids] }
let currentClassKey = null;

let samplePickingEnabled = false;      // only true when Samples tab activates a segment
let activeSamplingLayerName = null;    // which layer is selectable

// styling guard (don’t pick samples while styling a layer)
let _styleWasPicking = false;
let _styleModalOpen = false;

// expose minimal globals for other scripts
window.layers = layers;

/* =========================
 * Helpers
 * ========================= */
function BACKEND() { return window.BACKEND_URL || "http://localhost:8001"; }

function getUniqueLayerName(base) {
  if (!layers[base]) return base;
  let i = 2;
  while (layers[`${base} (${i})`]) i++;
  return `${base} (${i})`;
}

function getActiveRasterRecord() {
  if (activeLayerName && layers[activeLayerName] && layers[activeLayerName].type === "raster") {
    return { name: activeLayerName, rec: layers[activeLayerName] };
  }
  for (const [n, r] of Object.entries(layers)) {
    if (r.type === "raster") return { name: n, rec: r };
  }
  return null;
}

function generateRandomColor() {
  const letters = '0123456789ABCDEF'; let color = '#';
  for (let i = 0; i < 6; i++) color += letters[Math.floor(Math.random() * 16)];
  return color;
}

/* =========================
 * Legend (for sample classes)
 * ========================= */
const legendControl = L.control({ position: "bottomright" });
legendControl.onAdd = function () {
  const div = L.DomUtil.create("div", "legend");
  div.innerHTML = "<b>Legend</b><br>";
  for (let key in classColors) {
    const labelEl = document.getElementById(`label_${key}`);
    const label = (labelEl && labelEl.value) ? labelEl.value : key;
    div.innerHTML += `<span class="legend-color" style="background:${classColors[key]}"></span>${label}<br>`;
  }
  return div;
};
legendControl.addTo(map);

/* =========================
 * Per-layer style state
 * ========================= */
function ensureStyleState(layerName) {
  const rec = layers[layerName];
  if (!rec) return null;
  if (!rec.style) rec.style = { attr: null, map: {} };
  if (!rec.style.map) rec.style.map = {};
  return rec.style;
}
function getStyleState(layerName) {
  const rec = layers[layerName];
  return rec && rec.style ? rec.style : { attr: null, map: {} };
}

/* =========================
 * Raster: backend listing / upload → tile layer
 * ========================= */
function getRasterSelectEl() { return document.getElementById('orthoSelect'); }

function refreshRasterDropdown() {
  const sel = getRasterSelectEl();
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";

  const rasters = Object.entries(layers).filter(([, rec]) => rec.type === "raster");
  if (!rasters.length) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "— select raster —";
    sel.appendChild(opt);
    return;
  }
  rasters.forEach(([name, rec]) => {
    const opt = document.createElement("option");
    opt.value = rec.rasterId || name;
    opt.textContent = name;
    opt.dataset.name = name;
    sel.appendChild(opt);
  });
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  else sel.selectedIndex = 0;
}

function hookRasterDropdownSelection() {
  const sel = getRasterSelectEl(); if (!sel) return;
  sel.addEventListener("change", () => {
    const opt = sel.options[sel.selectedIndex];
    const name = (opt && opt.dataset && opt.dataset.name) ? opt.dataset.name : (opt ? opt.textContent : "");
    if (name && layers[name]) activeLayerName = name;
  });
}

async function listRasters() {
  const r = await fetch(`${BACKEND()}/rasters`, { cache: "no-store" });
  if (!r.ok) return { rasters: [] };
  return r.json();
}

async function getRasterStatus(rid) {
  const r = await fetch(`${BACKEND()}/rasters/${rid}/status`, { cache: "no-store" });
  if (!r.ok) return null;
  return r.json(); // {zooms, tile_url, status:{state}}
}

function addTileLayerXYZ(url, minZ, maxZ, name, bounds, addToMap = true, meta = {}) {
  const safeName = getUniqueLayerName(name);
  const tl = L.tileLayer(url, { tms: false, minZoom: minZ ?? 0, maxZoom: maxZ ?? 22, attribution: safeName });
  if (addToMap) tl.addTo(map);

  layers[safeName] = { type: "raster", leafletLayer: tl, visible: !!addToMap, bounds, minZ, maxZ, rasterId: meta.id || null };
  if (!activeLayerName) activeLayerName = safeName;

  if (addToMap && bounds && bounds.length === 4) {
    map.fitBounds([[bounds[1], bounds[0]], [bounds[3], bounds[2]]]);
    const z = map.getZoom();
    if (minZ != null && z < minZ) map.setZoom(minZ);
    if (maxZ != null && z > maxZ) map.setZoom(maxZ);
  }
  renderLayerList();
  refreshRasterDropdown();
  setTimeout(() => map.invalidateSize(), 0);
  return tl;
}

async function loadImageAsGeoRaster(file, name) {
  const statusEl = document.getElementById("imageLoadStatus");
  try {
    if (statusEl) statusEl.innerText = "Uploading…";
    const fd = new FormData();
    fd.append("file", file);
    const resp = await fetch(`${BACKEND()}/rasters`, { method: "POST", body: fd });
    if (!resp.ok) throw new Error(await resp.text());
    const info = await resp.json(); // {id,name,bounds,tile_url}

    if (statusEl) statusEl.innerText = "Tiling…";
    let st = null;
    while (true) {
      st = await getRasterStatus(info.id);
      const state = st && st.status ? st.status.state : "unknown";
      if (state === "done") break;
      if (state === "error") { if (statusEl) statusEl.innerText = "Tiling error"; return; }
      await new Promise(r => setTimeout(r, 900));
    }
    if (!st) { if (statusEl) statusEl.innerText = "No status"; return; }

    const url = `${BACKEND()}${st.tile_url}`;
    const zooms = st.zooms || [];
    const minZ = zooms.length ? Math.min(...zooms) : 0;
    const maxZ = zooms.length ? Math.max(...zooms) : 22;
    addTileLayerXYZ(url, minZ, maxZ, info.name || name, info.bounds, true, { id: info.id });

    if (statusEl) statusEl.innerText = "Done";
    const closeBtn = document.getElementById('closeAddLayerModal');
    if (closeBtn) closeBtn.click();
  } catch (err) {
    console.error("Failed to add raster:", err);
    if (statusEl) statusEl.innerText = "Failed to add raster";
  }
}

// Auto-load rasters on startup
document.addEventListener("DOMContentLoaded", async function() {
  const data = await listRasters();
  const arr = data.rasters || [];
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i];
    const st = await getRasterStatus(r.id);
    if (!st || !(st.zooms || []).length) continue;
    const url = `${BACKEND()}${st.tile_url}`;
    const zooms = st.zooms || [];
    addTileLayerXYZ(url, Math.min(...zooms), Math.max(...zooms), r.name, r.bounds, i === 0, { id: r.id });
  }
  refreshRasterDropdown();
  hookRasterDropdownSelection();
});

/* =========================
 * Segmentation
 * ========================= */
async function startSegmentationForActiveRaster(params) {
  const use = getActiveRasterRecord();
  if (!use) { alert("Select a raster layer first."); return; }
  if (!use.rec.rasterId) { alert("Raster has no backend id; upload via backend flow."); return; }

  const scale = Number(params && params.scale);
  const compactness = Number(params && params.compactness);

  const payload = {
    raster_id: String(use.rec.rasterId),
    scale: (isFinite(scale) ? scale : 30),
    compactness: (isFinite(compactness) ? compactness : 0.3)
  };

  const url = `${BACKEND()}/segment`;
  let r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) {
    // fallback form-data, if backend expects it
    const fd = new FormData();
    fd.append("raster_id", payload.raster_id);
    fd.append("scale", String(payload.scale));
    fd.append("compactness", String(payload.compactness));
    r = await fetch(url, { method: "POST", body: fd });
  }
  if (!r.ok) { alert("Failed to start segmentation"); return; }

  const data = await r.json();
  const segId = data.segment_id;
  const gjUrl = data.geojson_url;
  if (!segId || !gjUrl) { alert("No segmentation result"); return; }

  const fc = await fetch(`${BACKEND()}${gjUrl}`, { cache: "no-store" }).then(x => x.json());
  const baseName = data.name || (`Segments - ${use.name}`);
  const segName = getUniqueLayerName(baseName);
  segmentLayerIdentify(segName, fc, { segmentId: segId });

  const segStatus = document.getElementById("segStatus");
  if (segStatus) segStatus.innerText = "Segmentation done.";
  if (window.refreshSegmentDropdown) window.refreshSegmentDropdown();
}

// Wire the button from index.html
function runSegmentation() {
  const scaleEl = document.getElementById("segScale");
  const compEl = document.getElementById("segCompactness");
  const scale = scaleEl ? scaleEl.value : undefined;
  const compactness = compEl ? compEl.value : undefined;
  startSegmentationForActiveRaster({ scale, compactness });
}
window.runSegmentation = runSegmentation;

/* =========================
 * Layers list (with menu)
 * ========================= */
function setLayerVisibility(name, visible) {
  const rec = layers[name]; if (!rec || !rec.leafletLayer) return;
  if (visible) { if (!map.hasLayer(rec.leafletLayer)) rec.leafletLayer.addTo(map); rec.visible = true; }
  else { if (map.hasLayer(rec.leafletLayer)) map.removeLayer(rec.leafletLayer); rec.visible = false; }
}

function zoomToLayer(name) {
  const rec = layers[name]; if (!rec) return;
  if (rec.bounds && rec.bounds.length === 4) {
    map.fitBounds([[rec.bounds[1], rec.bounds[0]], [rec.bounds[3], rec.bounds[2]]]);
    return;
  }
  if (rec.leafletLayer && rec.leafletLayer.getBounds) {
    const b = rec.leafletLayer.getBounds();
    if (b && b.isValid && b.isValid()) map.fitBounds(b);
  }
}

function removeLayerEntry(name) {
  const rec = layers[name];
  if (!rec) return;
  if (rec.leafletLayer && map.hasLayer(rec.leafletLayer)) map.removeLayer(rec.leafletLayer);
  delete layers[name];
  if (activeLayerName === name) activeLayerName = null;

  // If removing the currently selectable one, disable picking
  if (activeSamplingLayerName === name) {
    activeSamplingLayerName = null;
    samplePickingEnabled = false;
    const a = document.getElementById("classificationInfo");
    const b = document.getElementById("classificationTool");
    if (a) a.style.display = "block";
    if (b) b.style.display = "none";
  }
  renderLayerList();
  refreshRasterDropdown();
  if (window.refreshSegmentDropdown) window.refreshSegmentDropdown();
}

function renderLayerList() {
  const list = document.getElementById("layerList");
  if (!list) return;

  list.innerHTML = "";
  const heading = document.createElement("h4");
  heading.textContent = "Layers";
  list.appendChild(heading);

  Object.entries(layers).forEach(([name, rec]) => {
    const row = document.createElement("div");
    row.className = "layer-row";
    if (activeLayerName === name) row.classList.add("active");

    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.className = "layer-checkbox";
    cb.checked = rec.visible !== false;

    const label = document.createElement("span");
    label.className = "layer-name";
    label.textContent = name;

    const left = document.createElement("div");
    left.className = "layer-left";
    left.appendChild(cb);
    left.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "layer-actions";
    const kebab = document.createElement("button");
    kebab.className = "layer-kebab";
    kebab.innerHTML = "⋮";
    actions.appendChild(kebab);

    const menu = document.createElement("div");
    menu.className = "layer-menu hidden";

    // Style button only for GeoJSON layers (non-raster)
    if (rec.type !== "raster" && rec.geojson) {
      const styleBtn = document.createElement("button");
      styleBtn.className = "layer-menu-item";
      styleBtn.textContent = "Style";
      styleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.classList.add("hidden");
        openStyleModal(name);   // <- styles THIS layer only
      });
      menu.appendChild(styleBtn);
    }

    const zoomBtn = document.createElement("button");
    zoomBtn.className = "layer-menu-item";
    zoomBtn.textContent = "Zoom to layer";
    zoomBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.add("hidden"); zoomToLayer(name); });
    menu.appendChild(zoomBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "layer-menu-item";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.add("hidden"); removeLayerEntry(name); });
    menu.appendChild(delBtn);

    actions.appendChild(menu);

    cb.addEventListener("change", () => setLayerVisibility(name, cb.checked));

    label.addEventListener("click", () => {
      document.querySelectorAll("#layerList .layer-row").forEach(x => x.classList.remove("active"));
      row.classList.add("active");
      activeLayerName = name;
    });

    kebab.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
    document.addEventListener("click", () => menu.classList.add("hidden"));

    row.appendChild(left);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

/* =========================
 * GeoJSON add / load
 * ========================= */
const dropZone = document.getElementById("dropZone");
if (dropZone) {
  dropZone.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".geojson,.json,.tif,.tiff,.png,.jpg,.jpeg";
    input.onchange = e => { if (e.target.files.length) handleFileUpload(e.target.files[0]); };
    input.click();
  });
  dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault(); dropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files[0]);
  });
}

function handleFileUpload(file) {
  const fileName = file.name.toLowerCase();
  const isGeoJSON = /\.(geojson|json)$/.test(fileName);
  const isImage = /\.(tif|tiff|png|jpg|jpeg)$/.test(fileName);

  if (isGeoJSON) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const raw = e.target.result;
        const gj = JSON.parse(raw);
        if (!gj.type || (gj.type !== "FeatureCollection" && gj.type !== "Feature")) throw new Error("Invalid GeoJSON");
        const name = file.name.replace(/\.[^/.]+$/, "");
        segmentLayerIdentify(name, gj);
      } catch (err) {
        console.error("GeoJSON parse failed:", err);
        alert("Invalid GeoJSON file.");
      }
    };
    reader.onerror = () => alert("Error reading the GeoJSON file.");
    reader.readAsText(file);
  } else if (isImage) {
    const name = file.name.replace(/\.[^/.]+$/, "");
    loadImageAsGeoRaster(file, name);
  } else {
    alert("Unsupported file type.");
  }
}

function loadGeoJSONByPath() {
  const inputEl = document.getElementById("geojsonPath");
  const statusEl = document.getElementById("geojsonPathStatus");
  const path = inputEl ? inputEl.value.trim() : "";
  if (!path || !/\.geojson$/i.test(path)) {
    if (statusEl) { statusEl.innerText = "Please enter a valid .geojson file path."; statusEl.style.color = "red"; }
    return;
  }
  fetch(path).then(res => res.json()).then(gj => {
    const nm = (path.split("/").pop() || "segment").replace(/\.geojson$/i, "");
    segmentLayerIdentify(nm, gj);
  }).catch(err => {
    console.error(err);
    if (statusEl) { statusEl.innerText = "Failed to load file."; statusEl.style.color = "red"; }
  });
}
window.loadGeoJSONByPath = loadGeoJSONByPath;

// initial convenience load (won’t error if missing)
(function initialSegmentLoad(){
  fetch("results/segment.geojson").then(r => { if (r.ok) return r.json(); }).then(gj => {
    if (gj) segmentLayerIdentify("Segment_Polygon", gj);
  }).catch(() => {});
})();

// Register a GeoJSON as a "segment" layer
function segmentLayerIdentify(name, geojson, meta) {
  const unique = getUniqueLayerName(name);
  addLayer(unique, geojson, "segment", meta || {});
  const u = document.getElementById("url_input_geojson");
  if (u && u.style) u.style.display = "none";
  const s = document.getElementById("showSamplesTabButton");
  if (s && s.style) s.style.display = "block";
  activeLayerName = unique;
  if (window.refreshSegmentDropdown) window.refreshSegmentDropdown();
}

function addLayer(name, geojson, type, meta) {
  if (layers[name]) name = getUniqueLayerName(name);
  layers[name] = { type, geojson, leafletLayer: null, visible: false, bounds: null, style: { attr: null, map: {} } };
  if (meta && meta.segmentId) layers[name].segmentId = meta.segmentId;

  // Immediately draw (unstyled/default) so it appears
  renderDefaultLayer(name);

  renderLayerList();
}

/* =========================
 * Styling UI (layer-scoped)
 * ========================= */
function openStyleModal(layerName) {
  const rec = layers[layerName];
  if (!rec || rec.type === "raster") return;

  // pause sample picking while styling
  _styleWasPicking = samplePickingEnabled;
  samplePickingEnabled = false;
  _styleModalOpen = true;

  showStyleOptions(layerName); // prepares the inline panel in #styleConfig

  // If you have a modal in HTML, wire it here (fallback is inline panel only):
  const styleModal = document.getElementById("styleModal");
  const styleBackdrop = document.getElementById("styleBackdrop");
  const closeStyleBtn = document.getElementById("closeStyleModalBtn");

  const closeFn = () => {
    if (styleModal) styleModal.classList.add("hidden");
    if (styleBackdrop) styleBackdrop.classList.add("hidden");
    document.body.classList.remove("no-scroll");
    // restore sample picking state
    samplePickingEnabled = _styleWasPicking;
    _styleModalOpen = false;
  };

  if (styleModal) {
    styleModal.classList.remove("hidden");
    if (styleBackdrop) styleBackdrop.classList.remove("hidden");
    document.body.classList.add("no-scroll");

    const escHandler = (e) => { if (e.key === "Escape") { closeFn(); document.removeEventListener("keydown", escHandler); } };
    document.addEventListener("keydown", escHandler);
    if (closeStyleBtn) closeStyleBtn.onclick = closeFn;
    if (styleBackdrop) styleBackdrop.onclick = closeFn;

    const content = styleModal.querySelector(".modal-content");
    if (content) content.addEventListener("click", (e) => e.stopPropagation());
  } else {
    // Inline panel only — nothing else to do; user will close by switching focus
  }
}

function _pickDefaultAttr(geojson) {
  const prefer = ["class", "predicted", "label", "Class", "category", "segment_class"];
  const props = Object.keys(geojson.features[0]?.properties || {});
  for (const p of prefer) if (props.includes(p)) return p;

  // choose the first attribute with <=10 unique values, else fallback to 'segment_id' or the first key
  let fallback = props[0] || null;
  if (props.includes("segment_id")) fallback = "segment_id";

  for (const p of props) {
    const uniq = new Set(geojson.features.map(f => f.properties?.[p]));
    if (uniq.size <= 10) return p;
  }
  return fallback;
}

function showStyleOptions(layerName) {
  const rec = layers[layerName];
  if (!rec || rec.type === "raster" || !rec.geojson) return;

  const geojson = rec.geojson;
  if (!geojson.features || !geojson.features.length) return;

  const attributes = Object.keys(geojson.features[0].properties || {});
  const attrSelect = document.getElementById("attributeSelect");
  const stylePanel = document.getElementById("styleConfig");
  const warning = document.getElementById("styleWarning");
  const styleMappingDiv = document.getElementById("styleMapping");

  const state = ensureStyleState(layerName);

  if (!attrSelect || !styleMappingDiv) return;

  attrSelect.innerHTML = "";
  styleMappingDiv.innerHTML = "";
  if (warning) { warning.style.display = "none"; warning.textContent = ""; }
  if (stylePanel) stylePanel.style.display = "block";

  attributes.forEach(attr => {
    const opt = document.createElement("option");
    const uniqueVals = [...new Set(geojson.features.map(f => f.properties[attr]))];
    opt.value = attr;
    opt.text = `${attr} (${uniqueVals.length})`;
    opt.dataset.count = uniqueVals.length;
    attrSelect.appendChild(opt);
  });

  // choose a good default
  const chosen = state.attr && [...attrSelect.options].some(o => o.value === state.attr)
    ? state.attr
    : _pickDefaultAttr(geojson);

  if (chosen) attrSelect.value = chosen;

  attrSelect.onchange = () => {
    const attr = attrSelect.value;
    state.attr = attr;
    const uniqueVals = [...new Set(geojson.features.map(f => f.properties[attr]))];

    if (uniqueVals.length > 10) {
      if (warning) {
        warning.style.display = "block";
        warning.textContent = "Warning: Too many unique values. Pick a different attribute.";
      }
      const ll = layers[layerName].leafletLayer;
      if (!ll || !map.hasLayer(ll)) renderDefaultLayer(layerName, attr);
      return;
    }
    if (warning) { warning.style.display = "none"; warning.textContent = ""; }
    renderStyleMappingUI(layerName, attr, uniqueVals);
  };

  // Trigger initial render
  attrSelect.dispatchEvent(new Event("change"));
}

function renderStyleMappingUI(layerName, attr, values) {
  const div = document.getElementById("styleMapping");
  const state = ensureStyleState(layerName);
  if (!div) return;
  div.innerHTML = "";

  values.forEach(v => {
    const key = (v != null ? String(v) : "null");
    if (!state.map[key]) {
      state.map[key] = { color: generateRandomColor(), fillColor: generateRandomColor(), weight: 2, opacity: 1, fillOpacity: 0.6 };
    }
    const cfg = state.map[key];
    const row = document.createElement("div");
    row.className = "style-config";
    row.innerHTML =
      `<div class="style-label"><strong>${key}</strong></div>
       <div class="style-controls">
         <label>Color <input type="color" value="${cfg.color}" data-key="${key}" class="color-input" /></label>
         <label>Fill <input type="color" value="${cfg.fillColor}" data-key="${key}" class="fillcolor-input" /></label>
         <label>Opacity <input type="number" value="${cfg.opacity}" step="0.1" min="0" max="1" data-key="${key}" class="opacity-input" /></label>
         <label>Fill Opacity <input type="number" value="${cfg.fillOpacity}" step="0.1" min="0" max="1" data-key="${key}" class="fillopacity-input" /></label>
         <label>Weight <input type="number" value="${cfg.weight}" step="1" min="0" max="10" data-key="${key}" class="weight-input" /></label>
       </div>`;
    div.appendChild(row);
  });

  ["color","fillcolor","weight","opacity","fillopacity"].forEach(type => {
    div.querySelectorAll(`.${type}-input`).forEach(input => {
      input.addEventListener("input", () => {
        const key = input.dataset.key;
        const val = (input.type === "color") ? input.value : parseFloat(input.value);
        const target = state.map[key] || (state.map[key] = {});
        if (type === "color") target.color = val;
        if (type === "fillcolor") target.fillColor = val;
        if (type === "weight") target.weight = val;
        if (type === "opacity") target.opacity = val;
        if (type === "fillopacity") target.fillOpacity = val;
        applyStyledLayer(layerName, attr);
      });
    });
  });

  applyStyledLayer(layerName, attr);
}

function renderDefaultLayer(layerName, attr) {
  addStyledLayer(layerName, attr);
}

/* =========================
 * Make only one GeoJSON layer selectable (for Samples tab)
 * ========================= */
function onEachFeatureFactory(ownerLayerName) {
  return function(feature, layer) {
    layer.on('click', () => {
      showPropertiesInPopup(feature.properties);

      // Never pick while styling
      if (_styleModalOpen) return;

      // Only allow selection if explicitly activated in Samples tab
      if (!(samplePickingEnabled && activeSamplingLayerName === ownerLayerName)) return;

      if (!currentClassKey) { alert("Please select a class first!"); return; }
      const fid = feature.properties.segment_id;
      const alreadyInClass = classData[currentClassKey].includes(fid);

      // remove from all classes
      for (let k in classData) classData[k] = classData[k].filter(id => id !== fid);

      if (!alreadyInClass) {
        classData[currentClassKey].push(fid);
        layer.setStyle({ color: "#3388ff", fillColor: classColors[currentClassKey], fillOpacity: 0.6 });
      } else {
        layer.setStyle({ color: "#3388ff", fillColor: "#3388ff", fillOpacity: 0 });
      }
      updateClassIds();
    });
  };
}

function addStyledLayer(layerName, attr) {
  const rec = layers[layerName]; if (!rec || !rec.geojson) return;

  const state = ensureStyleState(layerName);
  if (attr) state.attr = attr;

  if (rec.leafletLayer && map.hasLayer(rec.leafletLayer)) map.removeLayer(rec.leafletLayer);

  // pick a reasonable default attribute if none chosen yet
  if (!state.attr) state.attr = _pickDefaultAttr(rec.geojson);

  const styleFn = (f) => {
    const v = (f.properties[state.attr] != null ? String(f.properties[state.attr]).trim() : "");
    const s = (state.map && state.map[v]) ? state.map[v] : {};
    return {
      color: s.color || "red",
      fillColor: s.fillColor || "#fff",
      weight: (s.weight != null ? s.weight : 1),
      opacity: (s.opacity != null ? s.opacity : 1),
      fillOpacity: (s.fillOpacity != null ? s.fillOpacity : 0.3)
    };
  };

  const layer = L.geoJSON(rec.geojson, {
    style: styleFn,
    pointToLayer: (f, latlng) => L.circleMarker(latlng, styleFn(f)),
    onEachFeature: onEachFeatureFactory(layerName)
  }).addTo(map);

  rec.leafletLayer = layer; rec.visible = true;

  try {
    const b = layer.getBounds && layer.getBounds();
    if (b && b.isValid && b.isValid()) {
      rec.bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      // fit only on first add
      map.fitBounds(b);
    }
  } catch (e) {}
  const closeBtn = document.getElementById('closeAddLayerModal');
  if (closeBtn) closeBtn.click();
  renderLayerList();
}

function applyStyledLayer(layerName, attr) {
  const rec = layers[layerName]; if (!rec || !rec.leafletLayer) return;
  const state = ensureStyleState(layerName);
  if (attr) state.attr = attr;

  rec.leafletLayer.eachLayer(featureLayer => {
    const v = (featureLayer.feature.properties[state.attr] != null ? String(featureLayer.feature.properties[state.attr]).trim() : "");
    const s = (state.map && state.map[v]) ? state.map[v] : {};
    featureLayer.setStyle({
      color: s.color || "#000",
      fillColor: s.fillColor || "#fff",
      weight: (s.weight != null ? s.weight : 1),
      opacity: (s.opacity != null ? s.opacity : 1),
      fillOpacity: (s.fillOpacity != null ? s.fillOpacity : 0.3)
    });
  });
}

/* =========================
 * Feature properties popup
 * ========================= */
function showPropertiesInPopup(properties) {
  const box = document.getElementById("custom-popup-box");
  if (!box) return;
  const container = box.querySelector(".popup-content");
  box.style.display = "block";
  let html = "<table>";
  for (const key in properties) html += `<tr><td><strong>${key}</strong></td><td>${properties[key]}</td></tr>`;
  html += "</table>";
  if (container) container.innerHTML = html;
}
function closePopup() { const el = document.getElementById("custom-popup-box"); if (el) el.style.display = "none"; }
window.closePopup = closePopup;

/* =========================
 * Class controls (Samples tab)
 * ========================= */
function generateClassControls() {
  const countEl = document.getElementById("classCount");
  const container = document.getElementById("classControls");
  if (!countEl || !container) return;
  const count = parseInt(countEl.value);
  container.innerHTML = "";
  classColors = {}; classData = {};
  for (let i = 1; i <= count; i++) {
    const key = `class_${i}`;
    classColors[key] = generateRandomColor();
    classData[key] = [];
    const div = document.createElement("div");
    div.className = "class-row";
    div.innerHTML =
      `<input type="radio" name="classRadio" value="${key}" ${i === 1 ? "checked" : ""} onchange="currentClassKey='${key}'; updateClassIds();">
       <input type="text" id="label_${key}" value="${key}" placeholder="Class Name" oninput="updateClassIds()">`;
    container.appendChild(div);
  }
  currentClassKey = "class_1";
  legendControl.addTo(map);
  updateClassIds();
}
window.generateClassControls = generateClassControls;

function updateClassIds() {
  const div = document.getElementById("classwiseIds");
  if (!div) return;
  div.innerHTML = "";
  for (let key in classData) {
    const ids = classData[key].slice().sort((a, b) => a - b);
    const labelEl = document.getElementById(`label_${key}`);
    const label = (labelEl && labelEl.value) ? labelEl.value : key;
    const section = document.createElement("div");
    section.className = "class-section";
    section.innerHTML = `<h4>${label}</h4><div class="class-ids">${ids.join(', ') || "(none)"}</div>`;
    div.appendChild(section);
  }
}
window.updateClassIds = updateClassIds;

function resetSelections() {
  if (!segmentLayer) return;
  segmentLayer.eachLayer(layer => {
    const fid = layer.feature.properties.segment_id;
    for (let k in classData) classData[k] = classData[k].filter(id => id !== fid);
    layer.setStyle({ color: "#3388ff", fillColor: "#3388ff", fillOpacity: 0 });
  });
  updateClassIds();
}
window.resetSelections = resetSelections;

function download_class_json() {
  const out = {};
  for (const k of Object.keys(classData)) {
    const labelEl = document.getElementById(`label_${k}`);
    const label = (labelEl && labelEl.value) ? labelEl.value : k;
    out[label] = classData[k].slice();
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "class_samples.json"; a.click();
  URL.revokeObjectURL(url);
}
window.download_class_json = download_class_json;

async function saveSamples() {
  try {
    const segSel = document.getElementById("samplesSegmentSelect");
    const segment_id = (segSel && segSel.value) ? String(segSel.value) : "";
    if (!segment_id) { alert("Select a segment first (Samples tab)."); return; }

    const out = {};
    for (const k of Object.keys(classData || {})) {
      const labelEl = document.getElementById(`label_${k}`);
      const label = (labelEl && labelEl.value && labelEl.value.trim()) ? labelEl.value.trim() : k;
      const ids = Array.isArray(classData[k]) ? classData[k].slice() : [];
      if (!out[label]) out[label] = [];
      ids.forEach(id => out[label].push(id));
    }
    const total = Object.values(out).reduce((n, arr) => n + arr.length, 0);
    if (!total) { alert("No samples selected yet."); return; }

    const resp = await fetch(BACKEND() + "/samples", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segment_id: segment_id, segment_name: segment_id, samples: out })
    });
    if (!resp.ok) throw new Error(await resp.text());

    // mark the matching layer (by known segment id) as “has samples”
    if (window.markLayerHasSamples) window.markLayerHasSamples(segment_id);
    if (window.refreshSegmentDropdown) window.refreshSegmentDropdown();

    const s = document.getElementById("clfStatus");
    if (s) s.append(" Samples saved.");
  } catch (err) {
    console.error("saveSamples failed:", err);
    alert("Saving samples failed: " + (err && err.message ? err.message : err));
  }
}
window.saveSamples = saveSamples;

/* Activate one selectable layer (others deactivated) */
function activateSamplingForSegment(layerName) {
  const rec = layers[layerName];
  if (!rec || rec.type !== "segment") return;

  // Set the only selectable layer
  activeSamplingLayerName = layerName;
  samplePickingEnabled = true;

  // Update segmentLayer pointer for resetSelections, etc.
  if (rec.leafletLayer) {
    segmentLayer = rec.leafletLayer;
    segmentLayerName = layerName;
  }

  // Show the tool UI
  const a = document.getElementById("classificationInfo");
  const b = document.getElementById("classificationTool");
  if (a) a.style.display = "none";
  if (b) b.style.display = "block";

  // Ensure class controls exist
  const container = document.getElementById("classControls");
  if (container && !container.children.length) generateClassControls();
}
window.activateSamplingForSegment = activateSamplingForSegment;

/* Helper for Samples → after save */
window.markLayerHasSamples = function markLayerHasSamples(segmentId) {
  // try to match by segmentId or name substring
  for (const [name, rec] of Object.entries(layers)) {
    if (rec.segmentId === segmentId || name.includes(segmentId)) {
      rec.hasSamples = true;
    }
  }
};

/* =========================
 * Manual tile URL loader (Layers → Add)
 * ========================= */
function loadImage() {
  const inEl = document.getElementById("imagePath");
  const statusEl = document.getElementById("imageLoadStatus");
  const input = inEl ? inEl.value.trim() : "";
  if (!input) {
    if (statusEl) { statusEl.innerText = "Please enter a tile folder URL or TMS URL."; statusEl.style.color = "red"; }
    return;
  }
  const hasZXY = input.includes("{z}") && input.includes("{x}") && (input.includes("{y}") || input.includes("{-y}"));
  let tileUrl = input;
  if (!hasZXY) {
    const endsWithSlash = input.endsWith("/");
    const isLocalhost = input.includes("localhost") || input.includes("127.0.0.1");
    tileUrl = endsWithSlash
      ? input + "{z}/{x}/" + (isLocalhost ? "{-y}" : "{y}") + ".png"
      : input + "/{z}/{x}/" + (isLocalhost ? "{-y}" : "{y}") + ".png";
  }
  const isTMS = tileUrl.includes("{-y}");
  try {
    const tl = L.tileLayer(tileUrl, { minZoom: 0, maxZoom: 22, tms: isTMS, attribution: 'Image Tiles' }).addTo(map);
    const rawName = input || "Raster";
    const safeName = getUniqueLayerName(rawName);
    layers[safeName] = { type: "raster", leafletLayer: tl, visible: true };
    renderLayerList();
    refreshRasterDropdown();
    const closeBtn = document.getElementById('closeAddLayerModal');
    if (closeBtn) closeBtn.click();
    if (statusEl) { statusEl.innerText = "Tile layer loaded from: " + tileUrl; statusEl.style.color = "green"; }
  } catch (err) {
    console.error("Error loading tile layer:", err);
    if (statusEl) { statusEl.innerText = "Failed to load tile layer."; statusEl.style.color = "red"; }
  }
}
window.loadImage = loadImage;

/* =========================
 * Add-Layer modal hooks (from your HTML)
 * ========================= */
const openBtn = document.getElementById('openAddLayerBtn');
const addModal = document.getElementById('addLayerModal');
const closeAddBtn = document.getElementById('closeAddLayerModal');
const addBackdrop = document.getElementById('addLayerBackdrop');
const modalBody = document.getElementById('addLayerModalBody');
const uploadSources = document.querySelector('#uploadSourcesWrapper'); // optional
let moved = false;

function openAddLayerModal() {
  if (!moved && uploadSources && modalBody) { modalBody.appendChild(uploadSources); moved = true; }
  if (addModal) addModal.classList.remove('hidden');
}
function closeAddLayerModal() { if (addModal) addModal.classList.add('hidden'); }

if (openBtn) openBtn.addEventListener('click', openAddLayerModal);
if (closeAddBtn) closeAddLayerModal && closeAddBtn.addEventListener('click', closeAddLayerModal);
if (addBackdrop) addBackdrop.addEventListener('click', closeAddLayerModal);

// Thin loading bar + error
const progressEl = document.getElementById('addLayerProgress');
const errorEl = document.getElementById('addLayerError');
function setAddLayerLoading(isLoading) {
  if (progressEl) progressEl.classList.toggle('hidden', !isLoading);
  if (openBtn) openBtn.disabled = !!isLoading;
}
function setAddLayerError(msg) {
  if (!errorEl) return;
  if (msg) { errorEl.textContent = msg; errorEl.classList.remove('hidden'); }
  else { errorEl.textContent = ''; errorEl.classList.add('hidden'); }
}

/* =========================
 * Load saved GeoJSONs (backend)
 * ========================= */
async function initSavedGeoJSONs() {
  try {
    const r = await fetch(`${BACKEND()}/geojsons`, { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    const items = Array.isArray(data.geojsons) ? data.geojsons
                : Array.isArray(data.items)    ? data.items
                : [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        const rel = (it.url || it.path || "");
        const url = rel.startsWith("http") ? rel : (BACKEND() + (rel.startsWith("/") ? "" : "/") + rel);
        if (!url) continue;
        const base = (it.name || (url.split("/").pop() || "layer")).replace(/\.geojson$/i, "");
        if (layers[base]) continue;
        const gj = await fetch(url, { cache: "no-store" }).then(x => x.json());
        segmentLayerIdentify(base, gj, { segmentId: it.id || base });
      } catch (e) {
        console.warn("Failed loading saved item:", it, e);
      }
    }
    if (window.refreshSegmentDropdown) window.refreshSegmentDropdown();
  } catch (err) {
    console.error("initSavedGeoJSONs error", err);
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSavedGeoJSONs);
} else {
  initSavedGeoJSONs();
}

/* =========================
 * End of file
 * ========================= */

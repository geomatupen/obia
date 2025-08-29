// main.js — UI only (DOM wiring). Calls into map.js.

// ---------- Shared helpers ----------
window.$ = window.$ || function (id) { return document.getElementById(id); };
function BACKEND() { return window.BACKEND_URL || "http://127.0.0.1:8001"; }

// Simple toast notifications (requires <div id="toasts"> in HTML)
(function(){
  function createToast(msg, type, timeout){
    const c = document.getElementById("toasts");
    if(!c) return;
    const t = document.createElement("div");
    t.className = `toast ${type || "success"}`;
    t.innerHTML = `<span class="msg">${msg}</span><button class="close" aria-label="Close">×</button>`;
    c.appendChild(t);
    requestAnimationFrame(()=> t.classList.add("show"));
    const remove = () => { t.classList.remove("show"); setTimeout(()=> t.remove(), 200); };
    t.querySelector(".close").onclick = remove;
    if (timeout !== 0) setTimeout(remove, timeout || (type === "warning" ? 2400 : 1800));
  }
  window.notifySuccess = (msg, ms) => createToast(msg, "success", ms);
  window.notifyWarning = (msg, ms) => createToast(msg, "warning", ms);
})();


// ---------- Add Layer modal (open/close) ----------
(function () {
  const openBtn  = $("openAddLayerBtn");
  const modal    = $("addLayerModal");
  const backdrop = $("addLayerBackdrop") || $("modalBackdrop") || $("backdrop");
  const closeBtn = $("closeAddLayerModal");
  const xBtn     = $("xAddLayerModal");

  function openModal() {
    if (!modal) return;
    modal.classList.remove("hidden");
    backdrop && backdrop.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  }
  function closeModal() {
    if (!modal) return;
    modal.classList.add("hidden");
    backdrop && backdrop.classList.add("hidden");
    document.body.classList.remove("no-scroll");
  }

  if (openBtn) openBtn.onclick = openModal;
  if (closeBtn) closeBtn.onclick = closeModal;
  if (xBtn) xBtn.onclick = closeModal;
  if (backdrop) backdrop.onclick = closeModal;

  window.openAddLayerModal = openModal;
  window.closeAddLayerModal = closeModal;
})();


// ---------- Rasters: list / add ----------
async function listRasters() {
  const r = await fetch(`${BACKEND()}/rasters`, { cache: "no-store" });
  if (!r.ok) return [];
  const data = await r.json();
  return data.rasters || data.items || data || [];
}
async function getRasterStatusOrDirect(item) {
  const id = item.id;
  if (id) {
    const r = await fetch(`${BACKEND()}/rasters/${id}/status`, { cache: "no-store" });
    if (r.ok) {
      const st = await r.json();
      if (st.tile_url) {
        return {
          ok: true,
          tile_url: st.tile_url.startsWith("http") ? st.tile_url : `${BACKEND()}${st.tile_url}`,
          zooms: st.zooms || [],
          bounds: item.bounds || st.bounds || null
        };
      }
    }
  }
  if (item.tile_url) {
    return {
      ok: true,
      tile_url: item.tile_url.startsWith("http") ? item.tile_url : `${BACKEND()}${item.tile_url}`,
      zooms: item.zooms || [],
      bounds: item.bounds || null
    };
  }
  return { ok: false };
}
function refreshRasterDropdown() {
  const sel = $("orthoSelect"); if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";
  const rasters = Object.entries(window.layers).filter(([, r]) => r.type === "raster");
  if (rasters.length === 0) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "— select raster —";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  rasters.forEach(([name, rec]) => {
    const o = document.createElement("option");
    o.value = rec.rasterId || name;
    o.textContent = name;
    sel.appendChild(o);
  });
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : sel.options[0].value;
}
async function loadExistingRasters() {
  const arr = await listRasters();
  for (let i = 0; i < arr.length; i++) {
    const info = arr[i];
    const st = await getRasterStatusOrDirect(info);
    if (!st.ok) continue;
    const minZ = st.zooms.length ? Math.min(...st.zooms) : 0;
    const maxZ = st.zooms.length ? Math.max(...st.zooms) : 22;
    window.addTileLayerXYZ(st.tile_url, minZ, maxZ, info.name || `Raster ${i+1}`, st.bounds || null, i === 0, { id: info.id });
  }
  refreshRasterDropdown();
}
async function loadImage() {
  const inp = $("imagePath");
  const url = inp?.value.trim();
  if (!url) { alert("Enter a TMS URL (e.g. http://server/{z}/{x}/{-y}.png)"); return; }
  window.addTileLayerXYZ(url, 0, 22, "Tiles", null, true, {});
  refreshRasterDropdown();
  notifySuccess("Tile layer added");
  window.closeAddLayerModal && window.closeAddLayerModal();
}
window.loadImage = loadImage;

async function uploadRasterImage(file, name) {
  const fd = new FormData();
  fd.append("file", file);
  const resp = await fetch(`${BACKEND()}/rasters`, { method: "POST", body: fd });
  if (!resp.ok) { notifyWarning("Upload failed"); return; }
  const info = await resp.json(); // {id, name, bounds?}

  // poll for tiling ready
  while (true) {
    const st = await getRasterStatusOrDirect(info);
    if (st.ok) {
      const minZ = st.zooms.length ? Math.min(...st.zooms) : 0;
      const maxZ = st.zooms.length ? Math.max(...st.zooms) : 22;
      window.addTileLayerXYZ(st.tile_url, minZ, maxZ, info.name || name, st.bounds || null, true, { id: info.id });
      notifySuccess("File uploaded & tiled");
      window.closeAddLayerModal && window.closeAddLayerModal();
      refreshRasterDropdown();
      break;
    }
    await new Promise(r => setTimeout(r, 800));
  }
}


// ---------- Drag & Drop ----------
function wireDropZone() {
  const dropZone = $("dropZone");
  if (!dropZone) return;

  dropZone.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".geojson,.json,.tif,.tiff,.png,.jpg,.jpeg";
    input.onchange = e => { if (e.target.files?.length) handleFileUpload(e.target.files[0]); };
    input.click();
  });
  dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault(); dropZone.classList.remove("dragover");
    if (e.dataTransfer.files?.length) handleFileUpload(e.dataTransfer.files[0]);
  });
}
function handleFileUpload(file) {
  const low = file.name.toLowerCase();
  const isGeoJSON = /\.(geojson|json)$/.test(low);
  const isImage = /\.(tif|tiff|png|jpg|jpeg)$/.test(low);

  if (isGeoJSON) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const gj = JSON.parse(e.target.result);
        const nm = file.name.replace(/\.[^/.]+$/, "");
        window.segmentLayerIdentify(nm, gj);
        renderLayerList();
        refreshLegendLayers();
        notifySuccess("GeoJSON added");
      } catch (_) { notifyWarning("Invalid GeoJSON file"); }
    };
    reader.readAsText(file);
  } else if (isImage) {
    uploadRasterImage(file, file.name.replace(/\.[^/.]+$/, ""));
  } else {
    notifyWarning("Unsupported file type");
  }
}


// ---------- Existing server GeoJSONs ----------
async function listServerGeoJSONs() {
  const res = await fetch(`${BACKEND()}/geojsons`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || data || [];
}
async function addServerGeoJSONs() {
  const items = await listServerGeoJSONs();
  for (const it of items) {
    const url = it.url?.startsWith("http") ? it.url : `${BACKEND()}${it.url || ""}`;
    if (!url) continue;
    const gjRes = await fetch(url, { cache: "no-store" });
    if (!gjRes.ok) continue;
    const gj = await gjRes.json();
    const baseName = (it.name || it.id || "GeoJSON").replace(/\.geojson$/i, "");
    const isSeg = !!(gj?.features?.[0]?.properties && "segment_id" in gj.features[0].properties);
    window.addLayer(baseName, gj, isSeg ? "segment" : "viewer", isSeg && it.id ? { segmentId: it.id } : {});
  }
  renderLayerList();
  refreshLegendLayers();
  if (items.length) notifySuccess("Loaded existing GeoJSONs");
}


// ---------- Sampling UI (classes, picking, save) ----------
let classColors = {};
let classData = {};
let currentClassKey = null;
let activeSamplingLayerName = null;

function generateClassControls() {
  const nInput = $("classCount");
  const container = $("classControls");
  if (!container) return;

  const n = parseInt(nInput?.value || "2");
  container.innerHTML = "";
  classColors = {}; classData = {};

  for (let i = 1; i <= n; i++) {
    const key = `class_${i}`;
    classColors[key] = window.randomColor ? window.randomColor() : "#cccccc";
    classData[key] = [];
    const div = document.createElement("div");
    div.className = "class-row";
    div.innerHTML =
      `<input type="radio" name="classRadio" value="${key}" ${i === 1 ? "checked" : ""} onchange="currentClassKey='${key}'; updateClassIds();">
       <input type="text" id="label_${key}" value="${key}" placeholder="Class Name" oninput="updateClassIds()">`;
    container.appendChild(div);
  }
  currentClassKey = "class_1";
  updateClassIds();
}
window.generateClassControls = generateClassControls;

function updateClassIds() {
  const div = $("classwiseIds"); if (!div) return;
  div.innerHTML = "";
  for (const k in classData) {
    const ids = classData[k].slice().sort((a, b) => a - b);
    const labelEl = document.getElementById(`label_${k}`);
    const label = (labelEl && labelEl.value) ? labelEl.value : k;
    const sec = document.createElement("div");
    sec.className = "class-section";
    sec.innerHTML = `<h4>${label}</h4><div class="class-ids">${ids.join(", ") || "(none)"}</div>`;
    div.appendChild(sec);
  }
}
window.updateClassIds = updateClassIds;

function resetSelections() {
  if (!activeSamplingLayerName) return;
  const rec = window.layers[activeSamplingLayerName];
  if (!rec?.leafletLayer) return;
  for (const k in classData) classData[k] = [];
  window.applyStyle(activeSamplingLayerName);
  updateClassIds();
}
window.resetSelections = resetSelections;

// Wrap map's activate to enable picking + tool panel
(function wrapActivateSampling(){
  const _mapActivate = window.activateSamplingForSegment;
  window.activateSamplingForSegment = function(layerName){
    if (typeof _mapActivate === "function") _mapActivate(layerName);
    activeSamplingLayerName = layerName;

    const info = $("classificationInfo");
    const tool = $("classificationTool");
    if (info) info.style.display = "none";
    if (tool) tool.style.display = "block";

    if (!currentClassKey) generateClassControls();

    window._sampling = {
      activeName: layerName,
      handler: (activeName, feat, l) => {
        if (!currentClassKey) { notifyWarning("Select a class first"); return; }
        const fid = feat.properties?.segment_id ?? feat.id ?? null;
        if (fid == null) { notifyWarning("segment_id missing in feature"); return; }

        // remove fid from all classes, then toggle add to current
        for (const k in classData) classData[k] = classData[k].filter(id => id !== fid);
        const arr = classData[currentClassKey];
        const already = arr.includes(fid);
        if (!already) {
          arr.push(fid);
          l.setStyle({ color: "#333333", fillColor: classColors[currentClassKey], fillOpacity: 0.65, weight: 1, opacity: 1 });
        } else {
          window.applyStyle(activeName);
        }
        updateClassIds();
      }
    };
  };
})();

// Save samples to backend
async function saveSamples() {
  // Prefer explicit dropdown if present
  const sel = document.getElementById("samplesSegmentSelect");
  let segment_id = sel?.value || "";

  // Fallbacks: use the active sampling layer's known id or name
  if (!segment_id && activeSamplingLayerName) {
    const rec = window.layers[activeSamplingLayerName];
    segment_id = rec?.segmentId || activeSamplingLayerName;
  }
  if (!segment_id) { notifyWarning("Select a segment first"); return; }

  const payload = {};
  for (const k of Object.keys(classData)) {
    const labelEl = document.getElementById(`label_${k}`);
    const label = (labelEl && labelEl.value && labelEl.value.trim()) ? labelEl.value.trim() : k;
    payload[label] = (classData[k] || []).slice();
  }
  const total = Object.values(payload).reduce((n, a) => n + a.length, 0);
  if (!total) { notifyWarning("No samples selected"); return; }

  const r = await fetch(BACKEND() + "/samples", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segment_id, segment_name: segment_id, samples: payload })
  });
  if (!r.ok) { notifyWarning("Saving samples failed"); return; }

  notifySuccess("Samples saved");
  // let classification UI know (if present)
  if (typeof window.refreshSegmentDropdown === "function") window.refreshSegmentDropdown();
}
window.saveSamples = saveSamples;


// ---------- Legend control (styled layers only) ----------
let legendSelectEl = null;
let legendTitleEl = null;
let legendEntriesEl = null;

const legendCtl = L.control({ position: "bottomright" });
legendCtl.onAdd = function () {
  const div = L.DomUtil.create("div", "legend legend-box");
  div.innerHTML = `
    <div id="legendTitle" class="legend-title" style="margin-bottom:6px;font-weight:600;"></div>
    <div style="margin-bottom:6px;">
      <select id="legendLayerSelect" style="max-width:220px;"></select>
    </div>
    <div id="legendEntries"></div>
  `;
  legendTitleEl = div.querySelector("#legendTitle");
  legendSelectEl = div.querySelector("#legendLayerSelect");
  legendEntriesEl = div.querySelector("#legendEntries");
  if (legendSelectEl) legendSelectEl.onchange = () => renderLegendFor(legendSelectEl.value);
  L.DomEvent.disableClickPropagation(div);
  return div;
};
legendCtl.addTo(window.map);

function styledLayerNames() {
  return Object.entries(window.layers)
    .filter(([, rec]) => rec.type !== "raster" && rec.style && rec.style.attr)
    .map(([name]) => name);
}
function refreshLegendLayers() {
  if (!legendSelectEl) return;
  const names = styledLayerNames();

  const prev = legendSelectEl.value;
  legendSelectEl.innerHTML = "";
  if (names.length === 0) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "No styled layers";
    legendSelectEl.appendChild(o);
    legendSelectEl.disabled = true;
    legendTitleEl && (legendTitleEl.textContent = "");
    legendEntriesEl && (legendEntriesEl.innerHTML = "");
    return;
  }
  legendSelectEl.disabled = false;
  names.forEach(n => {
    const o = document.createElement("option");
    o.value = n; o.textContent = n;
    legendSelectEl.appendChild(o);
  });
  const sel = names.includes(prev) ? prev : names[0];
  legendSelectEl.value = sel;
  renderLegendFor(sel);
}
window.refreshLegendLayers = refreshLegendLayers;

function renderLegendFor(layerName) {
  const rec = window.layers[layerName];
  if (!legendEntriesEl || !rec?.style?.attr) {
    if (legendTitleEl) legendTitleEl.textContent = "";
    if (legendEntriesEl) legendEntriesEl.innerHTML = "";
    return;
  }
  legendTitleEl.textContent = layerName;
  const entries = rec.style.map || {};
  const keys = Object.keys(entries);
  if (keys.length === 0) { legendEntriesEl.innerHTML = "<em>No categories</em>"; return; }

  let html = "";
  keys.forEach(k => {
    const cfg = entries[k] || {};
    const color = cfg.fillColor || "#cccccc";
    const label = (k === "null") ? "(null)" : k;
    html += `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">
      <span style="display:inline-block;width:14px;height:14px;border:1px solid #333;background:${color};"></span>
      <span>${label}</span>
    </div>`;
  });
  legendEntriesEl.innerHTML = html;
}

// Auto-refresh legend when layers are added or styles applied
(function wrapLegendHooks(){
  const _addLayer = window.addLayer;
  window.addLayer = function(name, gj, type, meta) {
    const nm = _addLayer(name, gj, type, meta);
    setTimeout(refreshLegendLayers, 0);
    return nm;
  };
  const _applyStyle = window.applyStyle;
  window.applyStyle = function(name) {
    _applyStyle(name);
    setTimeout(() => {
      refreshLegendLayers();
      if (legendSelectEl && legendSelectEl.value === name) renderLegendFor(name);
    }, 0);
  };
})();


// ---------- Style modal (UI) ----------
function openStyleModal(layerName) {
  const rec = window.layers[layerName];
  if (!rec || !rec.geojson) return;

  const panel  = $("styleConfig");
  const attrEl = $("attributeSelect");
  const mapDiv = $("styleMapping");
  const warn   = $("styleWarning");
  if (!panel || !attrEl || !mapDiv) return;

  panel.style.display = "block";
  attrEl.innerHTML = ""; mapDiv.innerHTML = ""; if (warn){ warn.style.display="none"; warn.textContent=""; }

  const attrs = Object.keys(rec.geojson.features?.[0]?.properties || {});
  attrs.forEach(a => {
    const o = document.createElement("option");
    const uniq = [...new Set(rec.geojson.features.map(f => f.properties[a]))].length;
    o.value = a; o.text = `${a} (${uniq})`;
    attrEl.appendChild(o);
  });

  if (!rec.style) rec.style = { attr: null, map: {} };
  if (!rec.style.attr || !attrs.includes(rec.style.attr)) {
    rec.style.attr = (window.defaultAttr ? window.defaultAttr(rec.geojson) : null);
  }
  if (rec.style.attr && attrs.includes(rec.style.attr)) attrEl.value = rec.style.attr;

  function renderMapping() {
    const st = rec.style;
    st.attr = attrEl.value || null;

    if (!st.attr) {
      mapDiv.innerHTML = "";
      window.applyStyle(layerName);
      return;
    }

    const values = [...new Set(rec.geojson.features.map(f => f.properties[st.attr]))];
    if (values.length >= 10) {
      if (warn){ warn.style.display = "block"; warn.textContent = "Too many unique values (≥10). Select another attribute."; }
      notifyWarning("Attribute has too many unique values");
      st.attr = null;
      mapDiv.innerHTML = "";
      window.applyStyle(layerName);
      return;
    }

    if (warn) warn.style.display = "none";
    if (!st.map) st.map = {};
    values.forEach(v => {
      const key = v != null ? String(v) : "null";
      if (!st.map[key]) {
        st.map[key] = { color:"#333333", fillColor: window.randomColor ? window.randomColor() : "#cccccc", weight:1, opacity:1, fillOpacity:0.45 };
      }
    });

    mapDiv.innerHTML = "";
    values.forEach(v => {
      const key = v != null ? String(v) : "null";
      const cfg = st.map[key];
      const row = document.createElement("div");
      row.className = "style-config";
      row.innerHTML = `
        <div class="style-label"><strong>${key}</strong></div>
        <div class="style-controls">
          <label>Color <input type="color" value="${cfg.color}" data-k="${key}" class="st-color"></label>
          <label>Fill <input type="color" value="${cfg.fillColor}" data-k="${key}" class="st-fill"></label>
          <label>Opacity <input type="number" value="${cfg.opacity}" step="0.1" min="0" max="1" data-k="${key}" class="st-op"></label>
          <label>Fill Opacity <input type="number" value="${cfg.fillOpacity}" step="0.1" min="0" max="1" data-k="${key}" class="st-fop"></label>
          <label>Weight <input type="number" value="${cfg.weight}" step="1" min="0" max="10" data-k="${key}" class="st-w"></label>
        </div>`;
      mapDiv.appendChild(row);
    });

    mapDiv.querySelectorAll(".st-color,.st-fill,.st-op,.st-fop,.st-w").forEach(inp => {
      inp.oninput = () => {
        const k = inp.dataset.k;
        const cfg = st.map[k];
        if (inp.classList.contains("st-color")) cfg.color = inp.value;
        else if (inp.classList.contains("st-fill")) cfg.fillColor = inp.value;
        else if (inp.classList.contains("st-op")) cfg.opacity = parseFloat(inp.value);
        else if (inp.classList.contains("st-fop")) cfg.fillOpacity = parseFloat(inp.value);
        else if (inp.classList.contains("st-w")) cfg.weight = parseFloat(inp.value);
        window.applyStyle(layerName);
      };
    });

    window.applyStyle(layerName);
  }

  attrEl.onchange = renderMapping;
  renderMapping();

  const modal = $("styleModal");
  const backdrop = $("styleBackdrop");
  const closeBtn = $("closeStyleModalBtn");
  const close = () => { modal?.classList.add("hidden"); backdrop?.classList.add("hidden"); document.body.classList.remove("no-scroll"); };
  if (modal) {
    modal.classList.remove("hidden");
    backdrop && backdrop.classList.remove("hidden");
    document.body.classList.add("no-scroll");
    closeBtn && (closeBtn.onclick = close);
    backdrop && (backdrop.onclick = close);
  }
}
window.openStyleModal = openStyleModal;


// ---------- Layer list UI ----------
function renderLayerList() {
  const list = $("layerList"); if (!list) return;
  list.innerHTML = "";
  const h = document.createElement("h4"); h.textContent = "Layers"; list.appendChild(h);

  Object.entries(window.layers).forEach(([name, rec]) => {
    const row = document.createElement("div"); row.className = "layer-row";

    const cb = document.createElement("input"); cb.type = "checkbox"; cb.className = "layer-checkbox";
    cb.checked = rec.visible !== false;
    cb.onchange = () => {
      if (!rec.leafletLayer) return;
      if (cb.checked) { rec.leafletLayer.addTo(window.map); rec.visible = true; }
      else { rec.leafletLayer.remove(); rec.visible = false; }
    };

    const label = document.createElement("span"); label.className = "layer-name"; label.textContent = name;

    const actions = document.createElement("div"); actions.className = "layer-actions";
    const menu = document.createElement("div"); menu.className = "layer-menu hidden";

    if (rec.type !== "raster" && rec.geojson) {
      const styleBtn = document.createElement("button");
      styleBtn.className = "layer-menu-item"; styleBtn.textContent = "Style";
      styleBtn.onclick = (e) => { e.stopPropagation(); menu.classList.add("hidden"); openStyleModal(name); };
      menu.appendChild(styleBtn);
    }

    const zoomBtn = document.createElement("button");
    zoomBtn.className = "layer-menu-item"; zoomBtn.textContent = "Zoom to layer";
    zoomBtn.onclick = (e) => {
      e.stopPropagation(); menu.classList.add("hidden");
      if (rec.bounds?.length === 4) window.map.fitBounds([[rec.bounds[1], rec.bounds[0]], [rec.bounds[3], rec.bounds[2]]]);
      else if (rec.leafletLayer?.getBounds) { const b = rec.leafletLayer.getBounds(); if (b?.isValid?.()) window.map.fitBounds(b); }
    };
    menu.appendChild(zoomBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "layer-menu-item"; delBtn.textContent = "Delete";
    delBtn.onclick = (e) => {
      e.stopPropagation(); menu.classList.add("hidden");
      if (rec.leafletLayer) { try { rec.leafletLayer.remove(); } catch (_) {} }
      delete window.layers[name];
      renderLayerList();
      refreshRasterDropdown();
      refreshLegendLayers();
    };
    menu.appendChild(delBtn);

    const kebab = document.createElement("button");
    kebab.className = "layer-kebab"; kebab.innerHTML = "⋮";
    kebab.onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
    document.addEventListener("click", () => menu.classList.add("hidden"));

    const left = document.createElement("div"); left.className = "layer-left";
    left.appendChild(cb); left.appendChild(label);

    actions.appendChild(kebab); actions.appendChild(menu);
    row.appendChild(left); row.appendChild(actions);
    list.appendChild(row);
  });
}


// ---------- Boot ----------
document.addEventListener("DOMContentLoaded", async () => {
  renderLayerList();
  wireDropZone();

  await loadExistingRasters();
  await addServerGeoJSONs();

  refreshRasterDropdown();
  refreshLegendLayers();
  generateClassControls();
});

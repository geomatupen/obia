/* main.js — all-in-one, simple, no window. */

// --------- tiny helpers ---------
function BACKEND() { return typeof BACKEND_URL === "string" ? BACKEND_URL : "http://127.0.0.1:8001"; }
function byId(id) { return document.getElementById(id); }
function randColor() { return "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0"); }

// toasts
(function () {
  function toast(msg, type, timeout) {
    const c = byId("toasts"); if (!c) return;
    const t = document.createElement("div");
    t.className = `toast ${type || "success"}`;
    t.innerHTML = `<span class="msg">${msg}</span><button class="close" aria-label="Close">×</button>`;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    const remove = () => { t.classList.remove("show"); setTimeout(() => t.remove(), 180); };
    t.querySelector(".close").onclick = remove;
    if (timeout !== 0) setTimeout(remove, timeout || (type === "warning" ? 2600 : 1800));
  }
  notifySuccess = (m, ms) => toast(m, "success", ms);
  notifyWarning = (m, ms) => toast(m, "warning", ms);
})();

// --------- map + layers ----------
var map;
var layers = {}; // name -> {type, leafletLayer, geojson?, bounds?, visible, rasterId?, style?, segmentId?}
var activeSamplingLayerName = null;

// init Leaflet
function initMap() {
  map = L.map("map").setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20, attribution: "© OSM" }).addTo(map);
}

// compute bounds for GeoJSON
function boundsOfGeoJSON(gj) {
  const temp = L.geoJSON(gj);
  const b = temp.getBounds();
  temp.remove();
  return b && b.isValid() ? b : null;
}

// add XYZ tile layer
function addTileLayerXYZ(url, minZ, maxZ, name, bounds, fit, opts) {
  const lyr = L.tileLayer(url, { minZoom: minZ || 0, maxZoom: maxZ || 22 });
  lyr.addTo(map);
  const rec = { type: "raster", leafletLayer: lyr, bounds: null, visible: true, rasterId: opts && opts.id };
  if (bounds && bounds.length === 4) {
    rec.bounds = L.latLngBounds([bounds[1], bounds[0]], [bounds[3], bounds[2]]);
  } else if (lyr.getBounds) {
    const b = lyr.getBounds(); if (b && b.isValid && b.isValid()) rec.bounds = b;
  }
  layers[name] = rec;
  if (fit && rec.bounds) map.fitBounds(rec.bounds);
  renderLayerList(); refreshRasterDropdown();
  return lyr;
}

// style for plain features
function baseStyle(rec, feat) {
  const def = { color: "#333", weight: 1, opacity: 1, fillOpacity: 0.2 };
  if (!rec || !rec.style) return def;
  if (rec.style.kind === "categorical") {
    const key = rec.style.by;
    const val = feat && feat.properties ? String(feat.properties[key]) : undefined;
    const color = key && rec.style.categories ? rec.style.categories[String(val)] : null;
    if (color) return { color: "#222", weight: 1, opacity: 1, fillOpacity: 0.5, fillColor: color };
  }
  return def;
}

// add GeoJSON layer
function addLayer(name, geojson, type, opts) {
  const existing = layers[name];
  if (existing && existing.leafletLayer) {
    existing.leafletLayer.remove();
  }
  const rec = { type: type || "viewer", geojson, style: null, segmentId: opts && opts.segmentId, visible: true };
  const layer = L.geoJSON(geojson, {
    style: (f) => baseStyle(rec, f)
  });
  layer.addTo(map);
  rec.leafletLayer = layer;
  const b = layer.getBounds(); if (b && b.isValid()) rec.bounds = b;
  layers[name] = rec;
   if(name.toLowerCase().includes("classify_")){
      layers[name].style = { kind: "categorical", attr: null, map: {} };
      renderStyle(name);
    }
  renderLayerList(); refreshLegendLayers();
  return layer;
}

// apply categorical style
function applyCategoricalStyle(name, key, colors) {
  const rec = layers[name]; if (!rec || !rec.leafletLayer) return;
  rec.style = { kind: "categorical", by: key, categories: colors || {} };
  rec.leafletLayer.setStyle((f) => baseStyle(rec, f));
  refreshLegendLayers();
}

// activate sampling
function activateSamplingForSegment(name) {
  if (!layers[name]) return;
  activeSamplingLayerName = name;
  const info = byId("classificationInfo");
  const tool = byId("classificationTool");
  if (info) info.style.display = "none";
  if (tool) tool.style.display = "block";
}

// helper wrapper
function segmentLayerIdentify(layerName, gj) {
  addLayer(layerName, gj, "segment", { segmentId: layerName });
}

// --------- legend ----------
var legendSelectEl, legendTitleEl, legendEntriesEl;
const legendCtl = L.control({ position: "bottomright" });
legendCtl.onAdd = function () {
  const div = L.DomUtil.create("div", "legend legend-box");
  div.innerHTML = `
    <div id="legendTitle" class="legend-title" style="margin-bottom:6px;font-weight:600;"></div>
    <div style="margin-bottom:6px;"><select id="legendLayerSelect" style="max-width:220px;"></select></div>
    <div id="legendEntries"></div>
  `;
  legendTitleEl = div.querySelector("#legendTitle");
  legendSelectEl = div.querySelector("#legendLayerSelect");
  legendEntriesEl = div.querySelector("#legendEntries");
  legendSelectEl.onchange = function(){ renderLegendFor(legendSelectEl.value); };
  L.DomEvent.disableClickPropagation(div);
  return div;
};
function styledLayerNames() {
  console.log(Object.entries(layers))
  return Object.entries(layers).filter(([, r]) => r.type !== "raster" && r.style && (r.style.kind === "categorical"  || r.style.kind === "custommap")).map(([n]) => n);
}
function refreshLegendLayers() {
  console.log(legendSelectEl)
  if (!legendSelectEl) return;
  const names = styledLayerNames();
  console.log(names)
  legendSelectEl.innerHTML = "";
  if (!names.length) {
    console.log("inside")
    legendTitleEl.textContent = ""; 
    legendEntriesEl.innerHTML = "";
    const o = document.createElement("option"); o.value = ""; o.textContent = "— no styled layers —";
    legendSelectEl.appendChild(o); return;
  }
  names.forEach(n => { const o = document.createElement("option"); o.value = n; o.textContent = n; legendSelectEl.appendChild(o); });
  legendSelectEl.value = names[0]; 
  renderLegendFor(names[0]);
}

function renderLegendFor(name) {
 
  const rec = layers[name];
   console.log("inside renderlegendfor"+rec.style.kind)
  // legendTitleEl.textContent = name || "";
  legendEntriesEl.innerHTML = "";
  if (!rec || !rec.style || (rec.style.kind !== "categorical" && rec.style.kind !== "custommap")) return;
  console.log("not returned")
  const ul = document.createElement("ul"); ul.className = "legend-list";
  Object.entries(rec.style.categories || {}).forEach(([val, color]) => {
    console.log(color)
    const li = document.createElement("li"); li.className = "legend-item";
    li.innerHTML = `<span class="legend-color" style="background:${color}"></span><span class="label">${val}</span>`;
    ul.appendChild(li);
  });
  legendEntriesEl.appendChild(ul);
}


function showConfirmDialog() {
  confirmModal = document.getElementById("confirmModal");
  confirmModal.classList.remove('hidden');
  confirmBackdrop.classList.remove('hidden');
}

function hideConfirmDialog() {
  confirmModal = document.getElementById("confirmModal");
  confirmModal.classList.add('hidden');
  confirmBackdrop.classList.add('hidden');
}

function confirmBool() {
  showConfirmDialog();
  return new Promise((resolve) => {
    function done(val){ hideConfirmDialog(); document.removeEventListener('click', onClick, true); resolve(val); }
    function onClick(e){ const id=e.target.id; if(id==='confirmYesBtn') done(true); if(id==='confirmNoBtn'||id==='confirmBackdrop') done(false); }
    document.addEventListener('click', onClick, true);
  });
}


// delete files from backend
async function deleteServerFile(filename) {
  const confirm = await confirmBool();
  if(confirm){
    const res = await fetch(BACKEND()+"/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // keep your JSON
      body: JSON.stringify({ name: filename })
    });

    if (res.ok) {
      const out = await res.json();
      // run follow-up code here (e.g., remove layer, refresh list)
      
      notifySuccess("Deleted: " + (out.removed || []).join(", "));

      const rec = layers[filename];
      if (rec && rec.leafletLayer) {
        try { rec.leafletLayer.remove(); } catch (_) {}
      }
      delete layers[filename];

      renderLayerList();       // this refreshes the side panel
      refreshRasterDropdown(); // keep your dropdowns synced
      refreshLegendLayers(); 
      return true;
    } else {
      const err = await res.json().catch(() => null);
      notifyWarning(err?.error || "Delete failed");
      return false;
    }
  }
  
}




// --------- layer list panel ----------
function renderLayerList() {
  console.log("renderLayerList")
  const list = byId("layerList"); if (!list) return;
  list.innerHTML = "";
  const h = document.createElement("h4"); h.textContent = "Layers"; list.appendChild(h);

  Object.entries(layers).forEach(([name, rec]) => {
    const row = document.createElement("div"); row.className = "layer-row";

    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.className = "layer-checkbox"; cb.checked = rec.visible !== false;
    cb.onchange = function () {
      if (!rec.leafletLayer) return;
      if (cb.checked) { rec.leafletLayer.addTo(map); rec.visible = true; }
      else { rec.leafletLayer.remove(); rec.visible = false; }
    };

    const label = document.createElement("span"); label.className = "layer-name"; label.textContent = name;

    const actions = document.createElement("div"); actions.className = "layer-actions";
    const menu = document.createElement("div"); menu.className = "layer-menu hidden";

    if (rec.type !== "raster" && rec.geojson) {
      const styleBtn = document.createElement("button");
      styleBtn.className = "layer-menu-item"; styleBtn.textContent = "Style";
      styleBtn.onclick = function (e) { e.stopPropagation(); menu.classList.add("hidden"); openStyleModal(name); };
      menu.appendChild(styleBtn);
    }

    const zoomBtn = document.createElement("button");
    zoomBtn.className = "layer-menu-item"; zoomBtn.textContent = "Zoom to layer";
    zoomBtn.onclick = function (e) {
      e.stopPropagation(); menu.classList.add("hidden");
      if (rec.bounds) map.fitBounds(rec.bounds);
      else if (rec.leafletLayer && rec.leafletLayer.getBounds) {
        const b = rec.leafletLayer.getBounds(); if (b && b.isValid && b.isValid()) map.fitBounds(b);
      }
    };
    menu.appendChild(zoomBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "layer-menu-item"; delBtn.textContent = "Delete";
    delBtn.onclick = function (e) {
      console.log(name)
      var deleted = deleteServerFile(name);
      console.log(deleted);
      if(deleted == true){
        e.stopPropagation(); menu.classList.add("hidden");
        if (rec.leafletLayer) { try { rec.leafletLayer.remove(); } catch(_){} }
        delete layers[name];
        renderLayerList(); 
        refreshRasterDropdown(); 
        refreshLegendLayers();
      }
    };
    menu.appendChild(delBtn);

    const menuBtn = document.createElement("button");
    menuBtn.className = "layer-menu-btn"; menuBtn.textContent = "⋮";
    menuBtn.onclick = function (e) {
      e.stopPropagation();
      const open = !menu.classList.contains("hidden");
      document.querySelectorAll(".layer-menu").forEach(m => m.classList.add("hidden"));
      if (!open) menu.classList.remove("hidden");
    };

    actions.appendChild(menuBtn);
    actions.appendChild(menu);
    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(actions);
    list.appendChild(row);
  });

  refreshSamplesSegmentSelectFromServer();
  // refreshClassificationDropdown();
}

// --------- upload modal (optional) ----------
(function () {
  const openBtn = byId("openAddLayerBtn");
  const modal = byId("addLayerModal");
  const backdrop = byId("addLayerBackdrop") || byId("modalBackdrop") || byId("backdrop");
  const closeBtn = byId("closeAddLayerModal");
  const xBtn = byId("xAddLayerModal");

  function openModal() { if (!modal) return; modal.classList.remove("hidden"); backdrop && backdrop.classList.remove("hidden"); document.body.classList.add("no-scroll"); }
  function closeModal() { if (!modal) return; modal.classList.add("hidden"); backdrop && backdrop.classList.add("hidden"); document.body.classList.remove("no-scroll"); }

  if (openBtn) openBtn.onclick = openModal;
  if (closeBtn) closeBtn.onclick = closeModal;
  if (xBtn) xBtn.onclick = closeModal;
  if (backdrop) backdrop.onclick = closeModal;

  openAddLayerModal = openModal;
  closeAddLayerModal = closeModal;
})();

// --------- rasters: list, add, upload ----------
async function listRasters() {
  const r = await fetch(BACKEND() + "/rasters", { cache: "no-store" });
  if (!r.ok) return [];
  const data = await r.json();
  return data.rasters || data.items || [];
}
async function rasterStatusOrDirect(item) {
  if (item && item.id) {
    const r = await fetch(BACKEND() + "/rasters/" + item.id + "/status", { cache: "no-store" });
    if (r.ok) {
      const st = await r.json();
      if (st.tile_url) {
        return {
          ok: true,
          tile_url: st.tile_url.startsWith("http") ? st.tile_url : BACKEND() + st.tile_url,
          zooms: st.zooms || [],
          bounds: item.bounds || st.bounds || null
        };
      }
    }
  }
  if (item && item.tile_url) {
    return { ok: true, tile_url: item.tile_url.startsWith("http") ? item.tile_url : BACKEND() + item.tile_url, zooms: item.zooms || [], bounds: item.bounds || null };
  }
  return { ok: false };
}
function refreshRasterDropdown() {
  const sel = byId("orthoSelect"); if (!sel) return;
  const prev = sel.value; sel.innerHTML = "";
  const rasters = Object.entries(layers).filter(([, r]) => r.type === "raster");
  if (!rasters.length) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "— select raster —";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  rasters.forEach(([name, rec]) => {
    const o = document.createElement("option");
    o.value = rec.rasterId || name; o.textContent = name; sel.appendChild(o);
  });
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : sel.options[0].value;
  sel.onchange = zoomToCurrentRaster;
}
async function loadExistingRasters() {
  const arr = await listRasters();
  for (let i = 0; i < arr.length; i++) {
    const info = arr[i];
    const st = await rasterStatusOrDirect(info);
    if (!st.ok) continue;
    const minZ = st.zooms.length ? Math.min(...st.zooms) : 0;
    const maxZ = st.zooms.length ? Math.max(...st.zooms) : 22;
    addTileLayerXYZ(st.tile_url, minZ, maxZ, info.name || `Raster ${i+1}`, st.bounds || null, i === 0, { id: info.id });
  }
  refreshRasterDropdown();
}
async function uploadRasterImage(file, name) {
  const fd = new FormData();
  fd.append("file", file);
  const resp = await fetch(BACKEND() + "/rasters", { method: "POST", body: fd });
  if (!resp.ok) { notifyWarning("Upload failed"); return; }
  const info = await resp.json();
  while (true) {
    const st = await rasterStatusOrDirect(info);
    if (st.ok) {
      const minZ = st.zooms.length ? Math.min(...st.zooms) : 0;
      const maxZ = st.zooms.length ? Math.max(...st.zooms) : 22;
      addTileLayerXYZ(st.tile_url, minZ, maxZ, info.name || name, st.bounds || null, true, { id: info.id });
      notifySuccess("File uploaded");
      if (typeof closeAddLayerModal === "function") closeAddLayerModal();
      refreshRasterDropdown();
      break;
    }
    await new Promise(r => setTimeout(r, 800));
  }
}

// ---------- Drag & Drop ----------
function wireDropZone() {
  const dropZone = document.getElementById("dropZone");
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




// --------- load server geojsons (optional) ----------
async function listServerGeoJSONs() {
  const r = await fetch(BACKEND() + "/geojsons", { cache: "no-store" });
  if (!r.ok) return [];
  const data = await r.json();
  return data.items || [];
}
async function addServerGeoJSONs() {
  const items = await listServerGeoJSONs();
  for (const it of items) {
    const url = it.url && it.url.startsWith("http") ? it.url : (BACKEND() + (it.url || ""));
    if (!url) continue;
    const rr = await fetch(url, { cache: "no-store" }); if (!rr.ok) continue;
    const gj = await rr.json();
    const base = (it.name || it.id || "GeoJSON").replace(/\.geojson$/i, "");
    const isSeg = !!(gj && gj.features && gj.features[0] && gj.features[0].properties && ("segment_id" in gj.features[0].properties));
    addLayer(base, gj, isSeg ? "segment" : "viewer", isSeg && it.id ? { segmentId: it.id } : {});
   
  }
  
  renderLayerList(); refreshLegendLayers();
  if (items.length) notifySuccess("Loaded existing GeoJSONs");
}

// --------- segmentation ----------
function setSegStatus(msg) { const s = byId("segStatus"); if (s) s.textContent = msg || ""; }

async function runSegmentation() {
  const rasterSel = byId("orthoSelect");
  const raster_id = rasterSel && rasterSel.value ? rasterSel.value : "";
  const scale = parseFloat((byId("segScale") && byId("segScale").value) || "30");
  const compactness = parseFloat((byId("segCompactness") && byId("segCompactness").value) || "0.3");

  if (!raster_id) { alert("Please select an image layer first."); return; }

  setSegStatus("Running segmentation…");

  const fd = new FormData();
  fd.append("raster_id", raster_id);
  fd.append("scale", String(scale));
  fd.append("compactness", String(compactness));

  const resp = await fetch(BACKEND() + "/segment", { method: "POST", body: fd });
  if (!resp.ok) { setSegStatus("Segmentation failed"); alert("Segmentation failed"); return; }
  const data = await resp.json();

  let geo = null;
  if (data.geojson) geo = data.geojson;
  else if (data.geojson_url) {
    const url = data.geojson_url.startsWith("http") ? data.geojson_url : BACKEND() + data.geojson_url;
    const r = await fetch(url, { cache: "no-store" }); if (r.ok) geo = await r.json();
  }
  if (!geo) { setSegStatus("Segmentation failed"); alert("No result"); return; }

  const segId = data.id || ((data.geojson_url || "").split("/").pop() || "").replace(/\.geojson$/i, "");
  const layerName = segId || Math.random().toString(36).slice(2, 8);

  segmentLayerIdentify(layerName, geo);
  setSegStatus("Segmentation done.");

  // refresh dropdowns
  refreshSamplesSegmentSelectFromServer();
  // refreshClassificationDropdown();
}

// --------- samples picking ----------
var classColors = {};
var classData = {};
var currentClassKey = null;

function generateClassControls() {
  const nInput = byId("classCount");
  const cont = byId("classControls");
  if (!nInput || !cont) return;
  const n = Math.max(2, Math.min(10, parseInt(nInput.value || "5", 10) || 5));

  classColors = {};
  classData = {};
  currentClassKey = null;
  cont.innerHTML = "";

  for (let i = 1; i <= n; i++) {
    const key = "C" + i;
    classColors[key] = randColor();
    classData[key] = [];
    const row = document.createElement("div");
    row.className = "class-row";
    row.innerHTML = `
      <input id="label_${key}" class="class-label" placeholder="Class ${i}">
      <button id="pick_${key}" class="pick-btn">Pick</button>
      <span id="count_${key}" class="pick-count">0</span>
      <button id="clear_${key}" class="clear-btn">Clear</button>
    `;
    cont.appendChild(row);
  }

  Object.keys(classColors).forEach(k => {
    const pickBtn = byId("pick_" + k);
    const clearBtn = byId("clear_" + k);
    const countEl = byId("count_" + k);

    pickBtn.onclick = function () {
      currentClassKey = k;
      const info = byId("classificationInfo");
      const tool = byId("classificationTool");
      if (info) info.style.display = "none";
      if (tool) tool.style.display = "block";
      document.querySelectorAll(".pick-btn").forEach(b => b.classList.remove("active"));
      pickBtn.classList.add("active");
    };

    clearBtn.onclick = function () { clearClass(k, countEl); };
  });
}
function clearClass(k, countEl) {
  const ids = (classData[k] || []).slice();
  if (activeSamplingLayerName && ids.length) {
    const rec = layers[activeSamplingLayerName];
    if (rec && rec.leafletLayer) {
      rec.leafletLayer.eachLayer(function (lyr) {
        const fid = (lyr.feature && lyr.feature.properties && lyr.feature.properties.segment_id) || lyr._leaflet_id;
        if (ids.includes(fid)) {
          const style = baseStyle(rec, lyr.feature);
          if (lyr.setStyle) lyr.setStyle(style);
        }
      });
    }
  }
  classData[k] = [];
  if (countEl) countEl.textContent = "0";
  updateClassIds();
}
function resetAllSamples() {
  Object.keys(classData).forEach(k => clearClass(k, byId("count_" + k)));
  if (activeSamplingLayerName) {
    const rec = layers[activeSamplingLayerName];
    if (rec && rec.leafletLayer) {
      rec.leafletLayer.eachLayer(function (lyr) { const style = baseStyle(rec, lyr.feature); if (lyr.setStyle) lyr.setStyle(style); });
    }
  }
  currentClassKey = null;
  const info = byId("classificationInfo");
  const tool = byId("classificationTool");
  if (info) info.style.display = "block";
  if (tool) tool.style.display = "none";
  generateClassControls();
}
function updateClassIds() {
  Object.keys(classData).forEach(k => {
    const el = byId("count_" + k);
    if (el) el.textContent = String((classData[k] || []).length);
  });
}

// map click → pick
function bindMapPicking() {
  if (!map) return;
  map.on("click", function (e) {
    if (!currentClassKey || !activeSamplingLayerName) return;
    const rec = layers[activeSamplingLayerName];
    if (!rec || !rec.leafletLayer || !rec.geojson) return;

    let nearest = null, nearestDist = Infinity, nearestFid = null;
    rec.leafletLayer.eachLayer(function (layer) {
      if (!layer.getBounds) return;
      const bounds = layer.getBounds();
      if (!bounds || !bounds.contains(e.latlng)) return;
      const c = bounds.getCenter();
      const d = Math.hypot(c.lat - e.latlng.lat, c.lng - e.latlng.lng);
      const fid = (layer.feature && layer.feature.properties && layer.feature.properties.segment_id) || layer._leaflet_id;
      if (d < nearestDist) { nearestDist = d; nearest = layer; nearestFid = fid; }
    });

    if (nearest && nearestFid != null) {
      // unique across classes
      Object.keys(classData).forEach(k => {
        if (k === currentClassKey) return;
        const arr = classData[k]; const ix = arr.indexOf(nearestFid);
        if (ix !== -1) arr.splice(ix, 1);
      });

      const ids = classData[currentClassKey] || (classData[currentClassKey] = []);
      const idx = ids.indexOf(nearestFid);
      if (idx === -1) {
        ids.push(nearestFid);
        nearest.setStyle({ color: "#111", fillColor: classColors[currentClassKey] || "#ff0000", fillOpacity: 0.65, weight: 1, opacity: 1 });
      } else {
        ids.splice(idx, 1);
        const style = baseStyle(rec, nearest.feature);
        nearest.setStyle(style);
      }
      updateClassIds();
    }
  });
}

// save samples
async function saveSamples() {
  const sel = byId("samplesSegmentSelect");
  let segment_id = sel && sel.value ? sel.value : "";
  if (!segment_id && activeSamplingLayerName) {
    const rec = layers[activeSamplingLayerName]; segment_id = (rec && rec.segmentId) || activeSamplingLayerName;
  }
  if (!segment_id) { notifyWarning("Select a segment first"); return; }

  const payload = {};
  Object.keys(classData).forEach(k => {
    const labelEl = byId("label_" + k);
    const label = (labelEl && labelEl.value && labelEl.value.trim()) ? labelEl.value.trim() : k;
    payload[label] = (classData[k] || []).slice();
  });
  const total = Object.values(payload).reduce((n, a) => n + a.length, 0);
  if (!total) { notifyWarning("No samples selected"); return; }

  const r = await fetch(BACKEND() + "/samples", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segment_id, segment_name: segment_id, samples: payload })
  });
  if (!r.ok) { notifyWarning("Saving samples failed"); return; }
  notifySuccess("Samples saved");
  refreshClassificationDropdown();
}

// --------- segments dropdowns + zoom helper ----------
function zoomToCurrentRaster() {
  const sel = byId("orthoSelect");
  let rec = null;

  if (sel && sel.value) {
    const chosen = Object.entries(layers).find(([n, r]) => r.type === "raster" && ((r.rasterId && r.rasterId === sel.value) || n === sel.value));
    if (chosen) rec = chosen[1];
  }
  if (!rec) {
    const first = Object.values(layers).find(r => r.type === "raster");
    if (first) rec = first;
  }
  if (!rec) return;

  if (rec.bounds) map.fitBounds(rec.bounds);
  else if (rec.leafletLayer && rec.leafletLayer.getBounds) {
    const b = rec.leafletLayer.getBounds(); if (b && b.isValid && b.isValid()) map.fitBounds(b);
  }
}

async function fetchSegments() {
  const r = await fetch(BACKEND() + "/segments", { cache: "no-store" });
  if (!r.ok) return [];
  const j = await r.json();
  return j.segments || j.items || [];
}
async function fetchSegmentsIndex() {
  const r = await fetch(BACKEND() + "/segments_index", { cache: "no-store" });
  if (!r.ok) return [];
  const j = await r.json();
  return j.items || [];
}

async function refreshSamplesSegmentSelectFromServer() {
  const sel = byId("samplesSegmentSelect"); if (!sel) return;
  const items = await fetchSegments();
  sel.innerHTML = "";
  if (!items.length) {
    const o = document.createElement("option"); o.value = ""; o.textContent = "— no segments —";
    sel.appendChild(o); sel.disabled = true; return;
  }
  sel.disabled = false;
  items.forEach(it => {
    const id = it.id || (it.name || "").replace(/\.geojson$/i, "");
    const o = document.createElement("option");
    o.value = id; o.textContent = (it.name || id).replace(/\.geojson$/i, "");
    sel.appendChild(o);
  });
  sel.onchange = handleSamplesSegmentChange;

  // auto-activate if only one
  if (sel.options.length === 1 || (sel.options.length === 2 && !sel.options[0].value)) {
    const first = [...sel.options].find(o => o.value);
    if (first) { sel.value = first.value; sel.onchange(); }
  }
}

async function handleSamplesSegmentChange() {
  const sel = byId("samplesSegmentSelect"); if (!sel) return;
  const chosenId = sel.value; if (!chosenId) return;

  // already on map?
  let exists = false, existingName = null;
  Object.entries(layers).forEach(([name, rec]) => {
    if (rec.type === "segment" && (name === chosenId || rec.segmentId === chosenId)) { exists = true; existingName = name; }
  });
  if (exists) {
    activateSamplingForSegment(existingName);
    // zoomToCurrentRaster();
    console.log(layers[existingName].leafletLayer.getBounds())
    const bounds = layers[existingName].leafletLayer.getBounds();
    map.fitBounds(bounds);
    return;
  }

  // fetch and add
  const segs = await fetchSegments();
  const info = segs.find(s => (s.id || "").toString() === chosenId);
  if (!info || !info.url) return;
  const url = info.url.startsWith("http") ? info.url : BACKEND() + info.url;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return;
  const gj = await r.json();
  const layerName = chosenId;
  segmentLayerIdentify(layerName, gj);
  activateSamplingForSegment(layerName);
  zoomToCurrentRaster();
}

async function refreshClassificationDropdown() {
  const sel = byId("classifiedSegmentSelect"); if (!sel) return;
  sel.innerHTML = "";
  const items = await fetchSegmentsIndex();
  if (!items.length) {
    const o = document.createElement("option"); o.value = ""; o.textContent = "— no segments with samples —";
    sel.appendChild(o); sel.disabled = true; return;
  }
  console.log(items.length);
  sel.disabled = false;
  for(var i =0; i <items.length; i++) {
    console.log(items[i].id+" foreach")
    const id = items[i].id || (items[i].name || "").replace(/\.geojson$/i, "");
    const o = document.createElement("option");
    o.value = id; o.textContent = (items[i].name || id).replace(/\.geojson$/i, "");
    sel.appendChild(o);
  };
}

// --------- style modal ----------
// --- replace your baseStyle with this (adds support for the custom map style) ---
function baseStyle(rec, feat) {
  const def = { color: "#333", weight: 1, opacity: 1, fillOpacity: 0.2 };
  if (!rec || !rec.style) return def;

  // Style from this modal
  if (rec.style.kind === "custommap" && rec.style.attr && rec.style.map) {
    var key = String(((feat && feat.properties) ? feat.properties[rec.style.attr] : "") ?? "null");
    var cfg = rec.style.map[key];
    return cfg ? cfg : def;
  }

  // Your older categorical style (kept for compatibility)
  if (rec.style.kind === "categorical") {
    var k = rec.style.by;
    var v = feat && feat.properties ? String(feat.properties[k]) : undefined;
    var color = k && rec.style.categories ? rec.style.categories[String(v)] : null;
    if (color) return { color: "#222", weight: 1, opacity: 1, fillOpacity: 0.5, fillColor: color };
  }
  return def;
}

// --- applyStyle used by the modal to push styles to the map and legend ---
function applyStyle(layerName) {
  var rec = layers[layerName];
  if (!rec || !rec.leafletLayer) return;

  var st = rec.style || {};

  // if no attribute picked, clear to default
  if (!st.attr || !st.map) {
    rec.style = null;
    rec.leafletLayer.setStyle(function () { return { color:"#333", weight:1, opacity:1, fillOpacity:0.2 }; });
    if (typeof refreshLegendLayers === "function") refreshLegendLayers();
    return;
  }

  // mark this as a custom map style and expose categories for legend swatches
  rec.style.kind = "custommap";
  rec.style.by = st.attr;
  rec.style.categories = {};
  Object.keys(st.map).forEach(function (k) {
    rec.style.categories[k] = st.map[k].fillColor || "#cccccc";
  });

  rec.leafletLayer.setStyle(function (f) { return baseStyle(rec, f); });
  if (typeof refreshLegendLayers === "function") refreshLegendLayers();
}

function renderStyle(layerName) {
    var rec = layers[layerName];
    console.log(rec.style)
    var st = rec.style; // || (rec.style = { kind: "custommap", attr: null, map: {} });
    var attrEl   = document.getElementById("attributeSelect");
    var mapDiv   = document.getElementById("styleMapping");
    var warn     = document.getElementById("styleWarning");
    console.log(st, attrEl)

    var feats = Array.isArray(rec.geojson.features) ? rec.geojson.features : [];
    var firstProps = (feats[0] && feats[0].properties) ? feats[0].properties : {};
    var attrs = Object.keys(firstProps);

    // unique counts for each attribute
    var uniqCount = {};
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      var s = {};
      for (var j = 0; j < feats.length; j++) {
        var val = (feats[j].properties || {})[a];
        s[String(val)] = true;
      }
      uniqCount[a] = Object.keys(s).length;

      var opt = document.createElement("option");
      opt.value = a;
      opt.textContent = a + " (" + uniqCount[a] + ")";
      attrEl.appendChild(opt);
    }

    if (!rec.style) rec.style = { kind: "custommap", attr: null, map: {} };

    // default attribute: 2..10 uniques if possible
    function pickDefaultAttr() {
      for (var k = 0; k < attrs.length; k++) {
        var nm = attrs[k];
        if (uniqCount[nm] > 1 && uniqCount[nm] <= 10) return nm;
      }
      return null;
    }
    if (!rec.style.attr || attrs.indexOf(rec.style.attr) === -1) {
      rec.style.attr = pickDefaultAttr();
    }
    if (rec.style.attr && attrs.indexOf(rec.style.attr) !== -1) {
      attrEl.value = rec.style.attr;
    }

    console.log(layerName)
    console.log(st);
    st.attr = attrEl.value || null;

    var feats = Array.isArray(rec.geojson.features) ? rec.geojson.features : [];

    if (!st.attr) {
      mapDiv.innerHTML = "";
      applyStyle(layerName);
      return;
    }

    // collect unique values for selected attribute
    var valuesSet = {};
    for (var i = 0; i < feats.length; i++) {
      var v = (feats[i].properties || {})[st.attr];
      valuesSet[String(v)] = true;
    }
    var values = Object.keys(valuesSet);

    if (values.length >= 10) {
      if (warn) { warn.style.display = "block"; warn.textContent = "Too many unique values (≥10). Select another attribute."; }
      if (typeof notifyWarning === "function") notifyWarning("Attribute has too many unique values");
      st.attr = null;
      mapDiv.innerHTML = "";
      applyStyle(layerName);
      return;
    }

    if (warn) { warn.style.display = "none"; }

    if (!st.map) st.map = {};
    for (var vIdx = 0; vIdx < values.length; vIdx++) {
      var key = values[vIdx];
      if (!st.map[key]) {
        st.map[key] = { color:"#333333", fillColor: (typeof randColor === "function" ? randColor() : "#cccccc"), weight:1, opacity:1, fillOpacity:0.45 };
      }
    }

    mapDiv.innerHTML = "";
    for (var rIdx = 0; rIdx < values.length; rIdx++) {
      var key2 = values[rIdx];
      var cfg = st.map[key2];
      var row = document.createElement("div");
      row.className = "style-config";
      row.innerHTML =
        '<div class="style-label"><strong>' + key2 + '</strong></div>' +
        '<div class="style-controls">' +
          '<label>Color <input type="color" value="' + cfg.color + '" data-k="' + key2 + '" class="st-color"></label>' +
          '<label>Fill <input type="color" value="' + cfg.fillColor + '" data-k="' + key2 + '" class="st-fill"></label>' +
          '<label>Opacity <input type="number" value="' + cfg.opacity + '" step="0.1" min="0" max="1" data-k="' + key2 + '" class="st-op"></label>' +
          '<label>Fill Opacity <input type="number" value="' + cfg.fillOpacity + '" step="0.1" min="0" max="1" data-k="' + key2 + '" class="st-fop"></label>' +
          '<label>Weight <input type="number" value="' + cfg.weight + '" step="1" min="0" max="10" data-k="' + key2 + '" class="st-w"></label>' +
        '</div>';
      mapDiv.appendChild(row);
    }

    // live update handlers
    var inputs = mapDiv.querySelectorAll(".st-color,.st-fill,.st-op,.st-fop,.st-w");
    for (var n = 0; n < inputs.length; n++) {
      inputs[n].oninput = (function (inp) {
        return function () {
          var k = inp.getAttribute("data-k");
          var cfg = st.map[k]; if (!cfg) return;
          if (inp.classList.contains("st-color")) cfg.color = inp.value;
          else if (inp.classList.contains("st-fill")) cfg.fillColor = inp.value;
          else if (inp.classList.contains("st-op")) cfg.opacity = parseFloat(inp.value);
          else if (inp.classList.contains("st-fop")) cfg.fillOpacity = parseFloat(inp.value);
          else if (inp.classList.contains("st-w")) cfg.weight = parseFloat(inp.value);
          applyStyle(layerName);
        };
      })(inputs[n]);
    }

    applyStyle(layerName);
  }

// --- your modal using your original element IDs, no $, no window ---
function openStyleModal(layerName) {
  var rec = layers[layerName];
  if (!rec || !rec.geojson) return;

  var panel    = document.getElementById("styleConfig");
  var attrEl   = document.getElementById("attributeSelect");
  var mapDiv   = document.getElementById("styleMapping");
  var warn     = document.getElementById("styleWarning");
  if (!panel || !attrEl || !mapDiv) return;

  panel.style.display = "block";
  attrEl.innerHTML = "";
  mapDiv.innerHTML = "";
  if (warn) { warn.style.display = "none"; warn.textContent = ""; }

  attrEl.onchange = renderStyle;
  renderStyle(layerName);

  // open modal
  var modal = document.getElementById("styleModal");
  var backdrop = document.getElementById("styleBackdrop");
  var closeBtn = document.getElementById("closeStyleModalBtn");
  function close() {
    if (modal) modal.classList.add("hidden");
    if (backdrop) backdrop.classList.add("hidden");
    document.body.classList.remove("no-scroll");
  }
  if (modal) {
    modal.classList.remove("hidden");
    if (backdrop) backdrop.classList.remove("hidden");
    document.body.classList.add("no-scroll");
    if (closeBtn) closeBtn.onclick = close;
    if (backdrop) backdrop.onclick = close;
  }
}


// function closeStyleModal() {
//   const modal = byId("styleModal"); const bd = byId("styleBackdrop");
//   if (modal) modal.classList.add("hidden");
//   if (bd) bd.classList.add("hidden");
// }

// --------- classification ----------
async function runClassification() {
  const status = byId("clfStatus"); if (status) status.textContent = "";
  const segSel = byId("classifiedSegmentSelect");
  const segment_id = segSel && segSel.value ? segSel.value : "";
  if (!segment_id) { alert("Select a segmentation with samples first."); return; }
  const methodSel = byId("clfMethod");
  const method = methodSel && methodSel.value ? methodSel.value : "rf";

  if (status) status.textContent = "Running classification…";

  const fd = new FormData();
  fd.append("segment_id", segment_id);
  fd.append("method", method);

  const r = await fetch(BACKEND() + "/classify", { method: "POST", body: fd });
  if (!r.ok) { if (status) status.textContent = "Classification failed"; alert("Classification failed"); return; }
  const data = await r.json();

  let result = null;
  if (data.geojson) result = data.geojson;
  else if (data.geojson_url) {
    const url = data.geojson_url.startsWith("http") ? data.geojson_url : BACKEND() + data.geojson_url;
    const rr = await fetch(url, { cache: "no-store" }); if (rr.ok) result = await rr.json();
  }
  if (!result) { if (status) status.textContent = "Classification failed"; alert("No result"); return; }

  const chosenLabel = segSel.options[segSel.selectedIndex] ? segSel.options[segSel.selectedIndex].textContent : segment_id;
  const name = "classify_" + chosenLabel.split("egment_")[1];
  addLayer(name, result, "viewer", {});

  // auto-style by "class"
  const hasClass = result.features && result.features.some(f => f.properties && f.properties.class != null);
  if (hasClass) {
    const vals = [...new Set(result.features.map(f => String(f.properties.class)))];
    const colors = {}; vals.forEach(v => colors[v] = randColor());
    applyCategoricalStyle(name, "class", colors);
  }

  const rec = layers[name];
  if (rec && rec.leafletLayer && rec.leafletLayer.getBounds) {
    const b = rec.leafletLayer.getBounds(); if (b && b.isValid && b.isValid()) map.fitBounds(b);
  }

  if (status) status.textContent = "Classification done.";
}

// --------- wire buttons + boot ----------
document.addEventListener("DOMContentLoaded", async function () {
  initMap();
  legendCtl.addTo(map);
  bindMapPicking();
  renderLayerList();
  wireDropZone();

  await loadExistingRasters();
  await addServerGeoJSONs();

  refreshRasterDropdown();
  refreshLegendLayers();
  generateClassControls();
  refreshSamplesSegmentSelectFromServer();
  refreshClassificationDropdown();

  const runBtn = byId("runClassificationBtn");
  if (runBtn) runBtn.onclick = function (e) { e.preventDefault(); runClassification(); };

  const genBtn = byId("generateClassesBtn");
  if (genBtn) genBtn.onclick = generateClassControls;

  const resetBtn = byId("resetSamplesBtn");
  if (resetBtn) resetBtn.onclick = resetAllSamples;

  // in case you have inline HTML handlers:
  // <button onclick="resetSelections()">Reset</button>
  // <button onclick="runSegmentation()">Segment</button>
  // <button onclick="runClassification()">Run Classification</button>
  resetSelections = resetAllSamples;
});



  const mergeBtn = byId("cleanClassifiedSegment");
  if (mergeBtn) mergeBtn.onclick = function (e) {
    e.preventDefault();
    runMergeClean();
  };


  async function runMergeClean() {
  // pick the classified layer filename from the dropdown or layer list
  const segSel = byId("classifiedSegmentSelect");
  if (!segSel || !segSel.value) {
    alert("Select a classified layer first."); 
    return;
  }
  const filename = "classify_" + segSel.value.split("egment_")[1].replace(/\.geojson$/i, "") + ".geojson";

  const fd = new FormData();
  fd.append("filename", filename);

  const r = await fetch(BACKEND() + "/merge_clean", { method: "POST", body: fd });
  if (!r.ok) {
    const err = await r.json().catch(() => null);
    notifyWarning(err?.error || "Merge failed");
    return;
  }

  const data = await r.json();
  const url = data.geojson_url.startsWith("http") ? data.geojson_url : BACKEND() + data.geojson_url;
  const rr = await fetch(url, { cache: "no-store" });
  if (!rr.ok) { notifyWarning("Failed to load merged GeoJSON"); return; }
  const gj = await rr.json();

  const name = "merged_" + segSel.value;
  addLayer(name, gj, "viewer", {});
  if (layers[name] && layers[name].leafletLayer && layers[name].leafletLayer.getBounds) {
    const b = layers[name].leafletLayer.getBounds();
    if (b && b.isValid && b.isValid()) map.fitBounds(b);
  }
  notifySuccess("Merge & clean done");
}

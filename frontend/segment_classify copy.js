// segment_classify.js

function BACKEND() {
  return window.BACKEND_URL || "http://127.0.0.1:8001";
}
const $ = (id) => document.getElementById(id);

// Cache of segments index returned by the backend
// Expected shape per item: { id, name, url, has_samples }
window.__SEG_INDEX = { byId: {}, list: [] };

/* ========== UI helpers ========== */
function setSegStatus(msg) {
  const s = $("segStatus");
  if (s) s.textContent = msg || "";
}

/* ========== SEGMENTATION (Segment tab) ========== */
async function runSegmentationFromUI() {
  try {
    const rasterSel = $("orthoSelect");
    const raster_id = rasterSel?.value || "";
    const scale = parseFloat(($("segScale")?.value || "30"));
    const compactness = parseFloat(($("segCompactness")?.value || "0.3"));

    if (!raster_id) {
      alert("Please select an image layer first.");
      return;
    }

    setSegStatus("Running segmentation…");

    const fd = new FormData();
    fd.append("raster_id", raster_id);
    fd.append("scale", String(scale));
    fd.append("compactness", String(compactness));

    const resp = await fetch(`${BACKEND()}/segment`, { method: "POST", body: fd });
    if (!resp.ok) {
      let msg; try { msg = await resp.json(); } catch { msg = await resp.text(); }
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    const data = await resp.json();

    // Load produced GeoJSON
    let geo = null;
    if (data.geojson) geo = data.geojson;
    else if (data.geojson_url) {
      const url = data.geojson_url.startsWith("http") ? data.geojson_url : BACKEND() + data.geojson_url;
      geo = await fetch(url, { cache: "no-store" }).then(r => r.json());
    }
    if (!geo) throw new Error("No segmentation result received");

    const segId =
      data.id ||
      (data.geojson_url || "").split("/").pop()?.replace(/\.geojson$/i, "") ||
      ("seg_" + Math.random().toString(36).slice(2, 8));
    const layerName = `Segment_${String(segId).slice(0, 8)}`;

    // Add to map as a "segment" layer
    if (typeof window.segmentLayerIdentify === "function") {
      window.segmentLayerIdentify(layerName, geo);
    } else if (typeof window.addLayer === "function") {
      window.addLayer(layerName, geo, "segment", { segmentId: segId });
    }

    setSegStatus("Segmentation done.");

    // Refresh dropdowns to include the new segment
    refreshSegmentDropdown();
  } catch (e) {
    console.error(e);
    setSegStatus("Segmentation failed");
    alert("Segmentation failed: " + (e?.message || e));
  }
}
// Keep HTML compatibility: onclick="runSegmentation()"
window.runSegmentation = runSegmentationFromUI;

/* ========== Fetch segments index ========== */
async function fetchSegmentsIndex() {
  async function hit(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${url} failed with ${r.status}`);
    const data = await r.json();
    const list = data.items || data || [];
    const byId = {};
    list.forEach(s => { if (s?.id) byId[s.id] = s; });
    return { byId, list };
  }

  try {
    // Primary endpoint
    window.__SEG_INDEX = await hit(`${BACKEND()}/segments`);
  } catch (_) {
    try {
      // Fallback (if you kept this alias)
      window.__SEG_INDEX = await hit(`${BACKEND()}/segments_index`);
    } catch (_) {
      try {
        // Last-resort fallback to /geojsons (shows all; may include non-segments)
        window.__SEG_INDEX = await hit(`${BACKEND()}/geojsons`);
      } catch (err) {
        console.warn("fetchSegmentsIndex failed:", err);
        window.__SEG_INDEX = { byId: {}, list: [] };
      }
    }
  }
  return window.__SEG_INDEX;
}

/* ========== Populate dropdowns ========== */
async function refreshSegmentDropdown() {
  const segIndex = await fetchSegmentsIndex();
  console.log(segIndex)
  // SAMPLES TAB: all segments
  const selSamples = $("samplesSegmentSelect");
  if (selSamples) {
    const prev = selSamples.value;
    selSamples.innerHTML = "";
    const arr = segIndex.list.map(s => ({
      id: s.id,
      label: (s.name || s.id || "").replace(/\.geojson$/i, ""),
      hasSamples: !!s.has_samples
    }));

    if (arr.length === 0) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "— no segments —";
      selSamples.appendChild(o);
      selSamples.disabled = true;
    } else {
      selSamples.disabled = false;
      for (const e of arr) {
        const o = document.createElement("option");
        o.value = e.id;
        o.textContent = e.label + (e.hasSamples ? " (has samples)" : "");
        selSamples.appendChild(o);
      }
      if ([...selSamples.options].some(o => o.value === prev)) selSamples.value = prev;
      else selSamples.selectedIndex = 0;
    }
  }

  // CLASSIFICATION TAB: only segments with samples
  const selClf = $("segmentSelect");
  const runBtn = $("runClassificationBtn");
  if (selClf) {
    const prev = selClf.value;
    selClf.innerHTML = "";
    const arr = segIndex.list
      .filter(s => !!s.has_samples)
      .map(s => ({ id: s.id, label: (s.name || s.id || "").replace(/\.geojson$/i, "") }));

    if (arr.length === 0) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "— no sampled segments —";
      selClf.appendChild(o);
      selClf.disabled = true;
      if (runBtn) runBtn.disabled = true;
    } else {
      selClf.disabled = false;
      for (const e of arr) {
        const o = document.createElement("option");
        o.value = e.id;
        o.textContent = e.label;
        selClf.appendChild(o);
      }
      if ([...selClf.options].some(o => o.value === prev)) selClf.value = prev;
      else selClf.selectedIndex = 0;
      if (runBtn) runBtn.disabled = false;
    }
  }
}
window.refreshSegmentDropdown = refreshSegmentDropdown;


/* ========== Samples tab: when user chooses a segment to sample ========== */
async function handleSamplesSegmentChange() {
  const sel = $("samplesSegmentSelect");
  if (!sel) return;
  const chosenId = sel.value;
  if (!chosenId) return;

  // If it's already on the map as a "segment", just activate sampling on that layer
  let alreadyThere = false;
  if (window.layers) {
    for (const [name, rec] of Object.entries(window.layers)) {
      if (rec?.type === "segment" && (name === chosenId || rec.segmentId === chosenId)) {
        alreadyThere = true;
        if (typeof window.activateSamplingForSegment === "function") {
          window.activateSamplingForSegment(name);
        }
        break;
      }
    }
  }
  if (alreadyThere) return;

  // Otherwise fetch and add
  const info = window.__SEG_INDEX.byId[chosenId];
  if (!info || !info.url) return;

  try {
    const url = info.url.startsWith("http") ? info.url : BACKEND() + info.url;
    const gj = await fetch(url, { cache: "no-store" }).then(x => x.json());
    const layerName = info.id; // keep name = id to avoid duplicates
    if (typeof window.segmentLayerIdentify === "function") {
      window.segmentLayerIdentify(layerName, gj);
    } else if (typeof window.addLayer === "function") {
      window.addLayer(layerName, gj, "segment", { segmentId: info.id });
    }
    if (typeof window.activateSamplingForSegment === "function") {
      window.activateSamplingForSegment(layerName);
    }
  } catch (e) {
    console.error("Failed to load segment for sampling:", e);
  }
}
window.handleSamplesSegmentChange = handleSamplesSegmentChange;

/* ========== CLASSIFICATION (Classification tab) ========== */
async function runClassification() {
  const status = $("clfStatus");
  if (status) status.textContent = "";

  const segSel = $("segmentSelect");
  const segment_id = segSel?.value || "";
  if (!segment_id) {
    alert("Select a segmentation with samples first.");
    return;
  }
  const methodSel = $("clfMethod");
  const method = methodSel?.value || "rf";

  if (status) status.textContent = "Running classification…";

  try {
    // IMPORTANT: send as FormData (your FastAPI expects Form(...))
    const fd = new FormData();
    fd.append("segment_id", segment_id);
    fd.append("method", method);

    const r = await fetch(`${BACKEND()}/classify`, { method: "POST", body: fd });
    if (!r.ok) {
      let msg; try { msg = await r.json(); } catch { msg = await r.text(); }
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    const data = await r.json();

    let result = null;
    if (data.geojson) result = data.geojson;
    else if (data.geojson_url) {
      const url = data.geojson_url.startsWith("http") ? data.geojson_url : BACKEND() + data.geojson_url;
      result = await fetch(url, { cache: "no-store" }).then(x => x.json());
    }
    if (!result) throw new Error("No classification result");

    const chosenLabel = segSel.options[segSel.selectedIndex]?.textContent || segment_id;

    // Add result to map as a normal viewer layer (not selectable for sampling)
    if (typeof window.segmentLayerIdentify === "function") {
      window.segmentLayerIdentify(`Classification - ${chosenLabel}`, result);
    } else if (typeof window.addLayer === "function") {
      window.addLayer(`Classification - ${chosenLabel}`, result, "viewer");
    }

    if (status) status.textContent = "Classification done.";
  } catch (e) {
    console.error(e);
    if (status) status.textContent = "Classification failed";
    alert("Classification failed: " + (e?.message || e));
  }
}
window.runClassification = runClassification;

/* ========== Wire up on load ========== */
document.addEventListener("DOMContentLoaded", () => {
  // Populate dropdowns on every (re)load
  refreshSegmentDropdown();

  // When user picks a segment to sample
  const selSamples = $("samplesSegmentSelect");
  if (selSamples) selSamples.addEventListener("change", handleSamplesSegmentChange);

  // Classification run button
  const runBtn = $("runClassificationBtn");
  if (runBtn) runBtn.addEventListener("click", runClassification);
});

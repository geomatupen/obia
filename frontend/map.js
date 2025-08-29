// map.js — map + state only (no DOM wiring)
(function () {
  const map = L.map('map').setView([47.899167, 17.007472], 18);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 22 }).addTo(map);

  const layers = {}; // name -> { type, leafletLayer, geojson, style, visible, bounds, rasterId?, segmentId? }
  let segmentLayer = null;
  let segmentLayerName = null;

  function uniqueLayerName(base) {
    if (!layers[base]) return base;
    let i = 2; while (layers[`${base} (${i})`]) i++; return `${base} (${i})`;
  }
  function randomColor() {
    return `#${Math.floor(Math.random()*0xFFFFFF).toString(16).padStart(6,'0')}`;
  }

  // First attribute with <10 uniques; else null (use default style)
  function defaultAttr(gj) {
    const props = Object.keys(gj?.features?.[0]?.properties || {});
    const preferred = ["class","predicted","label","Class","category","segment_class","segment_id"];
    for (const p of preferred) {
      if (props.includes(p)) {
        const uniq = new Set(gj.features.map(f => f.properties?.[p]));
        if (uniq.size > 0 && uniq.size < 10) return p;
      }
    }
    for (const p of props) {
      const uniq = new Set(gj.features.map(f => f.properties?.[p]));
      if (uniq.size > 0 && uniq.size < 10) return p;
    }
    return null;
  }

  function uniqueValues(gj, attr) {
    if (!attr) return [];
    const set = new Set();
    for (const f of (gj.features || [])) set.add(f?.properties?.[attr]);
    return [...set].map(v => (v == null ? "null" : String(v)));
  }

  function ensurePalette(rec) {
    const st = rec.style;
    if (!st || !st.attr) return;
    const values = uniqueValues(rec.geojson, st.attr);
    for (const v of values) {
      if (!st.map[v]) {
        st.map[v] = {
          color: "#333333",
          fillColor: randomColor(),
          weight: 1,
          opacity: 1,
          fillOpacity: 0.45
        };
      }
    }
  }

  function addTileLayerXYZ(url, minZ, maxZ, name, bounds, addToMap = true, meta = {}) {
    const safeName = uniqueLayerName(name || "Raster");
    const tl = L.tileLayer(url, { minZoom: minZ ?? 0, maxZoom: maxZ ?? 22 });
    if (addToMap) tl.addTo(map);

    layers[safeName] = {
      type: "raster",
      leafletLayer: tl,
      visible: !!addToMap,
      bounds: Array.isArray(bounds) ? bounds : null,
      minZ, maxZ,
      rasterId: meta.id || null
    };

    if (addToMap && bounds && bounds.length === 4) {
      map.fitBounds([[bounds[1], bounds[0]], [bounds[3], bounds[2]]]);
      const z = map.getZoom();
      if (minZ != null && z < minZ) map.setZoom(minZ);
      if (maxZ != null && z > maxZ) map.setZoom(maxZ);
    }
    return safeName;
  }

  function drawGeoJSONLayer(name) {
    const rec = layers[name]; if (!rec?.geojson) return;

    if (rec.leafletLayer) { try { rec.leafletLayer.remove(); } catch (_) {} }

    if (!rec.style) rec.style = { attr: defaultAttr(rec.geojson), map: {} };
    if (rec.style.attr) ensurePalette(rec);

    const st = rec.style;
    const styFn = (f) => {
      if (!st.attr) {
        return { color: "#3388ff", fillColor: "#ffffff", weight: 1, opacity: 1, fillOpacity: 0.2 };
      }
      const v = (f.properties?.[st.attr] ?? "").toString();
      const s = st.map[v] || {};
      return {
        color: s.color || "#333333",
        fillColor: s.fillColor || "#cccccc",
        weight: s.weight ?? 1,
        opacity: s.opacity ?? 1,
        fillOpacity: s.fillOpacity ?? 0.45
      };
    };

    const layer = L.geoJSON(rec.geojson, {
      style: styFn,
      pointToLayer: (f, latlng) => L.circleMarker(latlng, styFn(f)),
      onEachFeature: (feat, l) => {
        l.on("click", () => {
          if (window._sampling && window._sampling.activeName === name && typeof window._sampling.handler === "function") {
            try { window._sampling.handler(name, feat, l); } catch(_) {}
          }
          if (window.showProperties) window.showProperties(feat.properties);
        });
      }
    }).addTo(map);

    rec.leafletLayer = layer;
    rec.visible = true;

    const b = layer.getBounds?.();
    if (b?.isValid?.()) rec.bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];

    if (rec.type === "segment") { segmentLayer = layer; segmentLayerName = name; }
  }

  function applyStyle(name) {
    const rec = layers[name]; if (!rec?.leafletLayer) return;
    if (rec.style?.attr) ensurePalette(rec);

    const st = rec.style || {};
    rec.leafletLayer.eachLayer(l => {
      if (!st.attr) {
        l.setStyle({ color: "#3388ff", fillColor: "#ffffff", weight: 1, opacity: 1, fillOpacity: 0.2 });
        return;
      }
      const v = (l.feature?.properties?.[st.attr] ?? "").toString();
      const s = st.map?.[v] || {};
      l.setStyle({
        color: s.color || "#333333",
        fillColor: s.fillColor || "#cccccc",
        weight: s.weight ?? 1,
        opacity: s.opacity ?? 1,
        fillOpacity: s.fillOpacity ?? 0.45
      });
    });
  }

  function addLayer(name, geojson, type = "viewer", meta = {}) {
    const nm = uniqueLayerName(name || "Layer");
    layers[nm] = {
      type,
      geojson,
      style: { attr: defaultAttr(geojson), map: {} },
      visible: false,
      bounds: null
    };
    if (meta.segmentId) layers[nm].segmentId = meta.segmentId;
    drawGeoJSONLayer(nm);
    return nm;
  }

  function segmentLayerIdentify(name, geojson, meta) {
    return addLayer(name, geojson, "segment", meta || {});
  }

  function showProperties(props) {
    const box = document.getElementById("custom-popup-box");
    const cont = box?.querySelector(".popup-content");
    if (!box || !cont) return;
    box.style.display = "block";
    let html = "<table>";
    for (const k in props) html += `<tr><td><strong>${k}</strong></td><td>${props[k]}</td></tr>`;
    html += "</table>";
    cont.innerHTML = html;
  }

  function activateSamplingForSegment(layerName) {
    const rec = layers[layerName];
    if (rec?.type !== "segment") return;
    if (rec.leafletLayer) { segmentLayer = rec.leafletLayer; segmentLayerName = layerName; }
  }

  // Expose
  window.map = map;
  window.layers = layers;
  window.uniqueLayerName = uniqueLayerName;
  window.randomColor = randomColor;
  window.defaultAttr = defaultAttr;
  window.addTileLayerXYZ = addTileLayerXYZ;
  window.addLayer = addLayer;
  window.segmentLayerIdentify = segmentLayerIdentify;
  window.drawGeoJSONLayer = drawGeoJSONLayer;
  window.applyStyle = applyStyle;
  window.showProperties = showProperties;
  window.activateSamplingForSegment = activateSamplingForSegment;
})();

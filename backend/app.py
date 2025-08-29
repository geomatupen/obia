# backend/app.py — simple FastAPI backend with consistent tile colors and segments/geojson listing

from pathlib import Path
from io import BytesIO
import os, json, uuid, math, hashlib, shutil, base64

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
from rasterio.warp import transform_bounds

from fastapi import FastAPI, UploadFile, File, Form, Request, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

# If you have real segmentation helpers, keep these:
from obia.segmentation import run_slic_segmentation, layer_to_geojson
from obia.classification import classify as run_classification

import logging, time
logger = logging.getLogger("app")
logger.setLevel(logging.INFO)
if not logger.handlers:
    h = logging.StreamHandler()
    h.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(h)

# ---------------- paths
BASE = Path(__file__).resolve().parent
UPLOADS = BASE / "uploads"
RESULTS = BASE / "results"
SEGMENTS_DIR = RESULTS / "segments"
CLASSIFY_DIR = RESULTS / "classify"
SAMPLES_DIR = RESULTS / "samples"
for p in (UPLOADS, RESULTS, SEGMENTS_DIR, CLASSIFY_DIR, SAMPLES_DIR):
    p.mkdir(parents=True, exist_ok=True)

METADATA = UPLOADS / "_rasters.json"
if not METADATA.exists():
    METADATA.write_text(json.dumps({"items": []}, indent=2), encoding="utf-8")

# 1x1 transparent PNG fallback
TRANSPARENT_PNG_1x1 = base64.b64decode(
    b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="
)

# ---------------- app
app = FastAPI(title="OBIA API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], allow_credentials=True,
)
app.mount("/results", StaticFiles(directory=str(RESULTS)), name="results")

# ---------------- small helpers
def _ok(data): return JSONResponse(content=data)
def _bad(msg, code=400): return JSONResponse(status_code=code, content={"error": msg})

def _load_db():
    return json.loads(METADATA.read_text(encoding="utf-8"))

def _save_db(db):
    METADATA.write_text(json.dumps(db, indent=2), encoding="utf-8")

def _sha1_file(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def _raster_path_by_id(rid: str) -> Path | None:
    db = _load_db()
    for it in db.get("items", []):
        if it["id"] == rid:
            p = Path(it["path"])
            return p if p.exists() else None
    return None

def _unique_display_name(filename: str, existing_names: list[str]) -> str:
    base, ext = os.path.splitext(filename)
    candidate = filename
    i = 1
    existing = set(existing_names)
    while candidate in existing:
        candidate = f"{base} {i}{ext}"
        i += 1
    return candidate

def _tile_bounds_wgs84(x: int, y: int, z: int):
    n = 2 ** z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    def lat(y_):
        t = math.pi * (1 - 2 * y_ / n)
        return math.degrees(math.atan(math.sinh(t)))
    north = lat(y)
    south = lat(y + 1)
    return west, south, east, north

# Global per-raster render stats cache: rid -> (vmins[list], vmaxs[list])
RENDER_STATS = {}
def _get_render_stats(rid: str, ds):
    if rid in RENDER_STATS:
        return RENDER_STATS[rid]
    idxs = list(range(1, min(3, ds.count) + 1)) or [1]
    scale = max(ds.width, ds.height) / 1024.0 if max(ds.width, ds.height) > 1024 else 1.0
    out_h = max(1, int(ds.height / scale))
    out_w = max(1, int(ds.width / scale))
    arr = ds.read(
        indexes=idxs, out_shape=(len(idxs), out_h, out_w),
        resampling=Resampling.bilinear, boundless=True, fill_value=0
    ).astype("float32")
    mask = ds.read_masks(1, out_shape=(out_h, out_w)) == 0
    vmins, vmaxs = [], []
    for b in range(arr.shape[0]):
        vals = arr[b][~mask]
        if vals.size == 0:
            vmins.append(0.0); vmaxs.append(1.0)
        else:
            vmin = float(np.percentile(vals, 2))
            vmax = float(np.percentile(vals, 98))
            if vmax <= vmin: vmax = vmin + 1.0
            vmins.append(vmin); vmaxs.append(vmax)
    RENDER_STATS[rid] = (vmins, vmaxs)
    return RENDER_STATS[rid]

# ---- helpers (place near your other helpers) ----
def _sanitize_base(name: str) -> str:
    # drop extension, replace whitespace with underscores, and cap at 12 chars
    base, _ = os.path.splitext(name)
    base = "_".join(base.split())           # spaces -> underscores
    base = base[:12] if len(base) > 12 else base  # limit to 12
    return base or "raster"

def _flt_token(v) -> str:
    # compact, stable float string
    return format(float(v), ".6g")

def _unique_segment_filename(raster_display_name: str, scale, compactness) -> str:
    """
    segment_<raster>_<scale>_<compactness>.geojson
    If it exists already, append _1, _2, ...
    """
    base = _sanitize_base(raster_display_name)
    s = _flt_token(scale)
    c = _flt_token(compactness)
    candidate = f"segment_{base}_{s}_{c}.geojson"
    i = 1
    while (SEGMENTS_DIR / candidate).exists():
        candidate = f"segment_{base}_{s}_{c}_{i}.geojson"
        i += 1
    return candidate


# ---------------- health
@app.get("/health")
def health():
    return {"ok": True}

# ---------------- rasters
@app.get("/rasters")
def list_rasters():
    db = _load_db()
    items = []
    for it in db.get("items", []):
        p = Path(it["path"])
        if p.exists():
            size_mb = round(p.stat().st_size / (1024 * 1024), 2)
            items.append({"id": it["id"], "name": it["name"], "size_mb": size_mb})
    return _ok({"rasters": items})

@app.post("/rasters")
async def upload_raster(file: UploadFile = File(...)):
    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".tif", ".tiff", ".img"}:
        return _bad("Only .tif/.tiff/.img allowed.")
    tmp = UPLOADS / f"tmp_{uuid.uuid4().hex}{suffix}"
    with tmp.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    sha1 = _sha1_file(tmp)
    db = _load_db()
    # dedup exact same file content
    for it in db["items"]:
        if it.get("sha1") == sha1:
            tmp.unlink(missing_ok=True)
            return _ok({"id": it["id"], "name": it["name"], "dedup": True})

    # >>> CHANGED: save using the real filename (with numbering on duplicates)
    existing_names = [it["name"] for it in db["items"]]
    display_name = _unique_display_name(Path(file.filename).name, existing_names)
    final = UPLOADS / display_name
    tmp.rename(final)

    rid = uuid.uuid4().hex
    entry = {"id": rid, "name": display_name, "path": str(final), "sha1": sha1}
    db["items"].append(entry)
    _save_db(db)
    if rid in RENDER_STATS: del RENDER_STATS[rid]
    return _ok({"id": rid, "name": entry["name"]})

@app.get("/rasters/{rid}/status")
def raster_status(rid: str):
    path = _raster_path_by_id(rid)
    if not path:
        return _bad("raster not found", 404)
    bounds_wgs84 = None
    try:
        with rasterio.open(path) as ds:
            b = ds.bounds
            wgs = transform_bounds(ds.crs, "EPSG:4326", b.left, b.bottom, b.right, b.top, densify_pts=21)
            bounds_wgs84 = [wgs[0], wgs[1], wgs[2], wgs[3]]
    except Exception:
        pass
    return _ok({
        "status": {"state": "done"},
        "tile_url": f"/tiles/{rid}/{{z}}/{{x}}/{{y}}.png",
        "zooms": list(range(0, 23)),
        "bounds": bounds_wgs84,
    })

@app.delete("/rasters/{rid}")
def delete_raster(rid: str):
    db = _load_db()
    kept, deleted = [], False
    for it in db.get("items", []):
        if it["id"] == rid:
            deleted = True
            try: Path(it["path"]).unlink(missing_ok=True)
            except Exception: pass
        else:
            kept.append(it)
    db["items"] = kept
    _save_db(db)
    if rid in RENDER_STATS: del RENDER_STATS[rid]
    return _ok({"deleted": deleted})

# ---------------- tiny tile server (consistent colors across tiles)
@app.get("/tiles/{rid}/{z}/{x}/{y}.png")
def tile_png(rid: str, z: int, x: int, y: int):
    path = _raster_path_by_id(rid)
    if not path:
        return _bad("raster not found", 404)
    try:
        with rasterio.open(path) as ds:
            west, south, east, north = _tile_bounds_wgs84(x, y, z)
            rb = transform_bounds("EPSG:4326", ds.crs, west, south, east, north, densify_pts=21)

            idxs = list(range(1, min(3, ds.count) + 1)) or [1]
            win = from_bounds(*rb, transform=ds.transform)
            out_h = out_w = 256
            data = ds.read(
                indexes=idxs, window=win, out_shape=(len(idxs), out_h, out_w),
                resampling=Resampling.bilinear, boundless=True, fill_value=0
            ).astype("float32")

            alpha_mask = (ds.read_masks(1, window=win, out_shape=(out_h, out_w)) == 0)

            vmins, vmaxs = _get_render_stats(rid, ds)
            for b in range(data.shape[0]):
                vmin = vmins[b if b < len(vmins) else -1]
                vmax = vmaxs[b if b < len(vmaxs) else -1]
                data[b] = (data[b] - vmin) / (vmax - vmin)
            data = np.clip(data, 0, 1)

            if data.shape[0] == 1:
                data = np.repeat(data, 3, axis=0)

            rgb = (data[:3] * 255).astype("uint8")
            alpha = np.where(alpha_mask, 0, 255).astype("uint8")

            try:
                from PIL import Image
                rgba = np.dstack([rgb[0], rgb[1], rgb[2], alpha])
                im = Image.fromarray(rgba, mode="RGBA")
                buf = BytesIO()
                im.save(buf, format="PNG")
                return Response(content=buf.getvalue(), media_type="image/png")
            except Exception:
                return Response(content=TRANSPARENT_PNG_1x1, media_type="image/png")
    except Exception:
        return Response(content=TRANSPARENT_PNG_1x1, media_type="image/png")

# ---------------- segmentation -> save under results/segments
# ---- /segment route (replace just this handler body) ----
@app.post("/segment")
async def segment(
    raster_id: str = Form(...),
    scale: float = Form(...),
    compactness: float = Form(...),
):
    path = _raster_path_by_id(raster_id)
    if not path:
        return _bad("raster_id not found", 404)

    db = _load_db()
    rec = next((it for it in db.get("items", []) if it["id"] == raster_id), None)
    raster_display_name = rec["name"] if rec else Path(path).name

    seg = run_slic_segmentation(str(path), scale=scale, compactness=compactness)
    fc  = layer_to_geojson(seg)

    fname = _unique_segment_filename(raster_display_name, scale, compactness)
    (SEGMENTS_DIR / fname).write_text(json.dumps(fc), encoding="utf-8")

    seg_id = Path(fname).stem
    return _ok({
        "id": seg_id,
        "geojson": fc,
        "geojson_url": f"/results/segments/{fname}"
    })




# ---------------- listings
def _collect_geojsons():
    items = []
    # segments/
    for p in sorted(SEGMENTS_DIR.glob("*.geojson")):
        stem = p.stem
        items.append({
            "id": stem, "name": p.name, "url": f"/results/segments/{p.name}",
            "has_samples": (RESULTS / f"samples_{stem}.json").exists() or (SAMPLES_DIR / f"{stem}.json").exists(),
        })
    # classify/
    for p in sorted(CLASSIFY_DIR.glob("*.geojson")):
        stem = p.stem
        items.append({
            "id": stem, "name": p.name, "url": f"/results/classify/{p.name}",
            "has_samples": (RESULTS / f"samples_{stem}.json").exists() or (SAMPLES_DIR / f"{stem}.json").exists(),
        })
    # root (back-compat)
    for p in sorted(RESULTS.glob("*.geojson")):
        if p.parent != RESULTS:  # skip subdirs
            continue
        stem = p.stem
        items.append({
            "id": stem, "name": p.name, "url": f"/results/{p.name}",
            "has_samples": (RESULTS / f"samples_{stem}.json").exists() or (SAMPLES_DIR / f"{stem}.json").exists(),
        })
    return items

@app.get("/geojsons")
def list_geojsons():
    return _ok({"items": _collect_geojsons()})

def _segment_items():
    """All segments (segments/ plus backward-compat in results/)."""
    out = []
    for p in sorted(SEGMENTS_DIR.glob("*.geojson")):
        stem = p.stem
        out.append({"id": stem, "name": p.name, "url": f"/results/segments/{p.name}"})
    for p in sorted(RESULTS.glob("segment_*.geojson")):
        if p.parent != RESULTS:
            continue
        stem = p.stem
        out.append({"id": stem, "name": p.name, "url": f"/results/{p.name}"})
    return out

def _segment_items_with_samples():
    """Only segments that have a matching samples JSON in results/samples/."""
    items = _segment_items()
    out = []
    for it in items:
        seg_id = it["id"]  # this is the file stem
        has_samples = (SAMPLES_DIR / f"{seg_id}.json").exists() or (SAMPLES_DIR / f"samples_{seg_id}.json").exists()
        if has_samples:
            out.append(it)
    return out

@app.get("/segments")
def get_segments():
    # all segments
    return _ok({"segments": _segment_items()})

@app.get("/segments_index")
def get_segments_index():
    # only those with samples in results/samples/
    return _ok({"items": _segment_items_with_samples()})

# ---------------- samples + classify
@app.post("/samples")
async def save_samples(req: Request):
    data = await req.json()
    segment_id = data.get("segment_id")
    samples = data.get("samples", {})
    if not segment_id or not isinstance(samples, dict):
        return _bad("segment_id and samples required")
    out = {"segment_id": segment_id, "samples": samples}
    (RESULTS / f"samples_{segment_id}.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    (SAMPLES_DIR / f"{segment_id}.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    return _ok({"saved": True})

@app.post("/classify")
async def classify(
    segment_id: str = Form(...),
    method: str = Form("rf"),
):
    # run the external classifier
    try:
        res = run_classification(
            segment_id=segment_id,
            method=method,
            results_dir=str(RESULTS),        # expects results/segments and results/samples
            classified_dir=str(CLASSIFY_DIR) # writes temporary result here
        )
    except FileNotFoundError as e:
        return _bad(str(e), 404)
    except ValueError as e:
        return _bad(str(e), 400)
    except Exception as e:
        return _bad(f"classification failed: {e}", 500)

    # read the produced file
    try:
        with open(res["output_geojson"], "r", encoding="utf-8") as f:
            fc = json.load(f)
    except Exception as e:
        return _bad(f"failed reading result: {e}", 500)

    # final name: replace leading 'segment_' with 'classify_'
    base = segment_id
    if base.startswith("segment_"):
        base = base[len("segment_"):]
    out_name = f"classify_{base}.geojson"
    out_path = CLASSIFY_DIR / out_name

    # save final file (simple overwrite)
    try:
        out_path.write_text(json.dumps(fc), encoding="utf-8")
    except Exception as e:
        return _bad(f"failed saving result: {e}", 500)

    # (optional) clean the temp file written by classification.py
    try:
        if os.path.exists(res["output_geojson"]) and os.path.abspath(res["output_geojson"]) != os.path.abspath(out_path):
            os.remove(res["output_geojson"])
    except Exception:
        pass

    return _ok({"geojson": fc, "geojson_url": f"/results/classify/{out_name}"})



ALLOWED_DELETE_EXTS = (".geojson", ".json", ".tif", ".tiff", ".png", ".jpg", ".jpeg")
RASTER_EXTS = (".tif", ".tiff", ".png", ".jpg", ".jpeg")

@app.post("/delete")
async def delete_file(request: Request, name: str = Form(None)):
    if name is None:
        if "application/json" in (request.headers.get("content-type") or ""):
            data = await request.json()
            name = str(data.get("name", "")).strip()
        else:
            name = (request.query_params.get("name") or "").strip()

    if not name:
        return _bad("name is required", 400)

    base = os.path.basename(name)
    root, ext = os.path.splitext(base)
    ext_ok = ext and ext.lower() in ALLOWED_DELETE_EXTS
    candidates = [base] if ext_ok else [base + e for e in ALLOWED_DELETE_EXTS]

    # scan: results/* (one level), uploads/ and uploads/* (one level)
    scan_dirs: list[Path] = []
    if RESULTS.exists() and RESULTS.is_dir():
        for sub in RESULTS.iterdir():
            if sub.is_dir():
                scan_dirs.append(sub)
    if UPLOADS.exists() and UPLOADS.is_dir():
        scan_dirs.append(UPLOADS)
        for sub in UPLOADS.iterdir():
            if sub.is_dir():
                scan_dirs.append(sub)

    removed = []
    deleted_upload_raster_names = set()

    for d in scan_dirs:
        for cand in candidates:
            p = d / cand  # exact, case-sensitive
            if p.is_file():
                logger.info("scan dir %s", p)
                p.unlink()
                removed.append(str(p))
                if str(p).startswith(str(UPLOADS)) and p.suffix.lower() in RASTER_EXTS:
                    deleted_upload_raster_names.add(p.name)

    # prune uploads/_raster.json if we deleted any rasters from uploads
    if deleted_upload_raster_names:
        db_path = UPLOADS / "_rasters.json"
        if db_path.exists():
            db = json.loads(db_path.read_text(encoding="utf-8"))
            items = db.get("items", [])
            keep = []
            for it in items:
                it_name = str(it.get("name", ""))
                it_base = os.path.basename(str(it.get("path", "")))
                if (it_name in deleted_upload_raster_names) or (it_base in deleted_upload_raster_names):
                    continue
                keep.append(it)
            if len(keep) != len(items):
                db["items"] = keep
                db_path.write_text(json.dumps(db, indent=2), encoding="utf-8")

    if not removed:
        return _bad("file not found", 404)

    return _ok({"removed": removed})

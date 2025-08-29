# backend/obia/segmentation.py
from __future__ import annotations
from pathlib import Path
import json
from copy import deepcopy

from nickyspatial import read_raster, LayerManager, SlicSegmentation, layer_to_vector

def run_slic_segmentation(raster_path: str, scale: float, compactness: float, layer_name="Solar_OBIA_Segments"):
    image_array, transform, crs = read_raster(raster_path)
    manager = LayerManager()
    segmenter = SlicSegmentation(scale=scale, compactness=compactness)
    seg_layer = segmenter.execute(
        image_array,
        transform,
        crs,
        layer_manager=manager,
        layer_name=layer_name,
    )
    return seg_layer

def layer_to_geojson(seg_layer):
    gdf = seg_layer.objects.to_crs(epsg=4326)
    return json.loads(gdf.to_json())

def save_geojson(seg_layer, out_path: str | Path):
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    export_layer = deepcopy(seg_layer)
    export_layer.objects = export_layer.objects.to_crs(epsg=4326)
    export_layer.crs = "EPSG:4326"
    layer_to_vector(export_layer, output_path=str(out_path))
    return str(out_path)

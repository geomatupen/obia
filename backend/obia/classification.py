# classification.py
import os
import json
import geopandas as gpd
from typing import Optional, Dict, Any, Tuple

from nickyspatial.core.layer import Layer, LayerManager
from nickyspatial.core.classifier import SupervisedClassifier


def _paths_from_segment_id(results_dir: str, segment_id: str) -> Tuple[str, str]:
    seg_path = os.path.join(results_dir, "segments", f"{segment_id}.geojson")
    samples_path = os.path.join(results_dir, "samples", f"{segment_id}.json")
    return seg_path, samples_path


def _load_samples(samples_json_path: str) -> Dict[str, Any]:
    with open(samples_json_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    # Use only the 'samples' key if present
    if isinstance(payload, dict) and "samples" in payload:
        return payload["samples"]
    return payload


def _classifier_config(method: str, user_params: Optional[Dict[str, Any]]) -> Tuple[str, Dict[str, Any]]:
    m = (method or "").strip().lower()
    if m in {"rf", "randomforest", "random_forest", "random-forest"}:
        classifier_type = "Random Forest"
        params = {"n_estimators": 100, "oob_score": True, "random_state": 42}
    elif m in {"svm", "svc"}:
        classifier_type = "SVC"
        params = {"kernel": "rbf", "C": 1.0, "gamma": "scale", "probability": False}
    elif m in {"knn", "k-nn", "knearest", "k-nearest"}:
        classifier_type = "KNN"
        params = {"n_neighbors": 5}
    else:
        raise ValueError("Unsupported method. Use one of: rf | svm | knn")

    if user_params:
        params.update(user_params)
    return classifier_type, params


def classify(
    segment_id: str,
    method: str,
    results_dir: str,
    classified_dir: str,
    classifier_params: Optional[Dict[str, Any]] = None,
    source_layer_name: str = "SegmentLayer",
    result_layer_name: str = "Classification",
    class_field: str = "classification",
):
    """
    Combined RF / SVM / KNN classification exactly like your originals, routed by `method`.
    Uses:
      - segments:  results/segments/{segment_id}.geojson
      - samples :  results/samples/{segment_id}.json  (uses ['samples'] key)
    Writes:
      - output  :  {classified_dir}/{segment_id}.geojson
    Returns:
      (result_layer, accuracy, feature_importances, output_geojson)
    """
    segment_geojson_path, samples_json_path = _paths_from_segment_id(results_dir, segment_id)

    if not os.path.isfile(segment_geojson_path):
        raise FileNotFoundError(f"Segment not found: {segment_geojson_path}")
    if not os.path.isfile(samples_json_path):
        raise FileNotFoundError(f"Samples not found: {samples_json_path}")

    # Load inputs
    gdf = gpd.read_file(segment_geojson_path)
    samples = _load_samples(samples_json_path)

    # Prepare NickySpatial layer & manager
    layer = Layer(name=source_layer_name, type="segmentation")
    layer.objects = gdf
    manager = LayerManager()
    manager.add_layer(layer)

    # Pick classifier type + params (your defaults)
    classifier_type, params = _classifier_config(method, classifier_params)

    # Create and run classifier
    clf = SupervisedClassifier(
        name=f"{classifier_type}_Classifier",
        classifier_type=classifier_type,
        classifier_params=params,
    )

    result_layer, accuracy, feature_importances = clf.execute(
        source_layer=layer,
        samples=samples,
        layer_manager=manager,
        layer_name=result_layer_name,
    )

    # Save output GeoJSON
    os.makedirs(classified_dir, exist_ok=True)
    output_geojson = os.path.join(classified_dir, f"{segment_id}_classified.geojson")
    if hasattr(result_layer, "objects") and result_layer.objects is not None:
        result_layer.objects.to_file(output_geojson, driver="GeoJSON")
    else:
        raise RuntimeError("Classification returned an empty result layer.")

    return {
        "segment_id": segment_id,
        "method": method,
        "accuracy": float(accuracy) if accuracy is not None else None,
        "output_geojson": output_geojson,
    }

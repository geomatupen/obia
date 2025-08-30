from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
from shapely.validation import make_valid
import geopandas as gpd
import pandas as pd
from nickyspatial.core.layer import Layer
from nickyspatial import plot_classification

def merge_clean_polygons(layer_obj, class_column="classification", target_class="all", area_attr="area_pixels"):
    """
    Merge polygons of the same class while avoiding artifacts and invalid geometries.
    Cleans geometries before creating the final Layer.
    """
    gdf = layer_obj.objects.copy()

    if gdf.empty or class_column not in gdf.columns:
        print(f"Invalid input: empty GeoDataFrame or missing '{class_column}' column.")
        return layer_obj.copy()

    result_rows = []

    if target_class == "all":
        class_values = gdf[class_column].dropna().unique()

        for cls in class_values:
            class_subset = gdf[gdf[class_column] == cls].copy()
            if class_subset.empty:
                continue

            unioned = unary_union(class_subset.geometry)

            if isinstance(unioned, Polygon):
                result_rows.append({"classification": cls, "geometry": Polygon(unioned.exterior)})
            elif isinstance(unioned, MultiPolygon):
                for poly in unioned.geoms:
                    result_rows.append({"classification": cls, "geometry": Polygon(poly.exterior)})

        final_gdf = gpd.GeoDataFrame(result_rows, crs=gdf.crs)

    else:
        target_gdf = gdf[gdf[class_column] == target_class].copy()
        non_target_gdf = gdf[gdf[class_column] != target_class].copy()

        if target_gdf.empty:
            print(f"No features found for class '{target_class}'.")
            return layer_obj.copy()

        unioned = unary_union(target_gdf.geometry)

        cleaned_geoms = []
        if isinstance(unioned, Polygon):
            cleaned_geoms = [Polygon(unioned.exterior)]
        elif isinstance(unioned, MultiPolygon):
            cleaned_geoms = [Polygon(p.exterior) for p in unioned.geoms]

        cleaned_target = gpd.GeoDataFrame({
            class_column: [target_class] * len(cleaned_geoms),
            "geometry": cleaned_geoms
        }, crs=gdf.crs)

        final_gdf = pd.concat([cleaned_target, non_target_gdf], ignore_index=True)

    # Clean geometries and remove invalid ones
    cleaned_geoms = []
    for geom in final_gdf.geometry:
        try:
            if not geom.is_valid:
                geom = make_valid(geom)
            geom = geom.buffer(0)
            if isinstance(geom, (Polygon, MultiPolygon)):
                cleaned_geoms.append(geom)
            else:
                cleaned_geoms.append(None)
        except Exception:
            cleaned_geoms.append(None)

    final_gdf["geometry"] = cleaned_geoms
    final_gdf = final_gdf.dropna(subset=["geometry"])

    if area_attr in gdf.columns:
        final_gdf[area_attr] = final_gdf.geometry.area

    new_layer = Layer(name=f"{layer_obj.name}_merged", parent=layer_obj, type=layer_obj.type)
    new_layer.objects = final_gdf
    new_layer.crs = layer_obj.crs
    new_layer.transform = layer_obj.transform
    new_layer.metadata = layer_obj.metadata.copy()

    try:
        if class_column in final_gdf.columns:
            plot_classification(new_layer, class_field=class_column)
        else:
            new_layer.objects["__dummy__"] = "merged"
            plot_classification(new_layer, class_field="__dummy__")
    except Exception as e:
        print(f"[WARNING] Plotting failed: {e}")

    return new_layer

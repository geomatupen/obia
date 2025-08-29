import rasterio
from rasterio.enums import Resampling

def downsample_raster(input_path, output_path, factor):
    """
    Downsample a raster by a given factor and save to a new file.
    
    Parameters:
        input_path (str): Path to the input orthophoto.
        output_path (str): Path where the downsampled raster will be saved.
        factor (int or float): Downsampling factor. E.g., 4 means image becomes 1/4 the size.
    """
    with rasterio.open(input_path) as src:
        # Calculate new dimensions
        new_width = int(src.width / factor)
        new_height = int(src.height / factor)

        # Read data with new shape
        data = src.read(
            out_shape=(
                src.count,
                new_height,
                new_width
            ),
            resampling=Resampling.bilinear
        )

        # Scale the transform accordingly
        transform = src.transform * src.transform.scale(
            src.width / new_width,
            src.height / new_height
        )

        # Write to output
        profile = src.profile
        profile.update({
            'height': new_height,
            'width': new_width,
            'transform': transform
        })

        with rasterio.open(output_path, 'w', **profile) as dst:
            dst.write(data)
            print("saved file")

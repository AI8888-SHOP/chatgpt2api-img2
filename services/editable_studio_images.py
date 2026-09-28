import base64
import binascii
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps
from services.editable_studio_store import failure


def save_images(items, destination: Path, settings, kind):
    maximum = 1 if kind == "psd" else settings.max_reference_images
    if len(items) > maximum or (kind == "psd" and len(items) != 1):
        failure(422, "PSD 每任务需要一张原图" if kind == "psd" else "参考图数量超限")
    result = []
    for index, value in enumerate(items):
        try:
            payload = value.split(",",1)[1] if value.startswith("data:") else value
            if len(payload) > settings.max_image_mb*1024*1024*4//3+16:
                failure(413, "图片文件过大")
            raw = base64.b64decode(payload, validate=True)
            if len(raw) > settings.max_image_mb*1024*1024:
                failure(413, "图片文件过大")
            with Image.open(BytesIO(raw)) as image:
                if image.format not in ("PNG","JPEG","WEBP") or getattr(image,"n_frames",1) != 1:
                    failure(422, "仅支持静态 PNG、JPEG、WebP 图片")
                w,h = image.size
                if w*h > settings.max_image_pixels or min(w,h)<16:
                    failure(413, "图片像素过多或尺寸过小")
                image.load()
                normalized = ImageOps.exif_transpose(image).convert("RGBA")
                destination.mkdir(parents=True,exist_ok=True,mode=0o700)
                path = destination/f"reference-{index+1}.png"
                normalized.save(path)
                result.append(path)
        except (binascii.Error,ValueError,OSError,Image.DecompressionBombError):
            failure(422, "无法读取图片，请上传有效的静态图片")
    return result

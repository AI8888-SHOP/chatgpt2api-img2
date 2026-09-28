from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from services.generated_image_paths import GENERATED_IMAGES_DIR, GENERATED_IMAGES_URL_PREFIX
from services.generated_image_cache_service import generated_image_cache_service

MAX_STORED_IMAGE_BYTES = 25 * 1024 * 1024
ALLOWED_IMAGE_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


@dataclass(frozen=True)
class StoredGeneratedImage:
    path: Path
    url: str


def ensure_generated_images_dir() -> Path:
    GENERATED_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    return GENERATED_IMAGES_DIR


def guess_image_extension(image_data: bytes, content_type: str = "") -> str:
    normalized_content_type = str(content_type or "").lower().split(";", 1)[0].strip()
    if normalized_content_type == "image/jpeg":
        return ".jpg"
    if normalized_content_type == "image/webp":
        return ".webp"
    if normalized_content_type == "image/gif":
        return ".gif"
    if normalized_content_type == "image/png":
        return ".png"

    if image_data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if image_data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if image_data.startswith(b"RIFF") and image_data[8:12] == b"WEBP":
        return ".webp"
    if image_data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    return ".png"


def save_generated_image(image_data: bytes, content_type: str = "") -> StoredGeneratedImage:
    if not image_data:
        raise ValueError("image data is required")
    if len(image_data) > MAX_STORED_IMAGE_BYTES:
        raise ValueError("image data is too large")
    normalized_content_type = str(content_type or "").lower().split(";", 1)[0].strip()
    if normalized_content_type and normalized_content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise ValueError("unsupported image content type")

    root_dir = ensure_generated_images_dir()
    date_path = datetime.utcnow().strftime("%Y/%m/%d")
    target_dir = root_dir / date_path
    target_dir.mkdir(parents=True, exist_ok=True)

    file_name = f"{uuid.uuid4().hex}{guess_image_extension(image_data, content_type)}"
    target_path = target_dir / file_name
    target_path.write_bytes(image_data)

    stored_image = StoredGeneratedImage(
        path=target_path,
        url=f"{GENERATED_IMAGES_URL_PREFIX}/{date_path}/{file_name}",
    )
    generated_image_cache_service.record_image(
        url=stored_image.url,
        created_at=int(datetime.utcnow().timestamp()),
        content_type=content_type,
    )
    return stored_image

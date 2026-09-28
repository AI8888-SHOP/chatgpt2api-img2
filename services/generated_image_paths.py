from __future__ import annotations

from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
GENERATED_IMAGES_DIR = BASE_DIR / "data" / "generated-images"
GENERATED_IMAGES_URL_PREFIX = "/generated-images"

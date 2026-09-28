"""
上游 API 图片代理服务
替代号池，直接调用上游 OpenAI 兼容 API 生图
"""
from __future__ import annotations

import base64
import binascii
from itertools import count
from threading import Lock
import time

import requests
from urllib.parse import urlsplit, urlunsplit

from services.config import config
from services.image_service import ImageGenerationError
from services.user_image_storage import save_generated_image
from services.generated_image_cache_service import generated_image_cache_service

TIMEOUT = 300.0  # 生图可能很慢，给 5 分钟
MAX_UPSTREAM_IMAGE_BYTES = 25 * 1024 * 1024
ALLOWED_IMAGE_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
GROK_IMAGE_MODEL = "grok-imagine-image"
GROK_IMAGE_EDIT_MODEL = "grok-imagine-image-edit"
GROK_GENERATION_SIZES = (
    ("1024x1024", 1.0),
    ("1792x1024", 3 / 2),
    ("1024x1792", 2 / 3),
    ("1280x720", 16 / 9),
    ("720x1280", 9 / 16),
)
_UPSTREAM_COUNTER = count()
_UPSTREAM_LOCK = Lock()
_UPSTREAM_COOLDOWNS: dict[str, float] = {}


def _upstream_key(upstream: dict[str, object]) -> str:
    return f"{upstream.get('name', '')}|{upstream.get('base_url', '')}|{upstream.get('model', '')}"


def _cooldown_upstream(upstream: dict[str, object], reason: str) -> None:
    seconds = config.image_upstream_cooldown_secs
    if seconds <= 0:
        return
    with _UPSTREAM_LOCK:
        _UPSTREAM_COOLDOWNS[_upstream_key(upstream)] = time.time() + seconds
    print(f"[upstream-image] cooldown name={upstream.get('name')} seconds={seconds} reason={reason}")


def is_upstream_image_model(model: object) -> bool:
    requested = str(model or "").strip().lower()
    if requested in {GROK_IMAGE_MODEL, GROK_IMAGE_EDIT_MODEL}:
        return True
    # Treat configured enabled image models as upstream routes. This keeps
    # gpt-image-2 from falling through to the local account pool.
    return any(
        str(item.get("model") or "").strip().lower() == requested
        for item in config.get_enabled_image_upstreams()
    )


def is_grok_image_model(model: object) -> bool:
    return str(model or "").strip().lower() in {GROK_IMAGE_MODEL, GROK_IMAGE_EDIT_MODEL}


def _choose_upstream(model: str = "") -> dict[str, object]:
    upstreams = config.get_enabled_image_upstreams()
    if not upstreams:
        raise ImageGenerationError("image upstream is not configured")
    requested_model = str(model or "").strip().lower()
    if requested_model:
        configured_model = GROK_IMAGE_MODEL if requested_model == GROK_IMAGE_EDIT_MODEL else requested_model
        upstreams = [
            upstream
            for upstream in upstreams
            if str(upstream.get("model") or "").strip().lower() == configured_model
        ]
        if not upstreams:
            raise ImageGenerationError(f"image upstream is not configured for model: {requested_model}")
    with _UPSTREAM_LOCK:
        now = time.time()
        available = [u for u in upstreams if _UPSTREAM_COOLDOWNS.get(_upstream_key(u), 0) <= now]
        if not available:
            available = upstreams
        return available[next(_UPSTREAM_COUNTER) % len(available)]


def _normalize_grok_generation_size(size: str) -> str:
    value = str(size or "").strip().lower()
    supported = {item[0] for item in GROK_GENERATION_SIZES}
    if value in supported:
        return value
    try:
        width_text, height_text = value.split("x", 1)
        ratio = int(width_text) / int(height_text)
    except (TypeError, ValueError, ZeroDivisionError):
        return "1024x1024"
    return min(GROK_GENERATION_SIZES, key=lambda item: abs(item[1] - ratio))[0]


def _get_client(upstream: dict[str, object], *, json_content_type: bool = True) -> requests.Session:
    headers = {
        "Authorization": f"Bearer {str(upstream.get('api_key') or '')}",
    }
    if json_content_type:
        headers["Content-Type"] = "application/json"
    client = requests.Session()
    client.headers.update(headers)
    return client


def _upstream_url(upstream: dict[str, object], path: str) -> str:
    return f"{str(upstream.get('base_url') or '').rstrip('/')}/{path.lstrip('/')}"


def _record_cache(url: str, content_type: str, prompt: str, metadata: dict[str, str] | None = None) -> None:
    """记录图片缓存元数据"""
    try:
        meta = metadata or {}
        generated_image_cache_service.record_image(
            url=url,
            created_at=int(time.time()),
            content_type=content_type,
            prompt=prompt,
            model=str(meta.get("model") or ""),
            action=str(meta.get("action") or "image_generate"),
            api_key=str(meta.get("api_key") or ""),
            api_key_name=str(meta.get("api_key_name") or ""),
        )
    except Exception as exc:
        print(f"[upstream-image] cache record fail error={exc}")


def _normalize_image_content_type(value: str) -> str:
    return str(value or "").lower().split(";", 1)[0].strip()


def _resolve_image_url(url: str, upstream: dict[str, object] | None = None) -> tuple[str, dict[str, str]]:
    parsed = urlsplit(url)
    if upstream and parsed.hostname in {"127.0.0.1", "localhost", "0.0.0.0"}:
        base = urlsplit(str(upstream.get("base_url") or ""))
        if base.scheme and base.netloc:
            resolved = urlunsplit((base.scheme, base.netloc, parsed.path, parsed.query, parsed.fragment))
            return resolved, {"Authorization": f"Bearer {str(upstream.get('api_key') or '')}"}
    return url, {}


def _download_image_limited(
    url: str,
    upstream: dict[str, object] | None = None,
) -> tuple[bytes, str]:
    resolved_url, headers = _resolve_image_url(url, upstream)
    with requests.get(
        resolved_url,
        headers=headers,
        timeout=120,
        allow_redirects=True,
        stream=True,
    ) as response:
        response.raise_for_status()
        content_type = _normalize_image_content_type(response.headers.get("content-type", "image/png"))
        if content_type and content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
            raise ImageGenerationError(f"unsupported upstream image content type: {content_type}")
        expected_length = int(response.headers.get("content-length") or 0)
        if expected_length > MAX_UPSTREAM_IMAGE_BYTES:
            raise ImageGenerationError("upstream image is too large")
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_UPSTREAM_IMAGE_BYTES:
                raise ImageGenerationError("upstream image is too large")
            chunks.append(chunk)
        return b"".join(chunks), content_type or "image/png"


def _process_upstream_images(
    image_items: list,
    prompt: str,
    metadata: dict[str, str] | None = None,
    upstream: dict[str, object] | None = None,
) -> list[dict]:
    """处理上游返回的图片（b64_json 或 url），存到本地"""
    stored_items = []
    for item in image_items:
        if not isinstance(item, dict):
            continue

        # 优先处理 b64_json
        if item.get("b64_json"):
            try:
                raw_b64 = str(item["b64_json"] or "")
                if len(raw_b64) > MAX_UPSTREAM_IMAGE_BYTES * 2:
                    raise ImageGenerationError("upstream image is too large")
                img_data = base64.b64decode(raw_b64, validate=True)
                if len(img_data) > MAX_UPSTREAM_IMAGE_BYTES:
                    raise ImageGenerationError("upstream image is too large")
                stored = save_generated_image(img_data, "image/png")
                stored_items.append({
                    "url": stored.url,
                    "revised_prompt": item.get("revised_prompt", prompt),
                })
                _record_cache(stored.url, "image/png", prompt, metadata)
                continue
            except (binascii.Error, ValueError, ImageGenerationError) as exc:
                print(f"[upstream-image] b64 decode fail error={exc}")

        # 处理 URL
        if item.get("url"):
            url = str(item["url"])
            try:
                image_data, content_type = _download_image_limited(url, upstream)
                stored = save_generated_image(image_data, content_type)
                stored_items.append({
                    "url": stored.url,
                    "revised_prompt": item.get("revised_prompt", prompt),
                })
                _record_cache(stored.url, content_type, prompt, metadata)
                continue
            except Exception as exc:
                print(f"[upstream-image] download fail url={url[:80]} error={exc}")

        # 兜底：直接返回原始数据
        stored_items.append(item)

    return stored_items


def generate_image_upstream(
    prompt: str,
    n: int = 1,
    quality: str = "auto",
    size: str = "auto",
    output_format: str = "png",
    output_compression: int = 0,
    moderation: str = "auto",
    metadata: dict[str, str] | None = None,
    model: str = "",
    _attempt: int = 0,
) -> dict:
    """调用上游 API 生成图片 POST /v1/images/generations"""
    prompt = str(prompt or "").strip()
    if not prompt:
        raise ImageGenerationError("prompt is required")

    upstream = _choose_upstream(model)
    upstream_model = str(upstream.get("model") or "gpt-image-2")
    record_metadata = {
        **(metadata or {}),
        "model": upstream_model,
        "upstream_name": str(upstream.get("name") or ""),
    }

    # 构建请求体
    body: dict = {
        "prompt": prompt,
        "model": upstream_model,
        "n": n,
    }
    if upstream_model == GROK_IMAGE_MODEL:
        body["size"] = _normalize_grok_generation_size(size)
        body["response_format"] = "url"
    else:
        if quality and quality != "auto":
            body["quality"] = quality
        if size and size != "auto":
            body["size"] = size
        if output_format:
            body["output_format"] = output_format
        if output_compression > 0:
            body["output_compression"] = output_compression
        if moderation and moderation != "auto":
            body["moderation"] = moderation

    print(
        f"[upstream-image] generate upstream={upstream.get('name')} "
        f"base={upstream.get('base_url')} prompt={prompt[:60]}... n={n} quality={quality} size={size}"
    )

    try:
        with _get_client(upstream) as client:
            resp = client.post(
                _upstream_url(upstream, "/images/generations"),
                json=body,
                timeout=TIMEOUT,
            )
            resp.raise_for_status()
    except requests.HTTPError as exc:
        error_detail = ""
        try:
            body = exc.response.json() if exc.response is not None else {}
            error_detail = body.get("error", {}).get("message", "") if isinstance(body.get("error"), dict) else str(body.get("error", ""))
        except Exception:
            error_detail = exc.response.text[:200] if exc.response is not None else str(exc)
        status_code = exc.response.status_code if exc.response is not None else "unknown"
        msg = f"upstream API error {status_code}: {error_detail}"
        print(f"[upstream-image] fail {msg}")
        if "insufficient_balance" in msg.lower() or "insufficient account balance" in msg.lower():
            _cooldown_upstream(upstream, "insufficient_balance")
        if _attempt < 2:
            return generate_image_upstream(prompt, n, quality, size, output_format, output_compression, moderation, metadata, model, _attempt + 1)
        raise ImageGenerationError(msg) from exc
    except requests.RequestException as exc:
        msg = f"upstream API request failed: {exc}"
        print(f"[upstream-image] fail {msg}")
        if _attempt < 2:
            return generate_image_upstream(prompt, n, quality, size, output_format, output_compression, moderation, metadata, model, _attempt + 1)
        raise ImageGenerationError(msg) from exc

    data = resp.json()
    image_items = data.get("data") or []
    stored_items = _process_upstream_images(image_items, prompt, record_metadata, upstream)

    if not stored_items:
        raise ImageGenerationError("upstream API returned no images")

    return {
        "created": data.get("created", int(time.time())),
        "data": stored_items,
    }


def edit_image_upstream(
    prompt: str,
    images: list[tuple[bytes, str, str]],
    n: int = 1,
    metadata: dict[str, str] | None = None,
    model: str = "",
    _attempt: int = 0,
) -> dict:
    """调用上游 API 编辑图片 POST /v1/images/edits (multipart)"""
    prompt = str(prompt or "").strip()
    if not prompt:
        raise ImageGenerationError("prompt is required")
    if not images:
        raise ImageGenerationError("image is required")

    upstream = _choose_upstream(model)
    configured_model = str(upstream.get("model") or "gpt-image-2")
    upstream_model = GROK_IMAGE_EDIT_MODEL if configured_model == GROK_IMAGE_MODEL else configured_model
    record_metadata = {
        **(metadata or {}),
        "model": upstream_model,
        "upstream_name": str(upstream.get("name") or ""),
    }

    print(
        f"[upstream-image] edit upstream={upstream.get('name')} "
        f"base={upstream.get('base_url')} prompt={prompt[:60]}... images={len(images)} n={n}"
    )

    try:
        with _get_client(upstream, json_content_type=False) as client:
            files = []
            file_field = "image[]" if upstream_model == GROK_IMAGE_EDIT_MODEL else "image"
            for image_data, file_name, mime_type in images:
                files.append((file_field, (file_name, image_data, mime_type)))

            resp = client.post(
                _upstream_url(upstream, "/images/edits"),
                data={
                    "prompt": prompt,
                    "model": upstream_model,
                    "n": str(n),
                    "size": "1024x1024",
                    "response_format": "url",
                },
                files=files,
                timeout=TIMEOUT,
            )
            resp.raise_for_status()
    except requests.HTTPError as exc:
        error_detail = ""
        try:
            body = exc.response.json() if exc.response is not None else {}
            error_detail = body.get("error", {}).get("message", "") if isinstance(body.get("error"), dict) else str(body.get("error", ""))
        except Exception:
            error_detail = exc.response.text[:200] if exc.response is not None else str(exc)
        status_code = exc.response.status_code if exc.response is not None else "unknown"
        msg = f"upstream API error {status_code}: {error_detail}"
        print(f"[upstream-image] edit fail {msg}")
        if "insufficient_balance" in msg.lower() or "insufficient account balance" in msg.lower():
            _cooldown_upstream(upstream, "insufficient_balance")
        if _attempt < 2:
            return edit_image_upstream(prompt, images, n, metadata, model, _attempt + 1)
        raise ImageGenerationError(msg) from exc
    except requests.RequestException as exc:
        msg = f"upstream API request failed: {exc}"
        print(f"[upstream-image] edit fail {msg}")
        if _attempt < 2:
            return edit_image_upstream(prompt, images, n, metadata, model, _attempt + 1)
        raise ImageGenerationError(msg) from exc

    data = resp.json()
    image_items = data.get("data") or []
    stored_items = _process_upstream_images(image_items, prompt, record_metadata, upstream)

    if not stored_items:
        raise ImageGenerationError("upstream API returned no images")

    return {
        "created": data.get("created", int(time.time())),
        "data": stored_items,
    }

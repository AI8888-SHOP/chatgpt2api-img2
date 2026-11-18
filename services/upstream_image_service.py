"""
上游 API 图片代理服务
替代号池，直接调用上游 OpenAI 兼容 API 生图
"""
from __future__ import annotations

import base64
import binascii
from io import BytesIO
from PIL import Image
from itertools import count
from threading import Lock
import time

import requests
from urllib.parse import urlsplit, urlunsplit

from services.config import config
from services.image_service import ImageGenerationError, ImageSubmissionUnknownError
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
    print(f"[upstream-image] cooldown seconds={seconds} reason={reason}")


def is_upstream_image_model(model: object) -> bool:
    requested = str(model or "").strip().lower()
    if requested in {GROK_IMAGE_MODEL, GROK_IMAGE_EDIT_MODEL}:
        return True
    # A disabled upstream must not silently fall through to the account pool.
    return any(requested in _upstream_models(item) for item in config.get_image_upstreams())


def is_grok_image_model(model: object) -> bool:
    return str(model or "").strip().lower() in {GROK_IMAGE_MODEL, GROK_IMAGE_EDIT_MODEL}


def _upstream_models(upstream: dict[str, object]) -> set[str]:
    raw = upstream.get("models")
    values = raw if isinstance(raw, list) else [upstream.get("model")]
    return {str(value or "").strip().lower() for value in values if str(value or "").strip()}


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
            if configured_model in _upstream_models(upstream)
        ]
        if not upstreams:
            raise ImageGenerationError(f"image upstream is not configured for model: {requested_model}")
    with _UPSTREAM_LOCK:
        now = time.time()
        available = [u for u in upstreams if _UPSTREAM_COOLDOWNS.get(_upstream_key(u), 0) <= now]
        if not available:
            available = upstreams
        return available[next(_UPSTREAM_COUNTER) % len(available)]


def _model_for_upstream(upstream: dict[str, object], requested: str = "") -> str:
    requested_model = str(requested or "").strip()
    supported = _upstream_models(upstream)
    if requested_model and requested_model.lower() in supported:
        return requested_model
    raw = upstream.get("models")
    values = raw if isinstance(raw, list) else [upstream.get("model")]
    return str(next((value for value in values if str(value or "").strip()), "gpt-image-2")).strip()


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


def _record_cache(url: str, content_type: str, prompt: str, metadata: dict[str, str] | None = None, *, image_data: bytes = b"") -> None:
    """记录图片缓存元数据"""
    try:
        meta = metadata or {}
        image_spec = {key: str(meta[key]) for key in ("requested_size", "sent_size", "requested_format") if key in meta}
        if image_data:
            with Image.open(BytesIO(image_data)) as image:
                image_spec.update(actual_width=image.width, actual_height=image.height, actual_format=str(image.format).lower(), frames=getattr(image, "n_frames", 1))
        generated_image_cache_service.record_image(
            url=url,
            created_at=int(time.time()),
            content_type=content_type,
            prompt=prompt,
            model=str(meta.get("model") or ""),
            action=str(meta.get("action") or "image_generate"),
            api_key=str(meta.get("api_key") or ""),
            api_key_name=str(meta.get("api_key_name") or ""),
            image_spec=image_spec,
        )
    except Exception as exc:
        raise ImageGenerationError("图片缓存元数据保存失败") from exc


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
        if content_type and content_type not in ALLOWED_IMAGE_CONTENT_TYPES | {"application/octet-stream"}:
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
    output_format: str = "",
) -> list[dict]:
    """Validate the whole batch before publishing files; roll back on save failure."""
    prepared = []
    for item in image_items:
        if not isinstance(item, dict):
            raise ImageGenerationError("上游图片结果结构无效")
        error = ImageGenerationError("上游未返回可验证的图片")
        if item.get("b64_json"):
            try:
                raw_b64 = str(item["b64_json"] or "")
                if len(raw_b64) > MAX_UPSTREAM_IMAGE_BYTES * 2:
                    raise ImageGenerationError("upstream image is too large")
                img_data = base64.b64decode(raw_b64, validate=True)
                if len(img_data) > MAX_UPSTREAM_IMAGE_BYTES:
                    raise ImageGenerationError("upstream image is too large")
                content_type = _verified_image_type(img_data, output_format)
                prepared.append((img_data, content_type, item))
                continue
            except (binascii.Error, ValueError, ImageGenerationError) as exc:
                error = exc if isinstance(exc, ImageGenerationError) else ImageGenerationError("上游图片 Base64 无效")
        if item.get("url"):
            url = str(item["url"])
            try:
                image_data, content_type = _download_image_limited(url, upstream)
                content_type = _verified_image_type(image_data, output_format)
                prepared.append((image_data, content_type, item))
                continue
            except Exception as exc:
                error = exc if isinstance(exc, ImageGenerationError) else ImageGenerationError("上游图片下载失败")
        raise error

    saved = []
    stored_items = []
    try:
        for image_data, content_type, item in prepared:
            stored = save_generated_image(image_data, content_type, record_cache=False)
            saved.append(stored)
            _record_cache(stored.url, content_type, prompt, metadata, image_data=image_data)
            stored_items.append({"url": stored.url, "revised_prompt": item.get("revised_prompt", prompt)})
        return stored_items
    except Exception as exc:
        try:
            generated_image_cache_service.forget_images([stored.url for stored in saved])
        finally:
            for stored in saved:
                stored.path.unlink(missing_ok=True)
        raise ImageGenerationError("图片批次保存失败，已撤销本批次成品") from exc


def _verified_image_type(data: bytes, requested: str = "") -> str:
    try:
        with Image.open(BytesIO(data)) as image:
            actual = str(image.format or "").lower()
            if actual == "gif":
                if image.n_frames > 1000:
                    raise ValueError("too many GIF frames")
                image.seek(image.n_frames - 1)
                image.load()
            else:
                image.verify()
    except Exception as exc:
        raise ImageGenerationError("上游图片数据无效") from exc
    mime = "image/" + actual
    if mime not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise ImageGenerationError("不支持的上游图片格式")
    if requested == "gif" and actual != "gif":
        raise ImageGenerationError("请求 GIF，但上游未返回真实 GIF 图片")
    return mime


def _validate_output_format(model: str, output_format: str) -> None:
    if output_format not in {"png", "jpeg", "webp", "gif"}:
        raise ImageGenerationError("不支持的图片格式")
    if output_format == "gif" and model.lower() != "gpt-image-2.6":
        raise ImageGenerationError("GIF 仅向 gpt-image-2.6 上游请求，其他模型暂不支持")


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
) -> dict:
    """调用上游 API 生成图片 POST /v1/images/generations"""
    prompt = str(prompt or "").strip()
    if not prompt:
        raise ImageGenerationError("prompt is required")

    upstream = _choose_upstream(model)
    # This request owns metadata. Update it on every attempt so usage records
    # retain the final selected upstream even when the request raises.
    if metadata is not None:
        metadata["upstream_name"] = str(upstream.get("name") or "未命名上游")[:200]
    upstream_model = _model_for_upstream(upstream, model)
    _validate_output_format(upstream_model, output_format)
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

    record_metadata.update(requested_size=size, sent_size=str(body.get("size", "")), requested_format=output_format)
    print(f"[upstream-image] generate model={upstream_model} n={n} quality={quality} size={size}")

    try:
        with _get_client(upstream) as client:
            resp = client.post(
                _upstream_url(upstream, "/images/generations"),
                json=body,
                timeout=TIMEOUT,
                allow_redirects=False,
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
        safe_detail = str(error_detail or "").lower()
        print(f"[upstream-image] generate rejected status={status_code}")
        if "insufficient_balance" in safe_detail or "insufficient account balance" in safe_detail:
            _cooldown_upstream(upstream, "insufficient_balance")
        if not isinstance(status_code, int) or status_code >= 500 or status_code == 408:
            raise ImageSubmissionUnknownError("图片生成结果待核对，请稍后查看任务状态") from exc
        raise ImageGenerationError("上游拒绝了图片生成请求，请检查参数后重试") from exc
    except requests.RequestException as exc:
        print(f"[upstream-image] generate transport outcome=unknown error_type={type(exc).__name__}")
        raise ImageSubmissionUnknownError("图片生成结果待核对，请稍后查看任务状态") from exc

    try:
        data = resp.json()
    except Exception as exc:
        raise ImageSubmissionUnknownError("图片生成结果待核对，请稍后查看任务状态") from exc
    try:
        image_items = data.get("data") or []
        if not isinstance(image_items, list):
            raise ValueError("invalid images response")
        stored_items = _process_upstream_images(image_items, prompt, record_metadata, upstream, output_format)
    except Exception as exc:
        raise ImageSubmissionUnknownError("图片结果未能验证或保存，请联系管理员核对") from exc

    if not stored_items:
        raise ImageSubmissionUnknownError("图片生成结果待核对，请稍后查看任务状态")

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
    *,
    size: str = "auto",
    output_format: str = "png",
) -> dict:
    """调用上游 API 编辑图片 POST /v1/images/edits (multipart)"""
    prompt = str(prompt or "").strip()
    if not prompt:
        raise ImageGenerationError("prompt is required")
    if not images:
        raise ImageGenerationError("image is required")

    upstream = _choose_upstream(model)
    if metadata is not None:
        metadata["upstream_name"] = str(upstream.get("name") or "未命名上游")[:200]
    configured_model = _model_for_upstream(upstream, model)
    upstream_model = GROK_IMAGE_EDIT_MODEL if configured_model == GROK_IMAGE_MODEL else configured_model
    _validate_output_format(upstream_model, output_format)
    fields = {"prompt": prompt, "model": upstream_model, "n": str(n), "response_format": "url"}
    if upstream_model == GROK_IMAGE_EDIT_MODEL:
        fields["size"] = _normalize_grok_generation_size(size)
    else:
        if size and size != "auto":
            fields["size"] = size
        fields["output_format"] = output_format
    record_metadata = {
        **(metadata or {}),
        "model": upstream_model,
        "upstream_name": str(upstream.get("name") or ""),
    }

    record_metadata.update(requested_size=size, sent_size=str(fields.get("size", "")), requested_format=output_format)
    print(f"[upstream-image] edit model={upstream_model} images={len(images)} n={n}")

    try:
        with _get_client(upstream, json_content_type=False) as client:
            files = []
            file_field = "image[]" if upstream_model == GROK_IMAGE_EDIT_MODEL else "image"
            for image_data, file_name, mime_type in images:
                files.append((file_field, (file_name, image_data, mime_type)))

            resp = client.post(
                _upstream_url(upstream, "/images/edits"),
                data=fields,
                files=files,
                timeout=TIMEOUT,
                allow_redirects=False,
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
        safe_detail = str(error_detail or "").lower()
        print(f"[upstream-image] edit rejected status={status_code}")
        if "insufficient_balance" in safe_detail or "insufficient account balance" in safe_detail:
            _cooldown_upstream(upstream, "insufficient_balance")
        if not isinstance(status_code, int) or status_code >= 500 or status_code == 408:
            raise ImageSubmissionUnknownError("图片编辑结果待核对，请稍后查看任务状态") from exc
        raise ImageGenerationError("上游拒绝了图片编辑请求，请检查参数后重试") from exc
    except requests.RequestException as exc:
        print(f"[upstream-image] edit transport outcome=unknown error_type={type(exc).__name__}")
        raise ImageSubmissionUnknownError("图片编辑结果待核对，请稍后查看任务状态") from exc

    try:
        data = resp.json()
    except Exception as exc:
        raise ImageSubmissionUnknownError("图片编辑结果待核对，请稍后查看任务状态") from exc
    try:
        image_items = data.get("data") or []
        if not isinstance(image_items, list):
            raise ValueError("invalid images response")
        stored_items = _process_upstream_images(image_items, prompt, record_metadata, upstream, output_format)
    except Exception as exc:
        raise ImageSubmissionUnknownError("图片结果未能验证或保存，请联系管理员核对") from exc

    if not stored_items:
        raise ImageSubmissionUnknownError("图片编辑结果待核对，请稍后查看任务状态")

    return {
        "created": data.get("created", int(time.time())),
        "data": stored_items,
    }

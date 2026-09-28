from __future__ import annotations

import asyncio
import json
import smtplib
from contextlib import asynccontextmanager
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path
import secrets
from threading import Event, Lock, Thread
import time
import uuid
from typing import Any, Iterator, Literal
from fastapi import APIRouter, Cookie, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from admin.api import router as admin_router
from admin.api_key_service import init_default_admin_key
from services.account_service import account_service
from services.api_key_service import api_key_service
from services.chatgpt_service import ChatGPTService
from services.config import ConfigSaveError, DATA_DIR, config
from services.prompt_optimizer_service import (
    OptimizerLimits, PromptOptimizerService, read_optimizer_request, require_optimizer_session,
)
from services.content_filter import check_request
from services.cpa_service import cpa_config, cpa_import_service, list_remote_files
from services.editable_file_task_service import editable_file_task_service
from services.editable_studio_service import StudioService
from services.editable_studio_models import PlanRequest, GenerateRequest
from services.proxy_service import test_proxy
from services.protocol import openai_v1_chat_complete, openai_v1_models, openai_v1_response
from services.register_service import (
    ensure_auto_register_min_quota,
    gptfree_register_service,
    new_register_service,
    register_service,
)
from services.usage_service import UsageRecord, usage_service
from services.user_service import user_service
from services.ui_trial_service import get_trial, update_trial, trial_stats
from services.sub2api_service import (
    list_remote_accounts as sub2api_list_remote_accounts,
    list_remote_groups as sub2api_list_remote_groups,
    sub2api_config,
    sub2api_import_service,
)
from services.utils import extract_chat_prompt, extract_response_prompt, parse_image_count


from services.image_service import ImageGenerationError
from services.generated_image_cache_service import generated_image_cache_service
from services.user_image_storage import GENERATED_IMAGES_DIR, ensure_generated_images_dir
from services.version import get_app_version
from utils.helper import (
    has_response_image_generation_tool as protocol_has_response_image_generation_tool,
    is_image_chat_request as protocol_is_image_chat_request,
    parse_image_count as protocol_parse_image_count,
)

BASE_DIR = Path(__file__).resolve().parents[1]
WEB_DIST_DIR = BASE_DIR / "web_dist"


class UiTrialRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    variant: Literal['a', 'b'] | None = None
    preference: Literal['a', 'b', 'equal'] | None = None


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    model: str = "auto"
    n: int = Field(default=1, ge=1, le=4)
    quality: str = Field(default="auto", description="auto/low/medium/high")
    size: str = Field(default="auto", description="auto/1024x1024/1024x1536/1536x1024/4096x4096等")
    output_format: str = Field(default="png", description="png/jpeg/webp")
    output_compression: int = Field(default=0, ge=0, le=100, description="压缩率0-100")
    moderation: str = Field(default="auto", description="auto/low")
    response_format: str = "url"
    history_disabled: bool = True
    client_conversation_id: str = ""
    client_image_id: str = ""


class AccountCreateRequest(BaseModel):
    tokens: list[str] = Field(default_factory=list)


class AccountDeleteRequest(BaseModel):
    tokens: list[str] = Field(default_factory=list)


class AccountRefreshRequest(BaseModel):
    access_tokens: list[str] = Field(default_factory=list)


class AccountUpdateRequest(BaseModel):
    access_token: str = Field(default="")
    type: str | None = None
    status: str | None = None
    quota: int | None = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str | None = None
    prompt: str | None = None
    n: int | None = None
    stream: bool | None = None
    modalities: list[str] | None = None
    messages: list[dict[str, object]] | None = None


class ResponseCreateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str | None = None
    input: object | None = None
    instructions: object | None = None
    tools: list[dict[str, object]] | None = None
    tool_choice: object | None = None
    stream: bool | None = None


class EditableFileTaskRequest(BaseModel):
    prompt: str = ""
    base64_images: list[str] = Field(default_factory=list)
    client_task_id: str | None = None


class ImageJobResumeRequest(BaseModel):
    extra_timeout_secs: int = Field(default=60, ge=5, le=300)


class CPAPoolCreateRequest(BaseModel):
    name: str = ""
    base_url: str = ""
    secret_key: str = ""


class CPAPoolUpdateRequest(BaseModel):
    name: str | None = None
    base_url: str | None = None
    secret_key: str | None = None


class CPAImportRequest(BaseModel):
    names: list[str] = Field(default_factory=list)


class SettingsUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")


class RegisterConfigRequest(BaseModel):
    mail: dict | None = None
    proxy: str | None = None
    total: int | None = None
    threads: int | None = None
    mode: str | None = None
    target_quota: int | None = None
    target_available: int | None = None
    check_interval: int | None = None
    enabled: bool | None = None
    auto_register_enabled: bool | None = None
    auto_register_min_quota: int | None = None
    engine: str | None = None
    codex: dict | None = None
    default_password: str | None = None


class OutlookPoolResetRequest(BaseModel):
    scope: str | None = None



class Sub2APIServerCreateRequest(BaseModel):
    name: str = ""
    base_url: str = ""
    email: str = ""
    password: str = ""
    api_key: str = ""
    group_id: str = ""


class Sub2APIServerUpdateRequest(BaseModel):
    name: str | None = None
    base_url: str | None = None
    email: str | None = None
    password: str | None = None
    api_key: str | None = None
    group_id: str | None = None


class Sub2APIImportRequest(BaseModel):
    account_ids: list[str] = Field(default_factory=list)


class ProxyUpdateRequest(BaseModel):
    enabled: bool | None = None
    url: str | None = None


class ProxyTestRequest(BaseModel):
    url: str = ""


class UserRegisterRequest(BaseModel):
    email: str = ""
    password: str = ""
    verification_code: str = ""
    invite_code: str = ""


class EmailVerificationRequest(BaseModel):
    email: str = ""


class UserLoginRequest(BaseModel):
    email: str = ""
    password: str = ""


class RedeemCodeRequest(BaseModel):
    code: str = ""


class UserApiKeyCreateRequest(BaseModel):
    name: str = ""


class UserApiKeyUpdateRequest(BaseModel):
    name: str | None = None
    enabled: bool | None = None


class UserImageConversationRequest(BaseModel):
    conversation: dict = Field(default_factory=dict)


_IMAGE_JOBS_LOCK = Lock()
_IMAGE_JOB_TTL_SECONDS = 72 * 60 * 60
_IMAGE_JOBS_PATH = DATA_DIR / "image_jobs.json"
_IMAGE_JOB_SECRET_FIELDS = {"resume_access_token", "resume_device_id"}
_REGISTER_EVENT_TOKENS: dict[str, float] = {}
_REGISTER_EVENT_TOKENS_LOCK = Lock()
_REGISTER_EVENT_TOKEN_TTL_SECONDS = 3600
MAX_UPLOAD_IMAGE_BYTES = 25 * 1024 * 1024
MAX_UPLOAD_IMAGE_TOTAL_BYTES = 60 * 1024 * 1024
ALLOWED_UPLOAD_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


def _stored_image_job(job: dict[str, object]) -> dict[str, object]:
    item = {key: value for key, value in job.items() if key not in _IMAGE_JOB_SECRET_FIELDS}
    if item.get("can_resume") is True:
        item["can_resume"] = False
    return item


def _load_image_jobs() -> dict[str, dict[str, object]]:
    if not _IMAGE_JOBS_PATH.exists():
        return {}
    try:
        raw = json.loads(_IMAGE_JOBS_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[image-jobs] failed to load persisted jobs: {exc}")
        return {}

    source = raw.get("jobs") if isinstance(raw, dict) else raw
    if not isinstance(source, list):
        return {}

    cutoff = time.time() - _IMAGE_JOB_TTL_SECONDS
    jobs: dict[str, dict[str, object]] = {}
    for item in source:
        if not isinstance(item, dict):
            continue
        job_id = str(item.get("id") or item.get("job_id") or "").strip()
        api_key = str(item.get("api_key") or "").strip()
        if not job_id or not api_key:
            continue
        try:
            updated_at = float(item.get("updated_at") or item.get("created_at") or 0)
        except (TypeError, ValueError):
            updated_at = 0
        if updated_at and updated_at < cutoff:
            continue
        job = dict(item)
        job["id"] = job_id
        job["api_key"] = api_key
        job["can_resume"] = False
        for field in _IMAGE_JOB_SECRET_FIELDS:
            job.pop(field, None)
        jobs[job_id] = job
    return jobs


_IMAGE_JOBS: dict[str, dict[str, object]] = _load_image_jobs()


def _save_image_jobs_locked() -> None:
    try:
        _IMAGE_JOBS_PATH.parent.mkdir(parents=True, exist_ok=True)
        items = sorted(
            (_stored_image_job(job) for job in _IMAGE_JOBS.values()),
            key=lambda item: float(item.get("updated_at") or item.get("created_at") or 0),
            reverse=True,
        )
        tmp_path = _IMAGE_JOBS_PATH.with_suffix(_IMAGE_JOBS_PATH.suffix + ".tmp")
        tmp_path.write_text(json.dumps({"jobs": items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(_IMAGE_JOBS_PATH)
    except Exception as exc:
        print(f"[image-jobs] failed to save persisted jobs: {exc}")


def _cleanup_image_jobs() -> None:
    cutoff = time.time() - _IMAGE_JOB_TTL_SECONDS
    with _IMAGE_JOBS_LOCK:
        expired = [
            job_id
            for job_id, job in _IMAGE_JOBS.items()
            if float(job.get("updated_at") or job.get("created_at") or 0) < cutoff
        ]
        for job_id in expired:
            _IMAGE_JOBS.pop(job_id, None)
        if expired:
            _save_image_jobs_locked()


def _public_image_job(job_id: str, job: dict[str, object]) -> dict[str, object]:
    return {
        "job_id": job_id,
        "status": job.get("status") or "pending",
        "result": job.get("result"),
        "error": job.get("error") or "",
        "progress": job.get("progress") or "",
        "progress_text": job.get("progress_text") or "",
        "can_resume": job.get("can_resume") is True,
        "conversation_id": job.get("conversation_id") or "",
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
        "client_conversation_id": job.get("client_conversation_id") or "",
        "client_image_id": job.get("client_image_id") or "",
    }


def _list_user_image_jobs(api_key, *, client_conversation_id: str = "", limit: int = 200) -> list[dict[str, object]]:
    _cleanup_image_jobs()
    conversation_id = str(client_conversation_id or "").strip()
    max_items = max(1, min(500, int(limit or 200)))
    with _IMAGE_JOBS_LOCK:
        items = [
            _public_image_job(job_id, job)
            for job_id, job in _IMAGE_JOBS.items()
            if job.get("api_key") == api_key.key
            and (not conversation_id or str(job.get("client_conversation_id") or "") == conversation_id)
        ]
    items.sort(key=lambda item: float(item.get("updated_at") or item.get("created_at") or 0), reverse=True)
    return items[:max_items]


def _create_image_job(api_key, *, client_conversation_id: str = "", client_image_id: str = "") -> str:
    _cleanup_image_jobs()
    job_id = uuid.uuid4().hex
    now = time.time()
    with _IMAGE_JOBS_LOCK:
        _IMAGE_JOBS[job_id] = {
            "id": job_id,
            "api_key": api_key.key,
            "status": "pending",
            "created_at": now,
            "updated_at": now,
            "result": None,
            "error": "",
            "progress": "queued",
            "progress_text": "排队中",
            "can_resume": False,
            "client_conversation_id": str(client_conversation_id or "").strip(),
            "client_image_id": str(client_image_id or "").strip(),
        }
        _save_image_jobs_locked()
    return job_id


def _image_progress_text(step: object) -> str:
    value = str(step or "").strip()
    base = value.split(":", 1)[0]
    return {
        "queued": "排队中",
        "running": "准备生成",
        "waiting_for_image_slot": "排队等待生成通道",
        "getting_account": "获取可用账号",
        "warming_up_session": "预热会话",
        "uploading_reference_image": "上传参考图",
        "getting_requirements": "获取生图令牌",
        "solving_proof": "计算校验令牌",
        "generating_image": "提交生图请求",
        "waiting_for_image_task": "等待图片任务生成",
        "polling_image_result": "轮询图片结果",
        "receiving_image": "下载图片结果",
        "success": "生成完成",
        "error": "生成失败",
    }.get(base, value or "处理中")


def _update_image_job_progress(job_id: str, step: str) -> None:
    _update_image_job(job_id, progress=step, progress_text=_image_progress_text(step))


def _update_image_job(job_id: str, **updates: object) -> None:
    with _IMAGE_JOBS_LOCK:
        job = _IMAGE_JOBS.get(job_id)
        if not job:
            return
        job.update(updates)
        job["updated_at"] = time.time()
        _save_image_jobs_locked()


def _get_image_job(job_id: str) -> dict[str, object] | None:
    _cleanup_image_jobs()
    with _IMAGE_JOBS_LOCK:
        job = _IMAGE_JOBS.get(job_id)
        return dict(job) if job else None


def _recover_unfinished_image_jobs() -> int:
    recovered = 0
    now = time.time()
    with _IMAGE_JOBS_LOCK:
        for job in _IMAGE_JOBS.values():
            if str(job.get("status") or "") not in {"pending", "running"}:
                continue
            job["status"] = "error"
            job["error"] = "服务已重启，未完成的生成任务已中断"
            job["can_resume"] = False
            job["progress"] = "error"
            job["progress_text"] = _image_progress_text("error")
            job["updated_at"] = now
            for field in _IMAGE_JOB_SECRET_FIELDS:
                job.pop(field, None)
            recovered += 1
        if recovered:
            _save_image_jobs_locked()
    return recovered



def build_model_item(model_id: str) -> dict[str, object]:
    return {
        "id": model_id,
        "object": "model",
        "created": 0,
        "owned_by": "chatgpt2api",
    }


def sanitize_cpa_pool(pool: dict | None) -> dict | None:
    if not isinstance(pool, dict):
        return None
    return {
        key: value
        for key, value in pool.items()
        if key != "secret_key"
    }


def sanitize_cpa_pools(pools: list[dict]) -> list[dict]:
    return [sanitized for pool in pools if (sanitized := sanitize_cpa_pool(pool)) is not None]


_SUB2API_HIDDEN_FIELDS = {"password", "api_key"}


def sanitize_sub2api_server(server: dict | None) -> dict | None:
    if not isinstance(server, dict):
        return None
    sanitized = {key: value for key, value in server.items() if key not in _SUB2API_HIDDEN_FIELDS}
    sanitized["has_api_key"] = bool(str(server.get("api_key") or "").strip())
    return sanitized


def sanitize_sub2api_servers(servers: list[dict]) -> list[dict]:
    return [sanitized for server in servers if (sanitized := sanitize_sub2api_server(server)) is not None]


def extract_bearer_token(authorization: str | None) -> str:
    scheme, _, value = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return ""
    return value.strip()


def require_auth_key(authorization: str | None) -> None:
    token = extract_bearer_token(authorization)
    _, separator, token_value = token.partition("|")
    admin_key = token_value.strip() if separator else token
    if admin_key == str(config.auth_key or "").strip():
        return
    raise HTTPException(status_code=401, detail={"error": "authorization is invalid"})


def require_user(authorization: str | None):
    token = extract_bearer_token(authorization)
    user = user_service.get_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail={"error": "user session is invalid"})
    return token, user


def normalize_email(value: str) -> str:
    return str(value or "").strip().lower()


def get_email_domain(value: str) -> str:
    email = normalize_email(value)
    _, separator, domain = email.rpartition("@")
    return domain if separator else ""


def register_email_verification_enabled() -> bool:
    return config.get().get("register_email_verification_enabled") is True


def invite_registration_enabled() -> bool:
    return config.get().get("invite_registration_enabled") is not False


def invite_reward_amounts() -> tuple[int, int]:
    current = config.get()
    try:
        inviter_amount = int(current.get("invite_inviter_quota") if current.get("invite_inviter_quota") is not None else 10)
    except (TypeError, ValueError):
        inviter_amount = 10
    try:
        invited_amount = int(current.get("invite_invited_quota") if current.get("invite_invited_quota") is not None else 10)
    except (TypeError, ValueError):
        invited_amount = 10
    return max(0, inviter_amount), max(0, invited_amount)


def get_register_email_domain_whitelist() -> list[str]:
    raw = config.get().get("register_email_domain_whitelist")
    if isinstance(raw, list):
        items = raw
    else:
        items = str(raw or "").replace("\n", ",").split(",")
    return [str(item or "").strip().lower().lstrip("@") for item in items if str(item or "").strip()]


def ensure_register_email_domain_allowed(email: str) -> None:
    allowed_domains = get_register_email_domain_whitelist()
    if not allowed_domains:
        return
    domain = get_email_domain(email)
    if domain not in allowed_domains:
        raise HTTPException(status_code=400, detail={"error": "该邮箱域名不在注册白名单内"})


def send_registration_email_code(email: str, code: str) -> None:
    current = config.get()
    host = str(current.get("smtp_host") or "").strip()
    try:
        port = int(current.get("smtp_port") or 587)
    except (TypeError, ValueError):
        port = 587
    username = str(current.get("smtp_username") or "").strip()
    password = str(current.get("smtp_password") or "")
    from_email = str(current.get("smtp_from_email") or username).strip()
    from_name = str(current.get("smtp_from_name") or "").strip() or "注册验证"
    tls_enabled = current.get("smtp_tls_enabled") is not False
    if not host or not port or not from_email:
        raise HTTPException(status_code=400, detail={"error": "SMTP 未配置完整，无法发送验证码"})

    message = EmailMessage()
    message["Subject"] = "注册邮箱验证码"
    message["From"] = formataddr((from_name, from_email))
    message["To"] = email
    message.set_content(f"你的注册验证码是：{code}\n\n验证码 10 分钟内有效。如非本人操作，请忽略本邮件。")

    try:
        smtp_factory = smtplib.SMTP_SSL if tls_enabled and port == 465 else smtplib.SMTP
        with smtp_factory(host, port, timeout=15) as smtp:
            smtp.ehlo()
            if tls_enabled and port != 465:
                smtp.starttls()
                smtp.ehlo()
            if username or password:
                smtp.login(username, password)
            smtp.send_message(message)
    except Exception as exc:
        raise HTTPException(status_code=502, detail={"error": f"SMTP 发送失败：{str(exc)[:200]}"}) from exc


def log_user_usage(
    user,
    *,
    action: str,
    prompt: str,
    model: str,
    status: str,
    started_at: float,
    error: str = "",
    usage_amount: int = 0,
) -> None:
    usage_service.log(UsageRecord.create(
        api_key=user.id,
        api_key_name=user.email,
        action=action,
        prompt=prompt,
        model=model,
        status=status,
        error=error,
        duration_ms=int((datetime.now().timestamp() - started_at) * 1000),
    ))


def build_image_cache_metadata(user, *, action: str, model: str = "") -> dict[str, str]:
    return {
        "action": action,
        "api_key": f"{user.id[:12]}***",
        "api_key_name": str(user.email or ""),
        "model": model,
    }


def require_user_quota(user, amount: int) -> None:
    if user.remaining() < max(1, int(amount or 1)):
        raise HTTPException(status_code=402, detail={"error": "用户积分不足，请先兑换积分"})


def reserve_user_quota(user, amount: int, *, action: str, model: str) -> dict[str, object]:
    amount = max(1, int(amount or 1))
    reservation = user_service.reserve_quota(
        user.id,
        amount,
        action=action,
        model=model,
        metadata={"action": action, "model": model},
    )
    if not reservation:
        raise HTTPException(status_code=402, detail={"error": "用户积分不足，请先兑换积分"})
    return reservation


def settle_user_quota_reservation(reservation: dict[str, object], actual_amount: int, *, action: str, model: str) -> int:
    return user_service.settle_quota_reservation(
        str(reservation.get("id") or ""),
        actual_amount,
        metadata={"action": action, "model": model, "reserved": reservation.get("amount"), "actual": actual_amount},
    )


def refund_user_quota_reservation(reservation: dict[str, object], *, action: str, model: str, error: str = "") -> None:
    reservation_id = str(reservation.get("id") or "")
    if not reservation_id:
        return
    user_service.refund_quota_reservation(
        reservation_id,
        reason="refund_failed",
        metadata={"action": action, "model": model, "error": str(error or "")[:500]},
    )


def _is_iterator_result(value: object) -> bool:
    return hasattr(value, "__iter__") and not isinstance(value, (dict, list, str, bytes, bytearray))


def _settle_protocol_success(user, reservation: dict[str, object], *, action: str, prompt: str, model: str, started_at: float, amount: int) -> None:
    usage_amount = settle_user_quota_reservation(reservation, amount, action=action, model=model)
    log_user_usage(
        user,
        action=action,
        prompt=prompt,
        model=model,
        status="success",
        started_at=started_at,
        usage_amount=usage_amount,
    )


def _refund_protocol_failure(user, reservation: dict[str, object], *, action: str, prompt: str, model: str, started_at: float, error: object) -> None:
    message = str(error or "")
    refund_user_quota_reservation(reservation, action=action, model=model, error=message)
    log_user_usage(
        user,
        action=action,
        prompt=prompt,
        model=model,
        status="failed",
        started_at=started_at,
        error=message,
    )


async def _call_openai_protocol(
    *,
    user,
    payload: dict[str, Any],
    handler,
    action: str,
    prompt: str,
    model: str,
    charge_amount: int,
):
    started_at = datetime.now().timestamp()
    if prompt:
        await run_in_threadpool(check_request, prompt)
    reservation = reserve_user_quota(user, charge_amount, action=action, model=model)
    try:
        result = await run_in_threadpool(handler, payload)
    except HTTPException as exc:
        _refund_protocol_failure(user, reservation, action=action, prompt=prompt, model=model, started_at=started_at, error=exc.detail)
        raise
    except Exception as exc:
        _refund_protocol_failure(user, reservation, action=action, prompt=prompt, model=model, started_at=started_at, error=exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

    if _is_iterator_result(result):
        def stream() -> Iterator[str]:
            yield ": stream-open\n\n"
            try:
                for item in result:
                    yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                _settle_protocol_success(user, reservation, action=action, prompt=prompt, model=model, started_at=started_at, amount=charge_amount)
            except Exception as exc:
                _refund_protocol_failure(user, reservation, action=action, prompt=prompt, model=model, started_at=started_at, error=exc)
                payload = {"error": {"message": str(exc), "type": exc.__class__.__name__}}
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")

    amount = charge_amount if isinstance(result, dict) else 0
    _settle_protocol_success(user, reservation, action=action, prompt=prompt, model=model, started_at=started_at, amount=amount)
    return result


async def read_upload_file_limited(upload: UploadFile) -> tuple[bytes, str, str]:
    file_name = upload.filename or "image.png"
    mime_type = (upload.content_type or "image/png").lower().split(";", 1)[0].strip()
    if mime_type not in ALLOWED_UPLOAD_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail={"error": "unsupported image file type"})
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail={"error": "image file is too large"})
        chunks.append(chunk)
    if total <= 0:
        raise HTTPException(status_code=400, detail={"error": "image file is empty"})
    return b"".join(chunks), file_name, mime_type


def start_limited_account_watcher(stop_event: Event) -> Thread:
    interval_seconds = max(1, config.refresh_account_interval_minute) * 60

    def worker() -> None:
        while not stop_event.is_set():
            try:
                if config.auto_remove_abnormal_accounts:
                    result = account_service.remove_abnormal_accounts()
                    if result.get("removed"):
                        print(f"[account-limited-watcher] removed {result.get('removed')} abnormal accounts")
                limited_tokens = account_service.list_limited_tokens()
                if limited_tokens:
                    print(f"[account-limited-watcher] checking {len(limited_tokens)} limited accounts")
                    account_service.refresh_accounts(limited_tokens)
            except Exception as exc:
                print(f"[account-limited-watcher] fail {exc}")
            stop_event.wait(interval_seconds)

    thread = Thread(target=worker, name="limited-account-watcher", daemon=True)
    thread.start()
    return thread


def start_quota_reservation_watcher(stop_event: Event) -> Thread:
    def worker() -> None:
        while not stop_event.is_set():
            try:
                refunded = user_service.refund_expired_quota_reservations()
                if refunded:
                    print(f"[quota-reservation] refunded {refunded} expired reservations")
            except Exception as exc:
                print(f"[quota-reservation] watcher fail {exc}")
            stop_event.wait(60)

    thread = Thread(target=worker, name="quota-reservation-watcher", daemon=True)
    thread.start()
    return thread


def start_auto_register_watcher(stop_event: Event) -> Thread:
    def worker() -> None:
        while not stop_event.is_set():
            try:
                current = register_service.get()
                if current.get("auto_register_enabled") is not False:
                    min_quota = max(1, int(current.get("auto_register_min_quota") or 200))
                    ensure_auto_register_min_quota(min_quota)
            except Exception as exc:
                print(f"[auto-register-reference] watcher fail {exc}")
            stop_event.wait(60)

    thread = Thread(target=worker, name="auto-register-watcher", daemon=True)
    thread.start()
    return thread


def resolve_web_asset(requested_path: str) -> Path | None:
    if not WEB_DIST_DIR.exists():
        return None

    clean_path = requested_path.strip("/")
    if not clean_path:
        candidates = [WEB_DIST_DIR / "index.html"]
    else:
        relative_path = Path(clean_path)
        candidates = [
            WEB_DIST_DIR / relative_path,
            WEB_DIST_DIR / relative_path / "index.html",
            WEB_DIST_DIR / f"{clean_path}.html",
        ]

    for candidate in candidates:
        try:
            candidate.relative_to(WEB_DIST_DIR)
        except ValueError:
            continue
        if candidate.is_file():
            return candidate

    return None


def create_app() -> FastAPI:
    chatgpt_service = ChatGPTService()
    app_version = get_app_version()
    studio = StudioService(config, user_service, DATA_DIR / "editable_studio")
    init_default_admin_key()
    recovered_image_jobs = _recover_unfinished_image_jobs()
    if recovered_image_jobs:
        print(f"[image-jobs] recovered {recovered_image_jobs} unfinished jobs on startup")
    refunded_reservations = user_service.refund_pending_quota_reservations()
    if refunded_reservations:
        print(f"[quota-reservation] refunded {refunded_reservations} pending reservations on startup")

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        reservation_thread = start_quota_reservation_watcher(stop_event)
        auto_register_thread = start_auto_register_watcher(stop_event)
        studio.start()
        try:
            yield
        finally:
            stop_event.set()
            studio.stop()
            thread.join(timeout=1)
            reservation_thread.join(timeout=1)
            auto_register_thread.join(timeout=1)

    app = FastAPI(title="chatgpt2api", version=app_version, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    ensure_generated_images_dir()
    generated_image_cache_service.prune_expired()
    app.mount("/generated-images", StaticFiles(directory=GENERATED_IMAGES_DIR), name="generated-images")
    app.mount("/images", StaticFiles(directory=config.images_dir), name="images")
    router = APIRouter()
    prompt_optimizer = PromptOptimizerService(OptimizerLimits(DATA_DIR / "prompt_optimizer_limits.db"))

    def studio_user(authorization):
        token = extract_bearer_token(authorization)
        if not token.startswith("usr_"):
            raise HTTPException(403, detail={"error":"文档工作室仅支持网页登录，不支持 API Key 调用"})
        return require_user(authorization)[1]

    studio_uploads = set()

    async def studio_body(request, model, maximum, owner):
        maximum_uploads = min(8, max(2, config.get_studio_settings().global_concurrency * 2))
        if owner in studio_uploads or len(studio_uploads) >= maximum_uploads:
            raise HTTPException(429, detail={"error":"上传繁忙，请稍后重试"}, headers={"Retry-After":"30"})
        studio_uploads.add(owner)
        raw = bytearray()
        try:
            async with asyncio.timeout(30):
                async for chunk in request.stream():
                    if len(raw)+len(chunk)>maximum:
                        raise HTTPException(413,detail={"error":"上传内容过大"})
                    raw.extend(chunk)
        except TimeoutError:
            raise HTTPException(408,detail={"error":"上传超时"}) from None
        finally:
            studio_uploads.discard(owner)
        try:
            return model.model_validate_json(bytes(raw))
        except ValueError:
            raise HTTPException(422,detail={"error":"制作参数无效或内容超限，请检查输入；不允许自定义模型或工具"}) from None

    @router.get("/v1/editable-studio/config")
    async def studio_config(authorization: str | None = Header(default=None)):
        studio_user(authorization)
        return studio.public_config()

    @router.post("/v1/editable-studio/plans")
    async def studio_plan(request: Request, authorization: str | None = Header(default=None)):
        user = studio_user(authorization)
        s = studio.settings()
        body = await studio_body(request,PlanRequest,min(128*1024*1024,s.max_reference_images*s.max_image_mb*1024*1024*4//3+65536),user.id)
        await run_in_threadpool(check_request,body.prompt)
        return await run_in_threadpool(studio.plan,user,body)

    @router.post("/v1/editable-studio/jobs")
    async def studio_submit(request: Request, authorization: str | None = Header(default=None)):
        user = studio_user(authorization)
        body = await studio_body(request,GenerateRequest,256*1024,user.id)
        await run_in_threadpool(check_request,body.plan.model_dump_json())
        return await run_in_threadpool(studio.submit,user,body)

    @router.get("/v1/editable-studio/jobs")
    async def studio_history(authorization: str | None = Header(default=None)):
        user = studio_user(authorization)
        rows = await run_in_threadpool(studio.store.list_jobs,user.id)
        return {"items":[studio.public_job(row) for row in rows]}

    @router.get("/v1/editable-studio/jobs/{job_id}/files/{filename}")
    async def studio_download(job_id: str, filename: str, authorization: str | None = Header(default=None)):
        user = studio_user(authorization)
        path = await run_in_threadpool(studio.file_path,user.id,job_id,filename)
        return FileResponse(path,filename=path.name,headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"})

    @router.get("/api/editable-studio/stats")
    async def studio_stats(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return await run_in_threadpool(studio.store.stats)

    @router.get("/v1/models")
    async def list_models(authorization: str | None = Header(default=None)):
        require_user(authorization)
        try:
            return await run_in_threadpool(openai_v1_models.list_models)
        except Exception:
            return {
                "object": "list",
                "data": [
                    build_model_item(model_id)
                    for model_id in (
                        "gpt-5",
                        "gpt-5.5",
                        *openai_v1_models.DYNAMIC_MODEL_IDS,
                    )
                ],
            }

    @router.post("/auth/login")
    async def login(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"ok": True, "version": app_version}

    @router.post("/auth/register")
    async def register_user(body: UserRegisterRequest):
        if config.get().get("user_registration_enabled") is False:
            raise HTTPException(status_code=403, detail={"error": "当前未开放自助注册，请联系管理员创建账号"})
        ensure_register_email_domain_allowed(body.email)
        if register_email_verification_enabled():
            try:
                user_service.verify_email_code(body.email, body.verification_code)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        invite_code = str(body.invite_code or "").strip()
        if invite_code and invite_registration_enabled() and not user_service.invite_code_exists(invite_code):
            raise HTTPException(status_code=400, detail={"error": "邀请链接无效"})
        try:
            user = user_service.register(
                body.email,
                body.password,
                int(config.get().get("default_user_quota") or 0),
            )
            if invite_code and invite_registration_enabled():
                inviter_amount, invited_amount = invite_reward_amounts()
                user_service.apply_invite_reward(
                    invite_code=invite_code,
                    invited_user_id=user.id,
                    inviter_amount=inviter_amount,
                    invited_amount=invited_amount,
                )
                user = user_service.get_user(user.id) or user
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {"user": user.to_public_dict()}

    @router.get("/auth/register-config")
    async def get_user_register_config():
        current = config.get()
        return {
            "enabled": current.get("user_registration_enabled") is not False,
            "default_user_quota": max(0, int(current.get("default_user_quota") or 0)),
            "email_verification_enabled": current.get("register_email_verification_enabled") is True,
            "email_domain_whitelist": get_register_email_domain_whitelist(),
            "invite_enabled": invite_registration_enabled(),
            "invite_inviter_quota": invite_reward_amounts()[0],
            "invite_invited_quota": invite_reward_amounts()[1],
        }

    @router.post("/auth/register/email-code")
    async def send_user_register_email_code(body: EmailVerificationRequest):
        if config.get().get("user_registration_enabled") is False:
            raise HTTPException(status_code=403, detail={"error": "当前未开放自助注册，请联系管理员创建账号"})
        if not register_email_verification_enabled():
            raise HTTPException(status_code=400, detail={"error": "邮箱验证码未开启"})
        email = normalize_email(body.email)
        if "@" not in email or "." not in email.rsplit("@", 1)[-1]:
            raise HTTPException(status_code=400, detail={"error": "请输入有效邮箱"})
        ensure_register_email_domain_allowed(email)
        code = "".join(secrets.choice("0123456789") for _ in range(6))
        try:
            user_service.create_email_verification_code(email, code, ttl_seconds=600)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        send_registration_email_code(email, code)
        return {"success": True}

    @router.get("/v1/user/invite")
    async def get_user_invite(authorization: str | None = Header(default=None)):
        _, user = require_user(authorization)
        summary = user_service.get_invite_summary(user.id)
        if not summary:
            raise HTTPException(status_code=404, detail={"error": "用户不存在"})
        inviter_amount, invited_amount = invite_reward_amounts()
        return {
            "invite": {
                **summary,
                "enabled": invite_registration_enabled(),
                "inviter_quota": inviter_amount,
                "invited_quota": invited_amount,
            }
        }

    @router.post("/auth/user/login")
    async def login_user(body: UserLoginRequest):
        try:
            token, user = user_service.login(body.email, body.password)
        except ValueError as exc:
            raise HTTPException(status_code=401, detail={"error": str(exc)}) from exc
        return {"token": token, "user": user.to_public_dict()}

    @router.get("/v1/user/ui-trial")
    async def get_user_ui_trial(authorization: str | None = Header(default=None)):
        if not extract_bearer_token(authorization).startswith("usr_"):
            raise HTTPException(status_code=403, detail={"error": "界面试用仅支持网页登录会话"})
        _, user = require_user(authorization)
        return get_trial(user_service, user.id)

    @router.post("/v1/user/ui-trial")
    async def save_user_ui_trial(body: UiTrialRequest, authorization: str | None = Header(default=None)):
        if not extract_bearer_token(authorization).startswith("usr_"):
            raise HTTPException(status_code=403, detail={"error": "界面试用仅支持网页登录会话"})
        _, user = require_user(authorization)
        try:
            return update_trial(user_service, user.id, variant=body.variant, preference=body.preference,
                                update_preference='preference' in body.model_fields_set)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/ui-trial/stats")
    async def get_ui_trial_stats(days: int = 7, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return trial_stats(user_service, days)

    @router.get("/v1/key/info")
    async def get_user_key_info(authorization: str | None = Header(default=None)):
        _, user = require_user(authorization)
        return {
            "name": user.email,
            "email": user.email,
            "total_usage": user.total_usage,
            "remaining": user.remaining(),
            "quota": user.remaining(),
            "expires_at": 0,
            "created_at": user.created_at,
            "enabled": user.enabled,
        }

    @router.post("/v1/key/redeem")
    async def redeem_key(body: RedeemCodeRequest, authorization: str | None = Header(default=None)):
        _, user = require_user(authorization)
        success, error, api_key, amount = api_key_service.prepare_redeem(body.code)
        if not success or not api_key:
            raise HTTPException(status_code=400, detail={"error": error or "兑换失败"})
        metadata = {
            "code": api_key.key,
            "name": api_key.name,
            "package_name": api_key.package_name,
            "batch_code": api_key.batch_code,
        }
        try:
            updated_user = user_service.redeem_code_quota(user.id, api_key.key, amount, metadata=metadata)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        if not updated_user:
            raise HTTPException(status_code=400, detail={"error": "用户不存在"})
        api_key_service.mark_redeemed(api_key.key, user.id)
        return {"success": True, "amount": amount, "user": updated_user.to_public_dict()}

    @router.get("/v1/user/api-keys")
    async def list_user_api_keys(authorization: str | None = Header(default=None)):
        _, user = require_user(authorization)
        return {"api_keys": user_service.list_api_keys(user.id)}

    @router.post("/v1/user/api-keys")
    async def create_user_api_key(body: UserApiKeyCreateRequest, authorization: str | None = Header(default=None)):
        _, user = require_user(authorization)
        result = user_service.create_api_key(user.id, body.name)
        if not result:
            raise HTTPException(status_code=404, detail={"error": "用户不存在"})
        full_key, item = result
        return {"success": True, "key": full_key, "api_key": item}

    @router.put("/v1/user/api-keys/{key}")
    async def update_user_api_key(
            key: str,
            body: UserApiKeyUpdateRequest,
            authorization: str | None = Header(default=None),
    ):
        _, user = require_user(authorization)
        item = user_service.update_api_key(user.id, key, name=body.name, enabled=body.enabled)
        if not item:
            raise HTTPException(status_code=404, detail={"error": "API key not found"})
        return {"success": True, "api_key": item}

    @router.delete("/v1/user/api-keys/{key}")
    async def delete_user_api_key(key: str, authorization: str | None = Header(default=None)):
        _, user = require_user(authorization)
        if not user_service.delete_api_key(user.id, key):
            raise HTTPException(status_code=404, detail={"error": "API key not found"})
        return {"success": True}

    @router.get("/v1/image-conversations")
    async def list_user_image_conversations(
            limit: int = 200,
            offset: int = 0,
            authorization: str | None = Header(default=None),
    ):
        _, user = require_user(authorization)
        return user_service.list_image_conversations(user.id, limit=limit, offset=offset)

    @router.post("/v1/image-conversations")
    async def save_user_image_conversation(
            body: UserImageConversationRequest,
            authorization: str | None = Header(default=None),
    ):
        _, user = require_user(authorization)
        try:
            conversation = user_service.save_image_conversation(user.id, body.conversation)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {"success": True, "conversation": conversation}

    @router.delete("/v1/image-conversations")
    async def clear_user_image_conversations(authorization: str | None = Header(default=None)):
        _, user = require_user(authorization)
        deleted = user_service.clear_image_conversations(user.id)
        return {"success": True, "deleted": deleted}

    @router.delete("/v1/image-conversations/{conversation_id}")
    async def delete_user_image_conversation(conversation_id: str, authorization: str | None = Header(default=None)):
        _, user = require_user(authorization)
        user_service.delete_image_conversation(user.id, conversation_id)
        return {"success": True}

    @router.get("/version")
    async def get_version():
        return {"version": app_version}

    @router.get("/app-config")
    async def get_app_config():
        return {
            "site_title": config.get_site_title(),
            "quick_prompts": config.get_quick_prompts(),
            "psd_task_price": config.psd_task_price,
        }

    @router.get("/api/settings")
    async def get_settings(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"config": config.get()}

    @router.post("/api/settings")
    async def save_settings(
            body: SettingsUpdateRequest,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        try:
            return {"config": config.update(body.model_dump(mode="python"))}
        except ConfigSaveError as exc:
            raise HTTPException(status_code=500, detail={"error": str(exc)}) from exc
        except ValueError:
            raise HTTPException(status_code=400, detail={"error": "提示词优化配置无效，请检查地址、密钥、模型和限额范围"}) from None

    @router.get("/api/accounts")
    async def get_accounts(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"items": account_service.list_accounts()}

    @router.post("/api/accounts")
    async def create_accounts(body: AccountCreateRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        tokens = [str(token or "").strip() for token in body.tokens if str(token or "").strip()]
        if not tokens:
            raise HTTPException(status_code=400, detail={"error": "tokens is required"})
        result = account_service.add_accounts(tokens)
        refresh_result = account_service.refresh_accounts(tokens)
        return {
            **result,
            "refreshed": refresh_result.get("refreshed", 0),
            "errors": refresh_result.get("errors", []),
            "items": refresh_result.get("items", result.get("items", [])),
        }

    @router.delete("/api/accounts")
    async def delete_accounts(body: AccountDeleteRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        tokens = [str(token or "").strip() for token in body.tokens if str(token or "").strip()]
        if not tokens:
            raise HTTPException(status_code=400, detail={"error": "tokens is required"})
        return account_service.delete_accounts(tokens)

    @router.post("/api/accounts/refresh")
    async def refresh_accounts(body: AccountRefreshRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        access_tokens = [str(token or "").strip() for token in body.access_tokens if str(token or "").strip()]
        if not access_tokens:
            access_tokens = account_service.list_tokens()
        if not access_tokens:
            raise HTTPException(status_code=400, detail={"error": "access_tokens is required"})
        return account_service.refresh_accounts(access_tokens)

    @router.post("/api/accounts/update")
    async def update_account(body: AccountUpdateRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        access_token = str(body.access_token or "").strip()
        if not access_token:
            raise HTTPException(status_code=400, detail={"error": "access_token is required"})
        updates = {
            key: value
            for key, value in {
                "type": body.type,
                "status": body.status,
                "quota": body.quota,
            }.items()
            if value is not None
        }
        if not updates:
            raise HTTPException(status_code=400, detail={"error": "no updates provided"})
        account = account_service.update_account(access_token, updates)
        if account is None:
            raise HTTPException(status_code=404, detail={"error": "account not found"})
        return {"item": account, "items": account_service.list_accounts()}

    @router.get("/api/register")
    async def get_register_config(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"register": register_service.get()}

    def new_register_snapshot() -> dict:
        snapshot = new_register_service.get()
        shared = register_service.get()
        for key in (
            "mail",
            "proxy",
            "total",
            "threads",
            "mode",
            "target_quota",
            "target_available",
            "check_interval",
        ):
            if key in shared:
                snapshot[key] = shared[key]
        return snapshot

    def gptfree_register_snapshot() -> dict:
        snapshot = gptfree_register_service.get()
        shared = register_service.get()
        for key in (
            "mail",
            "proxy",
            "total",
            "threads",
            "mode",
            "target_quota",
            "target_available",
            "check_interval",
        ):
            if key in shared:
                snapshot[key] = shared[key]
        return snapshot

    @router.post("/api/register")
    async def update_register_config(body: RegisterConfigRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"register": register_service.update(body.model_dump(exclude_none=True))}

    @router.post("/api/register/start")
    async def start_register(
        body: RegisterConfigRequest | None = None,
        authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        updates = body.model_dump(exclude_none=True) if body is not None else None
        return {"register": register_service.start(updates)}

    @router.post("/api/register/stop")
    async def stop_register(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"register": register_service.stop()}

    @router.post("/api/register/reset")
    async def reset_register(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"register": register_service.reset()}

    @router.post("/api/register/outlook-pool/reset")
    async def reset_outlook_pool(body: OutlookPoolResetRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"register": register_service.reset_outlook_pool(body.scope or "all")}

    @router.post("/api/register/events-token")
    async def create_register_events_token(
        response: Response,
        authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        token = uuid.uuid4().hex
        expires_at = time.time() + _REGISTER_EVENT_TOKEN_TTL_SECONDS
        with _REGISTER_EVENT_TOKENS_LOCK:
            now = time.time()
            expired = [key for key, value in _REGISTER_EVENT_TOKENS.items() if value < now]
            for key in expired:
                _REGISTER_EVENT_TOKENS.pop(key, None)
            _REGISTER_EVENT_TOKENS[token] = expires_at
        response.set_cookie(
            "register_events_token",
            token,
            max_age=_REGISTER_EVENT_TOKEN_TTL_SECONDS,
            httponly=True,
            samesite="lax",
        )
        return {"token": token, "expires_at": expires_at}

    @router.get("/api/register/events")
    async def register_events(token: str = "", register_events_token: str | None = Cookie(default=None)):
        candidate = str(token or "").strip() or str(register_events_token or "").strip()
        with _REGISTER_EVENT_TOKENS_LOCK:
            expires_at = _REGISTER_EVENT_TOKENS.get(candidate, 0)
        if expires_at < time.time():
            raise HTTPException(status_code=401, detail={"error": "event token is invalid"})

        async def stream():
            last = ""
            heartbeat_at = time.monotonic()
            while True:
                payload = json.dumps(register_service.get(), ensure_ascii=False)
                if payload != last:
                    last = payload
                    yield f"data: {payload}\n\n"
                    heartbeat_at = time.monotonic()
                elif time.monotonic() - heartbeat_at >= 15:
                    yield ": keep-alive\n\n"
                    heartbeat_at = time.monotonic()
                await asyncio.sleep(0.5)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @router.get("/api/register/new")
    async def get_new_register_config(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"register": new_register_snapshot()}

    @router.post("/api/register/new/start")
    async def start_new_register(
        body: RegisterConfigRequest | None = None,
        authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        if body is not None:
            register_service.update(body.model_dump(exclude_none=True))
        new_register_service.start(register_service.shared_config_snapshot())
        return {"register": new_register_snapshot()}

    @router.post("/api/register/new/stop")
    async def stop_new_register(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        new_register_service.stop()
        return {"register": new_register_snapshot()}

    @router.post("/api/register/new/reset")
    async def reset_new_register(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        new_register_service.reset()
        return {"register": new_register_snapshot()}

    @router.get("/api/register/new/events")
    async def new_register_events(token: str = "", register_events_token: str | None = Cookie(default=None)):
        candidate = str(token or "").strip() or str(register_events_token or "").strip()
        with _REGISTER_EVENT_TOKENS_LOCK:
            expires_at = _REGISTER_EVENT_TOKENS.get(candidate, 0)
        if expires_at < time.time():
            raise HTTPException(status_code=401, detail={"error": "event token is invalid"})

        async def stream():
            last = ""
            heartbeat_at = time.monotonic()
            while True:
                payload = json.dumps(new_register_snapshot(), ensure_ascii=False)
                if payload != last:
                    last = payload
                    yield f"data: {payload}\n\n"
                    heartbeat_at = time.monotonic()
                elif time.monotonic() - heartbeat_at >= 15:
                    yield ": keep-alive\n\n"
                    heartbeat_at = time.monotonic()
                await asyncio.sleep(0.5)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @router.get("/api/register/gptfree")
    async def get_gptfree_register_config(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"register": gptfree_register_snapshot()}

    @router.post("/api/register/gptfree/start")
    async def start_gptfree_register(
        body: RegisterConfigRequest | None = None,
        authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        if body is not None:
            register_service.update(body.model_dump(exclude_none=True))
        gptfree_register_service.start(register_service.shared_config_snapshot())
        return {"register": gptfree_register_snapshot()}

    @router.post("/api/register/gptfree/stop")
    async def stop_gptfree_register(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        gptfree_register_service.stop()
        return {"register": gptfree_register_snapshot()}

    @router.post("/api/register/gptfree/reset")
    async def reset_gptfree_register(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        gptfree_register_service.reset()
        return {"register": gptfree_register_snapshot()}

    @router.get("/api/register/gptfree/events")
    async def gptfree_register_events(
        token: str = "",
        register_events_token: str | None = Cookie(default=None),
    ):
        candidate = str(token or "").strip() or str(register_events_token or "").strip()
        with _REGISTER_EVENT_TOKENS_LOCK:
            expires_at = _REGISTER_EVENT_TOKENS.get(candidate, 0)
        if expires_at < time.time():
            raise HTTPException(status_code=401, detail={"error": "event token is invalid"})

        async def stream():
            last = ""
            heartbeat_at = time.monotonic()
            while True:
                payload = json.dumps(gptfree_register_snapshot(), ensure_ascii=False)
                if payload != last:
                    last = payload
                    yield f"data: {payload}\n\n"
                    heartbeat_at = time.monotonic()
                elif time.monotonic() - heartbeat_at >= 15:
                    yield ": keep-alive\n\n"
                    heartbeat_at = time.monotonic()
                await asyncio.sleep(0.5)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    def run_generation_job(job_id: str, api_key, body: ImageGenerationRequest) -> None:
        start_time = datetime.now().timestamp()
        job = _get_image_job(job_id) or {}
        reservation = {"id": job.get("reservation_id") or "", "amount": int(job.get("reserved_amount") or body.n)}
        _update_image_job(job_id, status="running", can_resume=False, progress="running", progress_text=_image_progress_text("running"))
        try:
            result = chatgpt_service.generate_with_pool(
                body.prompt,
                body.model,
                body.n,
                build_image_cache_metadata(api_key, action="image_generate", model=body.model),
                quality=body.quality,
                size=body.size,
                output_format=body.output_format,
                output_compression=body.output_compression,
                moderation=body.moderation,
                progress_callback=lambda step: _update_image_job_progress(job_id, step),
            )
            usage_amount = settle_user_quota_reservation(
                reservation,
                len(result.get("data") or []) or body.n,
                action="image_generate",
                model=body.model,
            )
            log_user_usage(
                api_key,
                action="image_generate",
                prompt=body.prompt,
                model=body.model,
                status="success",
                started_at=start_time,
                usage_amount=usage_amount,
            )
            _update_image_job(job_id, status="success", result=result, error="", can_resume=False, progress="success", progress_text=_image_progress_text("success"))
        except ImageGenerationError as exc:
            refund_user_quota_reservation(reservation, action="image_generate", model=body.model, error=str(exc))
            log_user_usage(
                api_key,
                action="image_generate",
                prompt=body.prompt,
                model=body.model,
                status="failed",
                started_at=start_time,
                error=str(exc),
            )
            conversation_id = str(getattr(exc, "conversation_id", "") or "")
            access_token = str(getattr(exc, "access_token", "") or "")
            device_id = str(getattr(exc, "device_id", "") or "")
            can_resume = bool(conversation_id and access_token and "超时" in str(exc))
            _update_image_job(
                job_id,
                status="error",
                error=str(exc),
                can_resume=can_resume,
                conversation_id=conversation_id,
                resume_access_token=access_token,
                resume_device_id=device_id,
                resume_prompt=body.prompt,
                resume_model=body.model,
                progress="error",
                progress_text=_image_progress_text("error"),
            )
        except Exception as exc:
            refund_user_quota_reservation(reservation, action="image_generate", model=body.model, error=str(exc))
            log_user_usage(
                api_key,
                action="image_generate",
                prompt=body.prompt,
                model=body.model,
                status="failed",
                started_at=start_time,
                error=str(exc),
            )
            _update_image_job(job_id, status="error", error=str(exc), can_resume=False, progress="error", progress_text=_image_progress_text("error"))

    def run_edit_job(job_id: str, api_key, prompt: str, images: list[tuple[bytes, str, str]], model: str, n: int) -> None:
        start_time = datetime.now().timestamp()
        job = _get_image_job(job_id) or {}
        reservation = {"id": job.get("reservation_id") or "", "amount": int(job.get("reserved_amount") or n)}
        _update_image_job(job_id, status="running", can_resume=False, progress="running", progress_text=_image_progress_text("running"))
        try:
            result = chatgpt_service.edit_with_pool(
                prompt,
                images,
                model,
                n,
                build_image_cache_metadata(api_key, action="image_edit", model=model),
                progress_callback=lambda step: _update_image_job_progress(job_id, step),
            )
            usage_amount = settle_user_quota_reservation(
                reservation,
                len(result.get("data") or []) or n,
                action="image_edit",
                model=model,
            )
            log_user_usage(
                api_key,
                action="image_edit",
                prompt=prompt,
                model=model,
                status="success",
                started_at=start_time,
                usage_amount=usage_amount,
            )
            _update_image_job(job_id, status="success", result=result, error="", can_resume=False, progress="success", progress_text=_image_progress_text("success"))
        except ImageGenerationError as exc:
            refund_user_quota_reservation(reservation, action="image_edit", model=model, error=str(exc))
            log_user_usage(
                api_key,
                action="image_edit",
                prompt=prompt,
                model=model,
                status="failed",
                started_at=start_time,
                error=str(exc),
            )
            conversation_id = str(getattr(exc, "conversation_id", "") or "")
            access_token = str(getattr(exc, "access_token", "") or "")
            device_id = str(getattr(exc, "device_id", "") or "")
            can_resume = bool(conversation_id and access_token and "超时" in str(exc))
            _update_image_job(
                job_id,
                status="error",
                error=str(exc),
                can_resume=can_resume,
                conversation_id=conversation_id,
                resume_access_token=access_token,
                resume_device_id=device_id,
                resume_prompt=prompt,
                resume_model=model,
                progress="error",
                progress_text=_image_progress_text("error"),
            )
        except Exception as exc:
            refund_user_quota_reservation(reservation, action="image_edit", model=model, error=str(exc))
            log_user_usage(
                api_key,
                action="image_edit",
                prompt=prompt,
                model=model,
                status="failed",
                started_at=start_time,
                error=str(exc),
            )
            _update_image_job(job_id, status="error", error=str(exc), can_resume=False, progress="error", progress_text=_image_progress_text("error"))

    def run_resume_image_job(job_id: str, api_key, extra_timeout_secs: int) -> None:
        job = _get_image_job(job_id) or {}
        prompt = str(job.get("resume_prompt") or "")
        model = str(job.get("resume_model") or "auto")
        access_token = str(job.get("resume_access_token") or "")
        device_id = str(job.get("resume_device_id") or "")
        conversation_id = str(job.get("conversation_id") or "")
        start_time = datetime.now().timestamp()
        reservation: dict[str, object] = {"id": "", "amount": 0}

        _update_image_job(job_id, status="running", error="", can_resume=False, progress="polling_image_result", progress_text=_image_progress_text("polling_image_result"))
        try:
            reservation = reserve_user_quota(api_key, 1, action="image_resume_poll", model=model)
            result = chatgpt_service.resume_image_poll(
                access_token,
                device_id,
                conversation_id,
                prompt=prompt,
                model=model,
                metadata=build_image_cache_metadata(api_key, action="image_resume_poll", model=model),
                timeout_secs=extra_timeout_secs,
                progress_callback=lambda step: _update_image_job_progress(job_id, step),
            )
            usage_amount = settle_user_quota_reservation(
                reservation,
                len(result.get("data") or []) or 1,
                action="image_resume_poll",
                model=model,
            )
            log_user_usage(
                api_key,
                action="image_resume_poll",
                prompt=prompt,
                model=model,
                status="success",
                started_at=start_time,
                usage_amount=usage_amount,
            )
            _update_image_job(
                job_id,
                status="success",
                result=result,
                error="",
                can_resume=False,
                progress="success",
                progress_text=_image_progress_text("success"),
            )
        except Exception as exc:
            refund_user_quota_reservation(reservation, action="image_resume_poll", model=model, error=str(exc))
            log_user_usage(
                api_key,
                action="image_resume_poll",
                prompt=prompt,
                model=model,
                status="failed",
                started_at=start_time,
                error=str(exc),
            )
            still_timeout = "超时" in str(exc)
            _update_image_job(
                job_id,
                status="error",
                error=str(exc),
                can_resume=still_timeout and bool(conversation_id and access_token),
                progress="error",
                progress_text=_image_progress_text("error"),
            )

    @router.post("/v1/image-jobs/generations")
    async def create_generation_job(body: ImageGenerationRequest, authorization: str | None = Header(default=None)):
        _, api_key = require_user(authorization)
        reservation = reserve_user_quota(api_key, body.n, action="image_generate", model=body.model)
        job_id = _create_image_job(
            api_key,
            client_conversation_id=body.client_conversation_id,
            client_image_id=body.client_image_id,
        )
        _update_image_job(job_id, reservation_id=reservation.get("id"), reserved_amount=reservation.get("amount"))
        Thread(target=run_generation_job, args=(job_id, api_key, body), daemon=True).start()
        return {"job_id": job_id, "status": "pending"}

    @router.post("/v1/image-jobs/edits")
    async def create_edit_job(
            authorization: str | None = Header(default=None),
            image: list[UploadFile] | None = File(default=None),
            image_list: list[UploadFile] | None = File(default=None, alias="image[]"),
            prompt: str = Form(...),
            model: str = Form(default="gpt-image-2"),
            n: int = Form(default=1),
            client_conversation_id: str = Form(default=""),
            client_image_id: str = Form(default=""),
    ):
        if n < 1 or n > 4:
            raise HTTPException(status_code=400, detail={"error": "n must be between 1 and 4"})
        uploads = [*(image or []), *(image_list or [])]
        if not uploads:
            raise HTTPException(status_code=400, detail={"error": "image file is required"})

        images: list[tuple[bytes, str, str]] = []
        total_upload_bytes = 0
        for upload in uploads:
            image_data, file_name, mime_type = await read_upload_file_limited(upload)
            total_upload_bytes += len(image_data)
            if total_upload_bytes > MAX_UPLOAD_IMAGE_TOTAL_BYTES:
                raise HTTPException(status_code=413, detail={"error": "image files are too large"})
            images.append((image_data, file_name, mime_type))

        _, api_key = require_user(authorization)
        reservation = reserve_user_quota(api_key, n, action="image_edit", model=model)
        job_id = _create_image_job(
            api_key,
            client_conversation_id=client_conversation_id,
            client_image_id=client_image_id,
        )
        _update_image_job(job_id, reservation_id=reservation.get("id"), reserved_amount=reservation.get("amount"))
        Thread(target=run_edit_job, args=(job_id, api_key, prompt, images, model, n), daemon=True).start()
        return {"job_id": job_id, "status": "pending"}

    @router.get("/v1/image-jobs")
    async def list_image_jobs(
            client_conversation_id: str = "",
            limit: int = 200,
            authorization: str | None = Header(default=None),
    ):
        _, api_key = require_user(authorization)
        return {"items": _list_user_image_jobs(api_key, client_conversation_id=client_conversation_id, limit=limit)}

    @router.get("/v1/image-jobs/{job_id}")
    async def get_image_job(job_id: str, authorization: str | None = Header(default=None)):
        _, api_key = require_user(authorization)
        job = _get_image_job(job_id)
        if not job or job.get("api_key") != api_key.key:
            raise HTTPException(status_code=404, detail={"error": "image job not found"})
        return _public_image_job(job_id, job)

    @router.post("/v1/image-jobs/{job_id}/resume-poll")
    async def resume_image_job(job_id: str, body: ImageJobResumeRequest, authorization: str | None = Header(default=None)):
        _, api_key = require_user(authorization)
        job = _get_image_job(job_id)
        if not job or job.get("api_key") != api_key.key:
            raise HTTPException(status_code=404, detail={"error": "image job not found"})
        if job.get("can_resume") is not True:
            raise HTTPException(status_code=400, detail={"error": "image job cannot resume polling"})
        if not str(job.get("conversation_id") or "") or not str(job.get("resume_access_token") or ""):
            raise HTTPException(status_code=400, detail={"error": "image job has no resumable upstream state"})
        Thread(target=run_resume_image_job, args=(job_id, api_key, body.extra_timeout_secs), daemon=True).start()
        return {"job_id": job_id, "status": "running"}

    @router.post("/v1/images/generations")
    async def generate_images(body: ImageGenerationRequest, authorization: str | None = Header(default=None)):
        start_time = datetime.now().timestamp()
        _, api_key = require_user(authorization)
        reservation = reserve_user_quota(api_key, body.n, action="image_generate", model=body.model)
        try:
            result = await run_in_threadpool(
                chatgpt_service.generate_with_pool,
                body.prompt,
                body.model,
                body.n,
                build_image_cache_metadata(api_key, action="image_generate", model=body.model),
                quality=body.quality,
                size=body.size,
                output_format=body.output_format,
                output_compression=body.output_compression,
                moderation=body.moderation,
            )
            usage_amount = settle_user_quota_reservation(
                reservation,
                len(result.get("data") or []) or body.n,
                action="image_generate",
                model=body.model,
            )
            log_user_usage(
                api_key,
                action="image_generate",
                prompt=body.prompt,
                model=body.model,
                status="success",
                started_at=start_time,
                usage_amount=usage_amount,
            )
            return result
        except ImageGenerationError as exc:
            refund_user_quota_reservation(reservation, action="image_generate", model=body.model, error=str(exc))
            log_user_usage(
                api_key,
                action="image_generate",
                prompt=body.prompt,
                model=body.model,
                status="failed",
                started_at=start_time,
                error=str(exc),
            )
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc
        except Exception as exc:
            refund_user_quota_reservation(reservation, action="image_generate", model=body.model, error=str(exc))
            log_user_usage(
                api_key,
                action="image_generate",
                prompt=body.prompt,
                model=body.model,
                status="failed",
                started_at=start_time,
                error=str(exc),
            )
            raise

    @router.post("/v1/images/edits")
    async def edit_images(
            authorization: str | None = Header(default=None),
            image: list[UploadFile] | None = File(default=None),
            image_list: list[UploadFile] | None = File(default=None, alias="image[]"),
            prompt: str = Form(...),
            model: str = Form(default="gpt-image-2"),
            n: int = Form(default=1),
    ):
        start_time = datetime.now().timestamp()
        if n < 1 or n > 4:
            raise HTTPException(status_code=400, detail={"error": "n must be between 1 and 4"})
        uploads = [*(image or []), *(image_list or [])]
        if not uploads:
            raise HTTPException(status_code=400, detail={"error": "image file is required"})

        images: list[tuple[bytes, str, str]] = []
        total_upload_bytes = 0
        for upload in uploads:
            image_data, file_name, mime_type = await read_upload_file_limited(upload)
            total_upload_bytes += len(image_data)
            if total_upload_bytes > MAX_UPLOAD_IMAGE_TOTAL_BYTES:
                raise HTTPException(status_code=413, detail={"error": "image files are too large"})
            images.append((image_data, file_name, mime_type))

        _, api_key = require_user(authorization)
        reservation = reserve_user_quota(api_key, n, action="image_edit", model=model)
        try:
            result = await run_in_threadpool(
                chatgpt_service.edit_with_pool,
                prompt,
                images,
                model,
                n,
                build_image_cache_metadata(api_key, action="image_edit", model=model),
            )
            usage_amount = settle_user_quota_reservation(
                reservation,
                len(result.get("data") or []) or n,
                action="image_edit",
                model=model,
            )
            log_user_usage(
                api_key,
                action="image_edit",
                prompt=prompt,
                model=model,
                status="success",
                started_at=start_time,
                usage_amount=usage_amount,
            )
            return result
        except ImageGenerationError as exc:
            refund_user_quota_reservation(reservation, action="image_edit", model=model, error=str(exc))
            log_user_usage(
                api_key,
                action="image_edit",
                prompt=prompt,
                model=model,
                status="failed",
                started_at=start_time,
                error=str(exc),
            )
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc
        except Exception as exc:
            refund_user_quota_reservation(reservation, action="image_edit", model=model, error=str(exc))
            log_user_usage(
                api_key,
                action="image_edit",
                prompt=prompt,
                model=model,
                status="failed",
                started_at=start_time,
                error=str(exc),
            )
            raise

    @router.post("/v1/chat/completions")
    async def create_chat_completion(body: ChatCompletionRequest, authorization: str | None = Header(default=None)):
        _, api_key = require_user(authorization)
        payload = body.model_dump(mode="python")
        prompt = extract_chat_prompt(payload)
        model = str(payload.get("model") or "auto").strip() or "auto"
        is_image_request = protocol_is_image_chat_request(payload)
        charge_amount = protocol_parse_image_count(payload.get("n")) if is_image_request else 1
        action = "chat_image_completion" if is_image_request else "chat_completion"
        return await _call_openai_protocol(
            user=api_key,
            payload=payload,
            handler=openai_v1_chat_complete.handle,
            action=action,
            prompt=prompt,
            model=model,
            charge_amount=charge_amount,
        )

    @router.post("/v1/responses")
    async def create_response(body: ResponseCreateRequest, authorization: str | None = Header(default=None)):
        _, api_key = require_user(authorization)
        payload = body.model_dump(mode="python")
        prompt = extract_response_prompt(payload.get("input"))
        model = str(payload.get("model") or "auto").strip() or "auto"
        action = "responses_image_generation" if protocol_has_response_image_generation_tool(payload) else "responses"
        return await _call_openai_protocol(
            user=api_key,
            payload=payload,
            handler=openai_v1_response.handle,
            action=action,
            prompt=prompt,
            model=model,
            charge_amount=1,
        )

    @router.get("/v1/editable-file-tasks")
    async def list_editable_file_tasks(ids: str = "", authorization: str | None = Header(default=None)):
        _, api_key = require_user(authorization)
        task_ids = [item.strip() for item in ids.split(",") if item.strip()]
        identity = {"id": api_key.id, "name": api_key.email, "email": api_key.email, "role": "user"}
        return await run_in_threadpool(editable_file_task_service.list_tasks, identity, task_ids)

    @router.get("/files/{file_path:path}")
    async def download_editable_file(file_path: str, authorization: str | None = Header(default=None)):
        _, user = require_user(authorization)
        try:
            path = await run_in_threadpool(editable_file_task_service.public_file_path, file_path)
            if not editable_file_task_service.owns_file(user.id,path):
                raise FileNotFoundError()
        except Exception as exc:
            raise HTTPException(status_code=404, detail={"error": "file not found"}) from exc
        return FileResponse(path, filename=path.name, headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"})

    @router.post("/v1/ppt/generations")
    async def create_ppt_task(
        body: EditableFileTaskRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        _, api_key = require_user(authorization)
        if config.get_studio_settings().enabled:
            raise HTTPException(409, detail={"error": "PPT 已启用 API 工作室，请先整理并确认演示方案"})
        raise HTTPException(503, detail={"error": "PPT 文档工作室尚未启用，请联系管理员"})

    @router.post("/v1/psd/generations")
    async def create_psd_task(
        body: EditableFileTaskRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        _, api_key = require_user(authorization)
        if config.get_studio_settings().enabled:
            raise HTTPException(409,detail={"error":"PSD 已启用 API 工作室，请先整理并确认图层方案"})
        prompt = str(body.prompt or "").strip()
        base64_images = [str(item or "").strip() for item in (body.base64_images or []) if str(item or "").strip()]
        image_count = len(base64_images)
        if image_count <= 0:
            raise HTTPException(status_code=400, detail={"error": "PSD 需要至少一张参考图"})
        unit_price = config.psd_task_price
        charge_amount = unit_price * image_count
        if charge_amount > 0 and not user_service.consume_quota(
            api_key.id,
            charge_amount,
            reason="editable_file_submit",
            reference="psd_generation",
            metadata={
                "action": "psd_generation",
                "model": "gpt-5-5-thinking",
                "client_task_id": body.client_task_id or "",
                "image_count": image_count,
                "unit_price": unit_price,
            },
        ):
            raise HTTPException(status_code=402, detail={"error": "用户积分不足，请先兑换积分"})
        try:
            if prompt:
                await run_in_threadpool(check_request, prompt)
            identity = {"id": api_key.id, "name": api_key.email, "email": api_key.email, "role": "user"}
            result = await run_in_threadpool(
                editable_file_task_service.submit_psd,
                identity,
                client_task_id=body.client_task_id or "",
                prompt=prompt,
                base64_images=base64_images,
                base_url=str(request.base_url).rstrip("/"),
                charged_amount=charge_amount,
            )
            log_user_usage(api_key, action="psd_generation", prompt=prompt, model="gpt-5-5-thinking", status="success", started_at=datetime.now().timestamp(), usage_amount=charge_amount)
            return result
        except HTTPException as exc:
            if charge_amount > 0:
                user_service.refund_quota(
                    api_key.id,
                    charge_amount,
                    reason="editable_file_submit_failed",
                    reference="psd_generation",
                    metadata={"action": "psd_generation", "model": "gpt-5-5-thinking", "client_task_id": body.client_task_id or "", "error": str(exc.detail)[:500]},
                )
            raise
        except Exception as exc:
            if charge_amount > 0:
                user_service.refund_quota(
                    api_key.id,
                    charge_amount,
                    reason="editable_file_submit_failed",
                    reference="psd_generation",
                    metadata={"action": "psd_generation", "model": "gpt-5-5-thinking", "client_task_id": body.client_task_id or "", "error": str(exc)[:500]},
                )
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

    @router.post("/v1/image-prompts/optimize")
    async def optimize_image_prompt(request: Request, authorization: str | None = Header(default=None)):
        start_time = datetime.now().timestamp()
        require_optimizer_session(extract_bearer_token(authorization))
        _, api_key = require_user(authorization)
        body = await read_optimizer_request(request)
        prompt = str(body.prompt or "").strip()
        settings = config.get_prompt_optimizer_settings()
        model = settings.model
        try:
            result = await prompt_optimizer.optimize(api_key, prompt, settings)
            log_user_usage(
                api_key,
                action="image_prompt_optimize",
                prompt=prompt,
                model=model,
                status="success",
                started_at=start_time,
            )
            return result
        except HTTPException as exc:
            if exc.status_code == 429:
                # Admission is already enforced in SQLite; avoid log writes per rejected request.
                raise
            log_user_usage(
                api_key,
                action="image_prompt_optimize",
                prompt=prompt,
                model=model,
                status="failed",
                started_at=start_time,
                error=str(exc.detail),
            )
            raise

    # ── CPA multi-pool endpoints ────────────────────────────────────

    @router.get("/api/cpa/pools")
    async def list_cpa_pools(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"pools": sanitize_cpa_pools(cpa_config.list_pools())}

    @router.post("/api/cpa/pools")
    async def create_cpa_pool(
            body: CPAPoolCreateRequest,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        if not body.base_url.strip():
            raise HTTPException(status_code=400, detail={"error": "base_url is required"})
        if not body.secret_key.strip():
            raise HTTPException(status_code=400, detail={"error": "secret_key is required"})
        pool = cpa_config.add_pool(
            name=body.name,
            base_url=body.base_url,
            secret_key=body.secret_key,
        )
        return {"pool": sanitize_cpa_pool(pool), "pools": sanitize_cpa_pools(cpa_config.list_pools())}

    @router.post("/api/cpa/pools/{pool_id}")
    async def update_cpa_pool(
            pool_id: str,
            body: CPAPoolUpdateRequest,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        pool = cpa_config.update_pool(pool_id, body.model_dump(exclude_none=True))
        if pool is None:
            raise HTTPException(status_code=404, detail={"error": "pool not found"})
        return {"pool": sanitize_cpa_pool(pool), "pools": sanitize_cpa_pools(cpa_config.list_pools())}

    @router.delete("/api/cpa/pools/{pool_id}")
    async def delete_cpa_pool(
            pool_id: str,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        if not cpa_config.delete_pool(pool_id):
            raise HTTPException(status_code=404, detail={"error": "pool not found"})
        return {"pools": sanitize_cpa_pools(cpa_config.list_pools())}

    @router.get("/api/cpa/pools/{pool_id}/files")
    async def cpa_pool_files(
            pool_id: str,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        pool = cpa_config.get_pool(pool_id)
        if pool is None:
            raise HTTPException(status_code=404, detail={"error": "pool not found"})
        files = await run_in_threadpool(list_remote_files, pool)
        return {"pool_id": pool_id, "files": files}

    @router.post("/api/cpa/pools/{pool_id}/import")
    async def cpa_pool_import(
            pool_id: str,
            body: CPAImportRequest,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        pool = cpa_config.get_pool(pool_id)
        if pool is None:
            raise HTTPException(status_code=404, detail={"error": "pool not found"})
        try:
            job = cpa_import_service.start_import(pool, body.names)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {"import_job": job}

    @router.get("/api/cpa/pools/{pool_id}/import")
    async def cpa_pool_import_progress(pool_id: str, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        pool = cpa_config.get_pool(pool_id)
        if pool is None:
            raise HTTPException(status_code=404, detail={"error": "pool not found"})
        return {"import_job": pool.get("import_job")}

    # ── Sub2API endpoints ─────────────────────────────────────────────

    @router.get("/api/sub2api/servers")
    async def list_sub2api_servers(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        return {"servers": sanitize_sub2api_servers(sub2api_config.list_servers())}

    @router.post("/api/sub2api/servers")
    async def create_sub2api_server(
            body: Sub2APIServerCreateRequest,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        if not body.base_url.strip():
            raise HTTPException(status_code=400, detail={"error": "base_url is required"})
        has_login = body.email.strip() and body.password.strip()
        has_api_key = bool(body.api_key.strip())
        if not has_login and not has_api_key:
            raise HTTPException(
                status_code=400,
                detail={"error": "email+password or api_key is required"},
            )
        server = sub2api_config.add_server(
            name=body.name,
            base_url=body.base_url,
            email=body.email,
            password=body.password,
            api_key=body.api_key,
            group_id=body.group_id,
        )
        return {
            "server": sanitize_sub2api_server(server),
            "servers": sanitize_sub2api_servers(sub2api_config.list_servers()),
        }

    @router.post("/api/sub2api/servers/{server_id}")
    async def update_sub2api_server(
            server_id: str,
            body: Sub2APIServerUpdateRequest,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        server = sub2api_config.update_server(server_id, body.model_dump(exclude_none=True))
        if server is None:
            raise HTTPException(status_code=404, detail={"error": "server not found"})
        return {
            "server": sanitize_sub2api_server(server),
            "servers": sanitize_sub2api_servers(sub2api_config.list_servers()),
        }

    @router.delete("/api/sub2api/servers/{server_id}")
    async def delete_sub2api_server(
            server_id: str,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        if not sub2api_config.delete_server(server_id):
            raise HTTPException(status_code=404, detail={"error": "server not found"})
        return {"servers": sanitize_sub2api_servers(sub2api_config.list_servers())}

    @router.get("/api/sub2api/servers/{server_id}/groups")
    async def sub2api_server_groups(
            server_id: str,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        server = sub2api_config.get_server(server_id)
        if server is None:
            raise HTTPException(status_code=404, detail={"error": "server not found"})
        try:
            groups = await run_in_threadpool(sub2api_list_remote_groups, server)
        except Exception as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc
        return {"server_id": server_id, "groups": groups}

    @router.get("/api/sub2api/servers/{server_id}/accounts")
    async def sub2api_server_accounts(
            server_id: str,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        server = sub2api_config.get_server(server_id)
        if server is None:
            raise HTTPException(status_code=404, detail={"error": "server not found"})
        try:
            accounts = await run_in_threadpool(sub2api_list_remote_accounts, server)
        except Exception as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc
        return {"server_id": server_id, "accounts": accounts}

    @router.post("/api/sub2api/servers/{server_id}/import")
    async def sub2api_server_import(
            server_id: str,
            body: Sub2APIImportRequest,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        server = sub2api_config.get_server(server_id)
        if server is None:
            raise HTTPException(status_code=404, detail={"error": "server not found"})
        try:
            job = sub2api_import_service.start_import(server, body.account_ids)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {"import_job": job}

    @router.get("/api/sub2api/servers/{server_id}/import")
    async def sub2api_server_import_progress(
            server_id: str,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        server = sub2api_config.get_server(server_id)
        if server is None:
            raise HTTPException(status_code=404, detail={"error": "server not found"})
        return {"import_job": server.get("import_job")}

    # ── Upstream proxy endpoints ─────────────────────────────────────

    @router.get("/api/proxy")
    async def get_proxy_settings_endpoint(
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        current_proxy = config.get_proxy_settings()
        return {
            "proxy": {
                "enabled": bool(current_proxy),
                "url": current_proxy,
            }
        }

    @router.post("/api/proxy")
    async def update_proxy_settings_endpoint(
            body: ProxyUpdateRequest,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        current_proxy = config.get_proxy_settings()
        next_enabled = bool(current_proxy) if body.enabled is None else bool(body.enabled)
        next_url = current_proxy if body.url is None else str(body.url or "").strip()
        try:
            config.update({
                **config.get(),
                "proxy": next_url if next_enabled else "",
            })
        except ConfigSaveError as exc:
            raise HTTPException(status_code=500, detail={"error": str(exc)}) from exc
        current_proxy = config.get_proxy_settings()
        return {
            "proxy": {
                "enabled": bool(current_proxy),
                "url": current_proxy,
            }
        }

    @router.post("/api/proxy/test")
    async def test_proxy_endpoint(
            body: ProxyTestRequest,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        candidate = (body.url or "").strip()
        if not candidate:
            candidate = config.get_proxy_settings()
        if not candidate:
            raise HTTPException(status_code=400, detail={"error": "proxy url is required"})
        result = await run_in_threadpool(test_proxy, candidate)
        return {"result": result}

    app.include_router(router)
    app.include_router(admin_router)

    def serve_web_file(full_path: str):
        asset = resolve_web_asset(full_path)
        if asset is not None:
            return FileResponse(asset)

        # Static assets (_next/*) must not fallback to HTML — return 404
        if full_path.strip("/").startswith("_next/"):
            raise HTTPException(status_code=404, detail="Not Found")

        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_web(full_path: str):
        return serve_web_file(full_path)

    @app.head("/{full_path:path}", include_in_schema=False)
    async def serve_web_head(full_path: str):
        return serve_web_file(full_path)

    return app

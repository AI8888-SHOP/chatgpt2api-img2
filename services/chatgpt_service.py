from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from threading import BoundedSemaphore, Lock
import time
from typing import Callable, Iterable

from fastapi import HTTPException

from services.account_service import account_service
from services.config import config
from services.image_service import (
    ImageGenerationError,
    ImagePollTimeoutError,
    edit_image_result_conduit,
    edit_image_result,
    generate_image_result_conduit,
    generate_image_result,
    resume_image_poll_result,
    optimize_prompt_result,
)
from services.register_service import ensure_auto_register_min_quota, new_register_service, register_service
from services.upstream_image_service import (
    edit_image_upstream,
    generate_image_upstream,
    is_upstream_image_model,
)
from services.utils import (
    build_chat_image_completion,
    extract_chat_image,
    extract_chat_prompt,
    extract_response_prompt,
    has_response_image_generation_tool,
    is_image_chat_request,
    parse_image_count,
)
from utils.log import logger

FREE_ACCOUNT_WAIT_TIMEOUT_SECS = 10 * 60
FREE_ACCOUNT_WAIT_POLL_SECS = 5
FREE_ACCOUNT_REGISTER_RETRY_SECS = 15

_IMAGE_EXECUTION_SEMAPHORE_LOCK = Lock()
_IMAGE_EXECUTION_SEMAPHORE: BoundedSemaphore | None = None
_IMAGE_EXECUTION_SEMAPHORE_CAPACITY = 0


def _is_tls_connection_error(message: str) -> bool:
    text = str(message or "").lower()
    return (
        "curl: (35)" in text
        or "curl: (92)" in text
        or "http/2 stream" in text
        or "tls connect error" in text
        or "openssl_internal" in text
        or "ssl: wrong_version_number" in text
        or "ssl: certificate_verify_failed" in text
        or "connection aborted" in text
        or "remote disconnected" in text
        or "connection reset by peer" in text
    )


def _is_connection_timeout_error(message: str) -> bool:
    text = str(message or "").lower()
    return (
        "curl: (28)" in text
        or "operation timed out" in text
        or "connection timed out" in text
        or "read timed out" in text
        or "connect timeout" in text
    )


def _public_image_error(message: str) -> str:
    text = str(message or "").strip()
    lower = text.lower()
    if _is_tls_connection_error(text):
        return "上游图片连接失败，请稍后重试"
    if _is_connection_timeout_error(text):
        return "上游图片连接超时，请稍后重试"
    if any(
        marker in lower
        for marker in (
            "no available free image account",
            "no available free tokens found",
            "no available free token found",
            "no available tokens found in",
        )
    ):
        return "系统正在补充可用生图账号，请稍后重试"
    if any(
        marker in lower
        for marker in (
            "token_invalidated",
            "token_revoked",
            "authentication token has been invalidated",
            "invalidated oauth token",
        )
    ):
        return "可用生图账号已失效，系统正在切换，请稍后重试"
    if any(
        marker in lower
        for marker in (
            "backend-api/",
            "chatgpt.com",
            "upstreamhttperror",
            "failed to get download url",
            "no image returned from upstream",
            "download image failed",
            "request failed",
            "conversation failed",
            "chat-requirements failed",
            "file upload",
            "status=",
            "body=",
            "url=",
        )
    ):
        return "生成图片失败，请稍后重试"
    return text or "生成图片失败"


def _is_retryable_upstream_session_error(message: str) -> bool:
    lower = str(message or "").lower()
    retryable_status = any(
        marker in lower
        for marker in (
            "status=401",
            "status=403",
            "status=408",
            "status=409",
            "status=425",
            "status=429",
            "status=500",
            "status=502",
            "status=503",
            "status=504",
        )
    )
    session_stage = any(
        marker in lower
        for marker in (
            "bootstrap failed",
            "chat_requirements_prepare failed",
            "chat_requirements_finalize failed",
            "chat-requirements failed",
            "conversation/prepare failed",
        )
    )
    return retryable_status and session_stage


def _attach_resume_fields(error: Exception, source: Exception) -> Exception:
    for attr in ("conversation_id", "access_token", "device_id"):
        value = getattr(source, attr, "")
        if value:
            setattr(error, attr, value)
    return error


def _execution_slot_progress(progress_callback: Callable[[str], None] | None, limit: int) -> None:
    if progress_callback:
        progress_callback(f"waiting_for_image_slot:{limit}")


def _get_image_execution_semaphore() -> tuple[BoundedSemaphore, int]:
    global _IMAGE_EXECUTION_SEMAPHORE, _IMAGE_EXECUTION_SEMAPHORE_CAPACITY
    capacity = max(1, int(config.image_global_concurrency))
    with _IMAGE_EXECUTION_SEMAPHORE_LOCK:
        if _IMAGE_EXECUTION_SEMAPHORE is None or _IMAGE_EXECUTION_SEMAPHORE_CAPACITY != capacity:
            _IMAGE_EXECUTION_SEMAPHORE = BoundedSemaphore(capacity)
            _IMAGE_EXECUTION_SEMAPHORE_CAPACITY = capacity
        return _IMAGE_EXECUTION_SEMAPHORE, capacity


@contextmanager
def _image_execution_slot(progress_callback: Callable[[str], None] | None = None):
    semaphore, limit = _get_image_execution_semaphore()
    acquired = False
    next_progress_at = 0.0
    try:
        while not acquired:
            now = time.monotonic()
            if now >= next_progress_at:
                _execution_slot_progress(progress_callback, limit)
                next_progress_at = now + 5.0
            acquired = semaphore.acquire(timeout=1.0)
        yield
    finally:
        if acquired:
            semaphore.release()


def _extract_response_image(input_value: object) -> tuple[bytes, str] | None:
    import base64 as b64
    if isinstance(input_value, dict):
        from services.utils import extract_image_from_message_content
        return extract_image_from_message_content(input_value.get("content"))
    if not isinstance(input_value, list):
        return None
    for item in reversed(input_value):
        if isinstance(item, dict):
            if str(item.get("type") or "").strip() == "input_image":
                image_url = str(item.get("image_url") or "")
                if image_url.startswith("data:"):
                    header, _, data = image_url.partition(",")
                    mime = header.split(";")[0].removeprefix("data:")
                    return b64.b64decode(data), mime or "image/png"
            content = item.get("content")
            if content:
                from services.utils import extract_image_from_message_content
                result = extract_image_from_message_content(content)
                if result:
                    return result
    return None


class ChatGPTService:
    def _free_pool_metrics(self) -> tuple[int, int]:
        available_accounts = 0
        available_quota = 0
        for account in account_service.list_accounts():
            if not account_service._account_matches_source_type(account, "default"):
                continue
            if account_service._normalize_account_type(account.get("type")) != "Free":
                continue
            if str(account.get("status") or "").strip() in {"禁用", "异常"}:
                continue
            quota = max(0, int(account.get("quota") or 0))
            available_quota += quota
            if quota > 0:
                available_accounts += 1
        return available_accounts, available_quota

    def _use_account_pool(self) -> bool:
        _, available_quota = self._free_pool_metrics()
        return available_quota > 0

    def _overall_image_timeout_secs(self) -> float:
        return max(1.0, float(config.image_poll_timeout_secs))

    def _image_timeout_message(self, timeout_secs: float | None = None) -> str:
        raw_timeout = timeout_secs if timeout_secs is not None else self._overall_image_timeout_secs()
        return f"ChatGPT 生图超时（已等待 {max(1, int(float(raw_timeout)))} 秒），可以继续等待或稍后重试。"

    def _remaining_time(self, deadline: float | None) -> float | None:
        if deadline is None:
            return None
        return max(0.0, deadline - time.monotonic())

    def _sleep_with_deadline(self, delay_secs: float, deadline: float | None) -> None:
        if delay_secs <= 0:
            return
        remaining = self._remaining_time(deadline)
        if remaining is None:
            time.sleep(delay_secs)
            return
        if remaining <= 0:
            return
        time.sleep(min(delay_secs, remaining))

    def _raise_total_timeout(self, *, source: Exception | None = None, timeout_secs: float | None = None) -> None:
        error = ImageGenerationError(self._image_timeout_message(timeout_secs))
        if source is not None:
            raise _attach_resume_fields(error, source) from source
        raise error

    def _wait_for_free_account_pool(
        self,
        required_quota: int = 1,
        *,
        progress_callback: Callable[[str], None] | None = None,
        deadline: float | None = None,
    ) -> bool:
        required_quota = max(1, int(required_quota or 1))
        _, available_quota = self._free_pool_metrics()
        if available_quota >= required_quota:
            return True

        wait_deadline = time.monotonic() + FREE_ACCOUNT_WAIT_TIMEOUT_SECS
        if deadline is not None:
            wait_deadline = min(wait_deadline, deadline)
        next_register_retry_at = 0.0
        default_quota = max(1, int(getattr(account_service, "DEFAULT_FREE_IMAGE_QUOTA", 3)))

        while time.monotonic() < wait_deadline:
            _, available_quota = self._free_pool_metrics()
            if available_quota >= required_quota:
                return True

            register_cfg = register_service.get()
            auto_register_enabled = register_cfg.get("auto_register_enabled") is not False
            register_running = bool(register_cfg.get("enabled") or new_register_service.get().get("enabled"))
            now = time.monotonic()

            if auto_register_enabled and now >= next_register_retry_at:
                if progress_callback:
                    progress_callback("registering_free_account")
                try:
                    auto_register = ensure_auto_register_min_quota(max(default_quota, required_quota))
                    register_running = bool(register_cfg.get("enabled") or auto_register.get("enabled"))
                except Exception as exc:
                    print(f"[chatgpt-service] trigger Reference account register failed error={exc}")
                next_register_retry_at = time.monotonic() + FREE_ACCOUNT_REGISTER_RETRY_SECS

            if progress_callback:
                progress_callback("waiting_for_free_account")

            if not register_running and not auto_register_enabled:
                return False
            self._sleep_with_deadline(FREE_ACCOUNT_WAIT_POLL_SECS, wait_deadline)

        _, available_quota = self._free_pool_metrics()
        return available_quota >= required_quota

    def _ensure_free_account_pool(
        self,
        required_quota: int = 1,
        *,
        progress_callback: Callable[[str], None] | None = None,
        deadline: float | None = None,
    ) -> None:
        if self._wait_for_free_account_pool(required_quota, progress_callback=progress_callback, deadline=deadline):
            return
        remaining = self._remaining_time(deadline)
        if remaining is not None and remaining <= 0:
            self._raise_total_timeout()
        raise ImageGenerationError("系统正在补充可用生图账号，请稍后重试")

    def _generate_single_with_retries(
        self,
        prompt: str,
        model: str,
        metadata: dict[str, str] | None = None,
        *,
        progress_callback: Callable[[str], None] | None = None,
        index: int = 1,
        quality: str = "auto",
        size: str = "auto",
        deadline: float | None = None,
        timeout_label_secs: float | None = None,
    ) -> dict:
        max_poll_timeout_retries = 4
        max_tls_retries = 3
        max_conn_timeout_retries = 3
        max_upstream_session_retries = 3
        poll_timeout_retries = 0
        tls_retries = 0
        conn_timeout_retries = 0
        upstream_session_retries = 0
        failures: list[str] = []
        timeout_label = timeout_label_secs if timeout_label_secs is not None else self._overall_image_timeout_secs()

        if deadline is None:
            with _image_execution_slot(progress_callback):
                return self._generate_single_with_retries(
                    prompt,
                    model,
                    metadata,
                    progress_callback=progress_callback,
                    index=index,
                    quality=quality,
                    size=size,
                    deadline=time.monotonic() + timeout_label,
                    timeout_label_secs=timeout_label,
                )

        while True:
            remaining = self._remaining_time(deadline)
            if remaining is not None and remaining <= 0:
                self._raise_total_timeout(timeout_secs=timeout_label)
            if progress_callback:
                progress_callback(f"getting_account:{index}")
            try:
                access_token = account_service.get_available_access_token(plan_type="Free", reserve_for_image=True)
            except Exception as exc:
                try:
                    self._ensure_free_account_pool(1, progress_callback=progress_callback, deadline=deadline)
                    access_token = account_service.get_available_access_token(plan_type="Free", reserve_for_image=True)
                except Exception as retry_exc:
                    raise ImageGenerationError(_public_image_error(str(retry_exc or exc))) from retry_exc
            try:
                if config.image_conduit_flow_enabled:
                    result = generate_image_result_conduit(
                        access_token,
                        prompt,
                        model,
                        metadata=metadata,
                        progress_callback=progress_callback,
                        timeout_secs=self._remaining_time(deadline),
                        timeout_label_secs=timeout_label,
                        size=size,
                        quality=quality,
                    )
                else:
                    result = generate_image_result(
                        access_token,
                        prompt,
                        model,
                        metadata=metadata,
                        progress_callback=progress_callback,
                        timeout_secs=self._remaining_time(deadline),
                        timeout_label_secs=timeout_label,
                    )
                account_service.mark_image_result(access_token, True)
                return result
            except ImagePollTimeoutError as exc:
                account_service.mark_image_result(access_token, False)
                failures.append(str(exc))
                poll_timeout_retries += 1
                remaining = self._remaining_time(deadline)
                if (remaining is None or remaining > 0) and poll_timeout_retries <= max_poll_timeout_retries:
                    print(
                        "[chatgpt-service] image poll timeout, retry with next account "
                        f"attempt={poll_timeout_retries}/{max_poll_timeout_retries} "
                        f"token={access_token[:12]}..."
                    )
                    continue
                raise _attach_resume_fields(ImageGenerationError(str(exc)), exc) from exc
            except Exception as exc:
                account_service.mark_image_result(access_token, False)
                message = str(exc)
                failures.append(message)
                logger.warning({
                    "event": "image_account_attempt_failed",
                    "request_token": access_token,
                    "model": model,
                    "index": index,
                    "error_type": type(exc).__name__,
                    "error": message[:800],
                })
                if (
                    _is_retryable_upstream_session_error(message)
                    and upstream_session_retries < max_upstream_session_retries
                ):
                    upstream_session_retries += 1
                    self._sleep_with_deadline(min(float(upstream_session_retries), 3.0), deadline)
                    continue
                if _is_connection_timeout_error(message) and conn_timeout_retries < max_conn_timeout_retries:
                    remaining = self._remaining_time(deadline)
                    if remaining is not None and remaining <= 0:
                        self._raise_total_timeout(timeout_secs=timeout_label)
                    conn_timeout_retries += 1
                    self._sleep_with_deadline(min(3.0 * conn_timeout_retries, 9.0), deadline)
                    continue
                if _is_tls_connection_error(message) and tls_retries < max_tls_retries:
                    remaining = self._remaining_time(deadline)
                    if remaining is not None and remaining <= 0:
                        self._raise_total_timeout(timeout_secs=timeout_label)
                    tls_retries += 1
                    self._sleep_with_deadline(min(2.0 * tls_retries, 10.0), deadline)
                    continue
                raise ImageGenerationError(_public_image_error(message)) from exc
            finally:
                account_service.release_image_token(access_token)

    def _edit_single_with_retries(
        self,
        prompt: str,
        images: list[tuple[bytes, str, str]],
        model: str,
        metadata: dict[str, str] | None = None,
        *,
        progress_callback: Callable[[str], None] | None = None,
        index: int = 1,
        deadline: float | None = None,
        timeout_label_secs: float | None = None,
    ) -> dict:
        max_poll_timeout_retries = 4
        max_tls_retries = 3
        max_conn_timeout_retries = 3
        max_upstream_session_retries = 3
        poll_timeout_retries = 0
        tls_retries = 0
        conn_timeout_retries = 0
        upstream_session_retries = 0
        timeout_label = timeout_label_secs if timeout_label_secs is not None else self._overall_image_timeout_secs()

        if deadline is None:
            with _image_execution_slot(progress_callback):
                return self._edit_single_with_retries(
                    prompt,
                    images,
                    model,
                    metadata,
                    progress_callback=progress_callback,
                    index=index,
                    deadline=time.monotonic() + timeout_label,
                    timeout_label_secs=timeout_label,
                )

        while True:
            remaining = self._remaining_time(deadline)
            if remaining is not None and remaining <= 0:
                self._raise_total_timeout(timeout_secs=timeout_label)
            if progress_callback:
                progress_callback(f"getting_account:{index}")
            try:
                access_token = account_service.get_available_access_token(plan_type="Free", reserve_for_image=True)
            except Exception as exc:
                try:
                    self._ensure_free_account_pool(1, progress_callback=progress_callback, deadline=deadline)
                    access_token = account_service.get_available_access_token(plan_type="Free", reserve_for_image=True)
                except Exception as retry_exc:
                    raise ImageGenerationError(_public_image_error(str(retry_exc or exc))) from retry_exc
            try:
                image_editor = edit_image_result_conduit if config.image_conduit_flow_enabled else edit_image_result
                result = image_editor(
                    access_token,
                    prompt,
                    images,
                    model,
                    metadata=metadata,
                    progress_callback=progress_callback,
                    timeout_secs=self._remaining_time(deadline),
                    timeout_label_secs=timeout_label,
                )
                account_service.mark_image_result(access_token, True)
                return result
            except ImagePollTimeoutError as exc:
                account_service.mark_image_result(access_token, False)
                poll_timeout_retries += 1
                remaining = self._remaining_time(deadline)
                if (remaining is None or remaining > 0) and poll_timeout_retries <= max_poll_timeout_retries:
                    print(
                        "[chatgpt-service] image edit poll timeout, retry with next account "
                        f"attempt={poll_timeout_retries}/{max_poll_timeout_retries} "
                        f"token={access_token[:12]}..."
                    )
                    continue
                raise _attach_resume_fields(ImageGenerationError(str(exc)), exc) from exc
            except Exception as exc:
                account_service.mark_image_result(access_token, False)
                message = str(exc)
                logger.warning({
                    "event": "image_edit_account_attempt_failed",
                    "request_token": access_token,
                    "model": model,
                    "index": index,
                    "error_type": type(exc).__name__,
                    "error": message[:800],
                })
                if (
                    _is_retryable_upstream_session_error(message)
                    and upstream_session_retries < max_upstream_session_retries
                ):
                    upstream_session_retries += 1
                    self._sleep_with_deadline(min(float(upstream_session_retries), 3.0), deadline)
                    continue
                if _is_connection_timeout_error(message) and conn_timeout_retries < max_conn_timeout_retries:
                    remaining = self._remaining_time(deadline)
                    if remaining is not None and remaining <= 0:
                        self._raise_total_timeout(timeout_secs=timeout_label)
                    conn_timeout_retries += 1
                    self._sleep_with_deadline(min(3.0 * conn_timeout_retries, 9.0), deadline)
                    continue
                if _is_tls_connection_error(message) and tls_retries < max_tls_retries:
                    remaining = self._remaining_time(deadline)
                    if remaining is not None and remaining <= 0:
                        self._raise_total_timeout(timeout_secs=timeout_label)
                    tls_retries += 1
                    self._sleep_with_deadline(min(2.0 * tls_retries, 10.0), deadline)
                    continue
                raise ImageGenerationError(_public_image_error(message)) from exc
            finally:
                account_service.release_image_token(access_token)

    def _collect_parallel_results(
        self,
        count: int,
        worker: Callable[[int], dict],
    ) -> dict:
        data: list[dict] = []
        failures: list[str] = []
        resumable_error: Exception | None = None
        max_workers = min(max(1, count), config.image_account_concurrency)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {executor.submit(worker, index): index for index in range(1, count + 1)}
            for future in as_completed(future_map):
                try:
                    result = future.result()
                    data.extend(result.get("data") or [])
                except Exception as exc:
                    failures.append(str(exc))
                    if getattr(exc, "conversation_id", "") and getattr(exc, "access_token", ""):
                        resumable_error = exc
        if not data:
            error = ImageGenerationError(failures[0] if failures else "no image returned from account pool")
            if resumable_error is not None:
                _attach_resume_fields(error, resumable_error)
            raise error
        return {"created": int(time.time()), "data": data[:count]}

    def _generate_with_account_pool(
        self,
        prompt: str,
        model: str,
        n: int,
        metadata: dict[str, str] | None = None,
        *,
        progress_callback: Callable[[str], None] | None = None,
        quality: str = "auto",
        size: str = "auto",
        deadline: float | None = None,
        timeout_label_secs: float | None = None,
    ) -> dict:
        count = max(1, n)
        if count > 1 and config.image_parallel_generation:
            return self._collect_parallel_results(
                count,
                lambda index: self._generate_single_with_retries(
                    prompt,
                    model,
                    metadata,
                    progress_callback=progress_callback,
                    index=index,
                    quality=quality,
                    size=size,
                    deadline=deadline,
                    timeout_label_secs=timeout_label_secs,
                ),
            )
        data: list[dict] = []
        failures: list[str] = []
        for index in range(1, count + 1):
            try:
                result = self._generate_single_with_retries(
                    prompt,
                    model,
                    metadata,
                    progress_callback=progress_callback,
                    index=index,
                    quality=quality,
                    size=size,
                    deadline=deadline,
                    timeout_label_secs=timeout_label_secs,
                )
                data.extend(result.get("data") or [])
            except Exception as exc:
                failures.append(str(exc))
                if not data:
                    raise
        if not data:
            raise ImageGenerationError(failures[0] if failures else "no image returned from account pool")
        return {"created": int(time.time()), "data": data[:count]}

    def _edit_with_account_pool(
        self,
        prompt: str,
        images: list[tuple[bytes, str, str]],
        model: str,
        n: int,
        metadata: dict[str, str] | None = None,
        *,
        progress_callback: Callable[[str], None] | None = None,
        deadline: float | None = None,
        timeout_label_secs: float | None = None,
    ) -> dict:
        count = max(1, n)
        if count > 1 and config.image_parallel_generation:
            return self._collect_parallel_results(
                count,
                lambda index: self._edit_single_with_retries(
                    prompt,
                    images,
                    model,
                    metadata,
                    progress_callback=progress_callback,
                    index=index,
                    deadline=deadline,
                    timeout_label_secs=timeout_label_secs,
                ),
            )
        data: list[dict] = []
        failures: list[str] = []
        for index in range(1, count + 1):
            try:
                result = self._edit_single_with_retries(
                    prompt,
                    images,
                    model,
                    metadata,
                    progress_callback=progress_callback,
                    index=index,
                    deadline=deadline,
                    timeout_label_secs=timeout_label_secs,
                )
                data.extend(result.get("data") or [])
            except Exception as exc:
                failures.append(str(exc))
                if not data:
                    raise
        if not data:
            raise ImageGenerationError(failures[0] if failures else "no image returned from account pool")
        return {"created": int(time.time()), "data": data[:count]}

    def generate_with_pool(
        self,
        prompt: str,
        model: str,
        n: int,
        metadata: dict[str, str] | None = None,
        quality: str = "auto",
        size: str = "auto",
        output_format: str = "png",
        output_compression: int = 0,
        moderation: str = "auto",
        progress_callback: Callable[[str], None] | None = None,
    ):
        """Route configured external models upstream and GPT Image through the local account pool."""
        if is_upstream_image_model(model):
            if progress_callback:
                progress_callback("generating_image")
            return generate_image_upstream(
                prompt=prompt,
                n=n,
                quality=quality,
                size=size,
                output_format=output_format,
                output_compression=output_compression,
                moderation=moderation,
                metadata=metadata,
                model=model,
            )

        self._ensure_free_account_pool(n, progress_callback=progress_callback, deadline=None)
        timeout_label = self._overall_image_timeout_secs()
        return self._generate_with_account_pool(
            prompt,
            model,
            n,
            metadata=metadata,
            progress_callback=progress_callback,
            quality=quality,
            size=size,
            deadline=None,
            timeout_label_secs=timeout_label,
        )

    def edit_with_pool(
        self,
        prompt: str,
        images: Iterable[tuple[bytes, str, str]],
        model: str,
        n: int,
        metadata: dict[str, str] | None = None,
        progress_callback: Callable[[str], None] | None = None,
    ):
        normalized_images = list(images)
        if not normalized_images:
            raise ImageGenerationError("image is required")
        if is_upstream_image_model(model):
            if progress_callback:
                progress_callback("generating_image")
            return edit_image_upstream(prompt, normalized_images, n=n, metadata=metadata, model=model)
        self._ensure_free_account_pool(n, progress_callback=progress_callback, deadline=None)
        timeout_label = self._overall_image_timeout_secs()
        return self._edit_with_account_pool(
            prompt,
            normalized_images,
            model,
            n,
            metadata=metadata,
            progress_callback=progress_callback,
            deadline=None,
            timeout_label_secs=timeout_label,
        )

    def resume_image_poll(
        self,
        access_token: str,
        device_id: str,
        conversation_id: str,
        *,
        prompt: str = "",
        model: str = "auto",
        metadata: dict[str, str] | None = None,
        timeout_secs: float | None = None,
        progress_callback: Callable[[str], None] | None = None,
    ) -> dict:
        try:
            return resume_image_poll_result(
                access_token,
                device_id,
                conversation_id,
                prompt=prompt,
                model=model,
                metadata=metadata,
                timeout_secs=timeout_secs,
                progress_callback=progress_callback,
            )
        except ImagePollTimeoutError as exc:
            raise _attach_resume_fields(ImageGenerationError(str(exc)), exc) from exc
        except Exception as exc:
            raise _attach_resume_fields(ImageGenerationError(_public_image_error(str(exc))), exc) from exc

    def create_image_completion(self, body: dict[str, object], metadata: dict[str, str] | None = None) -> dict[str, object]:
        if not is_image_chat_request(body):
            raise HTTPException(
                status_code=400,
                detail={"error": "only image generation requests are supported on this endpoint"},
            )

        if bool(body.get("stream")):
            raise HTTPException(status_code=400, detail={"error": "stream is not supported for image generation"})

        model = str(body.get("model") or "gpt-image-2").strip() or "gpt-image-2"
        n = parse_image_count(body.get("n"))
        prompt = extract_chat_prompt(body)
        if not prompt:
            raise HTTPException(status_code=400, detail={"error": "prompt is required"})

        image_info = extract_chat_image(body)
        try:
            if image_info:
                image_data, mime_type = image_info
                image_result = self.edit_with_pool(prompt, [(image_data, "image.png", mime_type)], model, n, metadata=metadata)
            else:
                image_result = self.generate_with_pool(prompt, model, n, metadata=metadata)
        except ImageGenerationError as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

        return build_chat_image_completion(model, prompt, image_result)

    def create_response(self, body: dict[str, object], metadata: dict[str, str] | None = None) -> dict[str, object]:
        if bool(body.get("stream")):
            raise HTTPException(status_code=400, detail={"error": "stream is not supported"})

        if not has_response_image_generation_tool(body):
            raise HTTPException(
                status_code=400,
                detail={"error": "only image_generation tool requests are supported on this endpoint"},
            )

        prompt = extract_response_prompt(body.get("input"))
        if not prompt:
            raise HTTPException(status_code=400, detail={"error": "input text is required"})

        image_info = _extract_response_image(body.get("input"))
        model = str(body.get("model") or "gpt-image-2").strip() or "gpt-image-2"
        try:
            if image_info:
                image_data, mime_type = image_info
                image_result = self.edit_with_pool(prompt, [(image_data, "image.png", mime_type)], "gpt-image-2", 1, metadata=metadata)
            else:
                image_result = self.generate_with_pool(prompt, "gpt-image-2", 1, metadata=metadata)
        except ImageGenerationError as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

        image_items = image_result.get("data") if isinstance(image_result.get("data"), list) else []
        output = []
        for item in image_items:
            if not isinstance(item, dict):
                continue
            image_result = str(item.get("url") or item.get("b64_json") or "").strip()
            if not image_result:
                continue
            output.append(
                {
                    "id": f"ig_{len(output) + 1}",
                    "type": "image_generation_call",
                    "status": "completed",
                    "result": image_result,
                    "revised_prompt": str(item.get("revised_prompt") or prompt).strip(),
                }
            )

        if not output:
            raise HTTPException(status_code=502, detail={"error": "image generation failed"})

        created = int(image_result.get("created") or 0)
        return {
            "id": f"resp_{created}",
            "object": "response",
            "created_at": created,
            "status": "completed",
            "error": None,
            "incomplete_details": None,
            "model": model,
            "output": output,
            "parallel_tool_calls": False,
        }

    def optimize_prompt(self, prompt: str, model: str = "auto") -> str:
        self._ensure_free_account_pool(1)
        try:
            access_token = account_service.get_available_access_token(plan_type="Free")
        except Exception as exc:
            raise ImageGenerationError(_public_image_error(str(exc))) from exc
        return optimize_prompt_result(access_token, prompt, model=model)

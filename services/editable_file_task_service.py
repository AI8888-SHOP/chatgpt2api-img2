from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from services.account_service import account_service
from services.config import DATA_DIR
from services.content_filter import request_text
from services.log_service import LOG_TYPE_CALL, log_service
from services.openai_backend_api import EDITABLE_FILE_MODEL, InvalidAccessTokenError, OpenAIBackendAPI
from services.user_service import user_service
from utils.helper import UpstreamHTTPError, new_uuid

TASK_STATUS_QUEUED = "queued"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_SUCCESS = "success"
TASK_STATUS_ERROR = "error"
UNFINISHED_STATUSES = {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING}
EDITABLE_FILE_PLAN_TYPES = ("Plus", "Team", "Pro", "Enterprise")
EDITABLE_FILE_ROOT = DATA_DIR / "files"
EDITABLE_FILE_TASKS_PATH = DATA_DIR / "editable_file_tasks.json"


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id")) or "anonymous"


def _task_key(owner_id: str, task_id: str) -> str:
    return f"{owner_id}:{task_id}"


def _elapsed_seconds(task: dict[str, Any]) -> int:
    start = float(task.get("started_ts") or task.get("created_ts") or 0)
    end = float(task.get("ended_ts") or time.time())
    return max(0, int(end - start)) if start else 0


def _file_url(path: Path, base_url: str) -> str:
    rel = path.resolve().relative_to(EDITABLE_FILE_ROOT.resolve()).as_posix()
    prefix = str(base_url or "").strip().rstrip("/")
    return f"{prefix}/files/{quote(rel, safe='/')}" if prefix else f"/files/{quote(rel, safe='/')}"


def _editable_access_token(excluded_tokens: set[str] | None = None) -> str:
    excluded = {_clean(token) for token in (excluded_tokens or set()) if _clean(token)}
    with account_service._lock:
        accounts = [
            dict(item) for item in account_service._accounts
            if _clean(item.get("access_token"))
               and item.get("status") not in {"禁用", "异常"}
               and account_service._account_matches_any_plan_type(item, EDITABLE_FILE_PLAN_TYPES)
               and _clean(item.get("access_token")) not in excluded
        ]
    if not accounts:
        raise RuntimeError("no available plus/team/pro account")
    accounts.sort(key=lambda item: _clean(item.get("last_used_at")))
    token = _clean(accounts[0].get("access_token"))
    return account_service.refresh_access_token(token, event="editable_file_task") or token


def _format_account_label(account: dict[str, Any], token: str) -> str:
    return _clean(account.get("email")) or _clean(account.get("user_id")) or f"{token[:12]}..."


def _account_retry_reason(exc: Exception) -> str:
    text = str(exc or "").lower()
    transient_markers = (
        "curl: (7)",
        "curl: (28)",
        "failed to connect",
        "could not connect to server",
        "resolving timed out",
        "operation timed out",
        "connection timed out",
        "temporary failure in name resolution",
    )
    if any(marker in text for marker in transient_markers):
        return "transient"
    invalid_markers = (
        "token_invalidated",
        "token_revoked",
        "authentication token has been invalidated",
        "invalidated oauth token",
        "invalid access token",
    )
    if isinstance(exc, InvalidAccessTokenError) or any(marker in text for marker in invalid_markers):
        return "invalid"
    if isinstance(exc, UpstreamHTTPError):
        if exc.status_code == 401:
            return "invalid"
        if exc.status_code == 429:
            return "limited"
        if exc.status_code == 403:
            return "unavailable"
    unavailable_markers = (
        "rate limit",
        "too many requests",
        "not entitled",
        "not eligible",
        "not available for your account",
        "requires a plus",
        "requires plus",
    )
    if any(marker in text for marker in ("rate limit", "too many requests")):
        return "limited"
    return "unavailable" if any(marker in text for marker in unavailable_markers) else ""


def _compact_error(exc: Exception, limit: int = 220) -> str:
    text = str(exc or exc.__class__.__name__).strip() or exc.__class__.__name__
    return text if len(text) <= limit else text[:limit] + "...[truncated]"


def _public_failure_message(exc: Exception) -> str:
    text = str(exc or "").lower()
    if "no usable plus/team/pro account" in text or "no available plus/team/pro account" in text:
        return "所有可用账号暂时不可用，请稍后重试"
    if any(marker in text for marker in ("curl:", "failed to connect", "timed out", "could not connect")):
        return "上游连接暂时不可用，请稍后重试"
    return str(exc) or "editable file task failed"


def _public_task(task: dict[str, Any]) -> dict[str, Any]:
    item = {
        "id": task.get("id"),
        "taskId": task.get("id"),
        "status": task.get("status"),
        "kind": task.get("kind"),
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
        "elapsed_seconds": _elapsed_seconds(task),
    }
    for key in ("result", "error"):
        if task.get(key):
            item[key] = task[key]
    if task.get("conversation_id"):
        item["conversation_id"] = task["conversation_id"]
    return item


class EditableFileTaskService:
    def __init__(self, path: Path = EDITABLE_FILE_TASKS_PATH) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._tasks: dict[str, dict[str, Any]] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._tasks = self._load_locked()
            if self._recover_unfinished_locked():
                self._save_locked()

    def submit_ppt(self, identity: dict[str, object], *, client_task_id: str = "", prompt: str = "", base64_images: list[str] | None = None, base_url: str = "", charged_amount: int = 0) -> dict[str, Any]:
        return self._submit(identity, client_task_id=client_task_id, kind="ppt", prompt=prompt, base64_images=base64_images or [], base_url=base_url, charged_amount=charged_amount)

    def submit_psd(self, identity: dict[str, object], *, client_task_id: str = "", prompt: str = "", base64_images: list[str] | None = None, base_url: str = "", charged_amount: int = 0) -> dict[str, Any]:
        return self._submit(identity, client_task_id=client_task_id, kind="psd", prompt=prompt, base64_images=base64_images or [], base_url=base_url, charged_amount=charged_amount)

    def list_tasks(self, identity: dict[str, object], task_ids: list[str]) -> dict[str, Any]:
        owner = _owner_id(identity)
        requested = [_clean(item) for item in task_ids if _clean(item)]
        with self._lock:
            if requested:
                items = [task for task_id in requested if (task := self._tasks.get(_task_key(owner, task_id)))]
                return {"items": [_public_task(item) for item in items], "missing_ids": [task_id for task_id in requested if _task_key(owner, task_id) not in self._tasks]}
            items = [task for task in self._tasks.values() if task.get("owner_id") == owner]
        items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        return {"items": [_public_task(item) for item in items], "missing_ids": []}

    def _submit(self, identity: dict[str, object], *, client_task_id: str, kind: str, prompt: str, base64_images: list[str], base_url: str, charged_amount: int = 0) -> dict[str, Any]:
        task_id = _clean(client_task_id) or new_uuid()
        owner = _owner_id(identity)
        key = _task_key(owner, task_id)
        now = _now_iso()
        charged_amount = max(0, int(charged_amount or 0))
        with self._lock:
            if key in self._tasks:
                task = _public_task(self._tasks[key])
                self._refund_charged_quota(owner, charged_amount, kind, task_id, error="duplicate_task_submit")
                return task
            ts = time.time()
            self._tasks[key] = {"id": task_id, "owner_id": owner, "status": TASK_STATUS_QUEUED, "kind": kind, "model": EDITABLE_FILE_MODEL, "created_at": now, "updated_at": now, "created_ts": ts, "updated_ts": ts}
            if charged_amount:
                self._tasks[key]["charged_amount"] = charged_amount
            task = dict(self._tasks[key])
            self._save_locked()
        threading.Thread(target=self._run_task, args=(key, kind, prompt, base64_images, dict(identity), base_url, charged_amount), name=f"{kind}-file-task-{task_id[:16]}", daemon=True).start()
        return _public_task(task)

    def _run_task(self, key: str, kind: str, prompt: str, base64_images: list[str], identity: dict[str, object], base_url: str, charged_amount: int = 0) -> None:
        started = time.time()
        token = ""
        account_email = ""
        conversation_id = ""
        task_id = key.rsplit(":", 1)[-1]
        self._update_task(key, status=TASK_STATUS_RUNNING, error="", started_ts=started)
        try:
            if kind == "psd" and not base64_images:
                raise ValueError("base64_images is empty")
            attempted_tokens: set[str] = set()
            attempt_errors: list[str] = []
            output_dir = EDITABLE_FILE_ROOT / kind / task_id

            while True:
                try:
                    token = _editable_access_token(attempted_tokens)
                except RuntimeError as exc:
                    raise RuntimeError(f"no usable plus/team/pro account after {len(attempted_tokens)} attempts") from exc

                attempted_tokens.add(token)
                account = account_service.get_account(token) or {}
                account_email = _clean(account.get("email"))
                account_label = _format_account_label(account, token)
                try:
                    backend = OpenAIBackendAPI(token)
                    backend.progress_callback = lambda step: self._handle_backend_progress(key, step)
                    result = backend.export_psd_zip(base64_images, prompt, output_dir) if kind == "psd" else backend.export_ppt_zip(base64_images, prompt, output_dir)
                    conversation_id = result.conversation_id
                    account_service.mark_text_used(token)
                    data = {"conversation_id": result.conversation_id, "primary_url": _file_url(result.primary_path, base_url), "zip_url": _file_url(result.zip_path, base_url)}
                    self._update_task(key, status=TASK_STATUS_SUCCESS, result=data, conversation_id=conversation_id, account_email=account_email, error="", ended_ts=time.time())
                    self._log_call(identity, kind, started, request_text(prompt), account_email=account_email, result=data)
                    return
                except Exception as exc:
                    conversation_id = _clean(getattr(exc, "conversation_id", "")) or self._task_conversation_id(key) or conversation_id
                    retry_reason = _account_retry_reason(exc)
                    if not retry_reason:
                        raise
                    error = _compact_error(exc)
                    attempt_errors.append(f"{account_label}: {error}")
                    if retry_reason == "invalid":
                        account_service.remove_invalid_token(token, event=f"editable_file_{kind}", quiet=True)
                    elif retry_reason == "limited":
                        account_service.update_account(token, {"status": "限流", "quota": 0})
                    elif retry_reason == "unavailable":
                        account_service.update_account(token, {"status": "异常", "quota": 0})
                    self._update_task(
                        key,
                        error="正在分析",
                    )
        except Exception as exc:
            error = _public_failure_message(exc)
            conversation_id = _clean(getattr(exc, "conversation_id", "")) or self._task_conversation_id(key) or conversation_id
            updates: dict[str, Any] = {"status": TASK_STATUS_ERROR, "error": error, "account_email": account_email, "ended_ts": time.time()}
            if conversation_id:
                updates["conversation_id"] = conversation_id
            self._update_task(key, **updates)
            self._refund_charged_quota(_owner_id(identity), charged_amount or self._task_charged_amount(key), kind, task_id, error=error, conversation_id=conversation_id)
            self._log_call(identity, kind, started, request_text(prompt), status="failed", error=_compact_error(exc, 1200), account_email=account_email, result=({"conversation_id": conversation_id} if conversation_id else None))

    def public_file_path(self, relative_path: str) -> Path:
        raw = str(relative_path or "").replace("\\", "/").lstrip("/")
        path = (EDITABLE_FILE_ROOT / raw).resolve()
        path.relative_to(EDITABLE_FILE_ROOT.resolve())
        if not path.is_file():
            raise FileNotFoundError(raw)
        return path

    def _update_task(self, key: str, **updates: Any) -> None:
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                return
            task.update(updates)
            task["updated_at"] = _now_iso()
            task["updated_ts"] = time.time()
            self._save_locked()

    def _handle_backend_progress(self, key: str, step: str) -> None:
        prefix = "editable_conversation_id:"
        text = _clean(step)
        if text.startswith(prefix):
            conversation_id = text[len(prefix):].strip()
            if conversation_id:
                self._update_task(key, conversation_id=conversation_id)

    def _task_conversation_id(self, key: str) -> str:
        with self._lock:
            task = self._tasks.get(key) or {}
            return _clean(task.get("conversation_id"))

    def _task_charged_amount(self, key: str) -> int:
        with self._lock:
            task = self._tasks.get(key) or {}
            return max(0, int(task.get("charged_amount") or 0))

    @staticmethod
    def _refund_charged_quota(owner_id: str, amount: int, kind: str, task_id: str, *, error: str = "", conversation_id: str = "") -> None:
        amount = max(0, int(amount or 0))
        if not owner_id or amount <= 0:
            return
        user_service.refund_quota(
            owner_id,
            amount,
            reason="editable_file_failed",
            reference=f"{kind}_generation",
            metadata={"action": f"{kind}_generation", "model": EDITABLE_FILE_MODEL, "task_id": task_id, "conversation_id": conversation_id, "error": str(error or "")[:500]},
        )

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        tasks: dict[str, dict[str, Any]] = {}
        for item in (raw.get("tasks") if isinstance(raw, dict) else raw) or []:
            if not isinstance(item, dict):
                continue
            task_id = _clean(item.get("id"))
            owner = _clean(item.get("owner_id"))
            if not task_id or not owner:
                continue
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": _clean(item.get("status"), TASK_STATUS_ERROR),
                "kind": "psd" if item.get("kind") == "psd" else "ppt",
                "created_at": _clean(item.get("created_at"), _now_iso()),
                "updated_at": _clean(item.get("updated_at"), _clean(item.get("created_at"), _now_iso())),
                "created_ts": float(item.get("created_ts") or 0),
                "updated_ts": float(item.get("updated_ts") or 0),
            }
            for field in ("result", "error", "started_ts", "ended_ts", "conversation_id", "charged_amount"):
                if item.get(field):
                    task[field] = item[field]
            tasks[_task_key(owner, task_id)] = task
        return tasks

    def _save_locked(self) -> None:
        items = sorted(self._tasks.values(), key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(json.dumps({"tasks": items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(self.path)

    def _recover_unfinished_locked(self) -> bool:
        changed = False
        for task in self._tasks.values():
            if task.get("status") in UNFINISHED_STATUSES:
                self._refund_charged_quota(_clean(task.get("owner_id")), max(0, int(task.get("charged_amount") or 0)), str(task.get("kind") or "editable"), _clean(task.get("id")), error="service_restarted")
                task["status"] = TASK_STATUS_ERROR
                task["error"] = "服务已重启，未完成的任务已中断"
                task["ended_ts"] = time.time()
                task["updated_at"] = _now_iso()
                task["updated_ts"] = time.time()
                changed = True
        return changed

    def _log_call(
            self,
            identity: dict[str, object],
            kind: str,
            started: float,
            request_preview: str,
            *,
            status: str = "success",
            error: str = "",
            account_email: str = "",
            result: dict[str, str] | None = None,
    ) -> None:
        detail = {
            "key_id": identity.get("id"),
            "key_name": identity.get("name"),
            "role": identity.get("role"),
            "endpoint": f"/v1/{kind}/generations",
            "model": EDITABLE_FILE_MODEL,
            "started_at": datetime.fromtimestamp(started).strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": _now_iso(),
            "duration_ms": int((time.time() - started) * 1000),
            "status": status,
        }
        if request_preview:
            detail["request_text"] = request_preview
        if account_email:
            detail["account_email"] = account_email
        if error:
            detail["error"] = error
        if result:
            detail["result"] = result
        try:
            log_service.add(LOG_TYPE_CALL, f"{kind.upper()}生成任务{'失败' if status == 'failed' else '完成'}", detail)
        except Exception:
            pass


editable_file_task_service = EditableFileTaskService()

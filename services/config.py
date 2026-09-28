from __future__ import annotations

import json
import os
from pathlib import Path
import time
from typing import Any
from services.prompt_optimizer_config import PromptOptimizerSettings, merge_optimizer_settings
from services.editable_studio_config import StudioSettings, merge_studio_settings

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
CONFIG_FILE = BASE_DIR / "config.json"

DEFAULT_IMAGE_UPSTREAM = {
    "name": "默认上游",
    "base_url": "",
    "api_key": "",
    "model": "gpt-image-2",
    "enabled": True,
}

DEFAULT_SITE_TITLE = "image 专业绘图"
DEFAULT_QUICK_PROMPTS: list[dict[str, str]] = []
DEFAULT_IMAGE_STORAGE = {
    "enabled": False,
    "mode": "local",
    "webdav_url": "",
    "webdav_username": "",
    "webdav_password": "",
    "webdav_root_path": "chatgpt2api/images",
    "public_base_url": "",
}
DEFAULT_CHAT_COMPLETION_CACHE = {
    "enabled": True,
    "ttl_seconds": 60,
    "max_entries": 256,
    "dedupe_inflight": True,
    "stream_cache": True,
    "normalize_messages": True,
    "drop_adjacent_duplicates": True,
    "drop_assistant_history": False,
}


DEFAULT_PROXY_RUNTIME_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)
DEFAULT_PROXY_RUNTIME = {
    "enabled": False,
    "egress_mode": "direct",
    "proxy_url": "",
    "resource_proxy_url": "",
    "skip_ssl_verify": False,
    "reset_session_status_codes": [403],
    "clearance": {
        "enabled": False,
        "mode": "none",
        "cf_cookies": "",
        "cf_clearance": "",
        "user_agent": DEFAULT_PROXY_RUNTIME_USER_AGENT,
        "browser": "chrome",
        "flaresolverr_url": "",
        "timeout_sec": 60,
        "refresh_interval": 3600,
        "warm_up_on_start": False,
    },
}


def _normalize_status_codes(value: object) -> list[int]:
    source = value if isinstance(value, list) else [403]
    codes: list[int] = []
    for item in source:
        if isinstance(item, bool):
            continue
        try:
            code = int(item)
        except (TypeError, ValueError):
            continue
        if 100 <= code <= 599 and code not in codes:
            codes.append(code)
    return codes or [403]


def _normalize_proxy_runtime_settings(value: object) -> dict[str, object]:
    source = value if isinstance(value, dict) else {}
    default_clearance = DEFAULT_PROXY_RUNTIME["clearance"]
    clearance_source = source.get("clearance") if isinstance(source.get("clearance"), dict) else {}

    egress_mode = str(source.get("egress_mode") or DEFAULT_PROXY_RUNTIME["egress_mode"]).strip().lower()
    if egress_mode not in {"direct", "single_proxy"}:
        egress_mode = str(DEFAULT_PROXY_RUNTIME["egress_mode"])

    clearance_mode = str(clearance_source.get("mode") or default_clearance["mode"]).strip().lower()
    if clearance_mode not in {"none", "manual", "flaresolverr"}:
        clearance_mode = str(default_clearance["mode"])

    user_agent = str(clearance_source.get("user_agent") or default_clearance["user_agent"]).strip()
    browser = str(clearance_source.get("browser") or default_clearance["browser"]).strip()

    existing_clearance_cookies = str(source.get("_existing_cf_cookies") or "").strip()
    existing_cf_clearance = str(source.get("_existing_cf_clearance") or "").strip()
    cf_cookies = str(clearance_source.get("cf_cookies") or "").strip()
    cf_clearance = str(clearance_source.get("cf_clearance") or "").strip()
    if not cf_cookies and _normalize_bool(clearance_source.get("has_cf_cookies"), False):
        cf_cookies = existing_clearance_cookies
    if not cf_clearance and _normalize_bool(clearance_source.get("has_cf_clearance"), False):
        cf_clearance = existing_cf_clearance

    try:
        timeout_sec = max(1, int(clearance_source.get("timeout_sec") or default_clearance["timeout_sec"]))
    except (TypeError, ValueError):
        timeout_sec = int(default_clearance["timeout_sec"])
    try:
        refresh_interval = max(0, int(clearance_source.get("refresh_interval") or default_clearance["refresh_interval"]))
    except (TypeError, ValueError):
        refresh_interval = int(default_clearance["refresh_interval"])

    return {
        "enabled": _normalize_bool(source.get("enabled"), bool(DEFAULT_PROXY_RUNTIME["enabled"])),
        "egress_mode": egress_mode,
        "proxy_url": str(source.get("proxy_url") or "").strip(),
        "resource_proxy_url": str(source.get("resource_proxy_url") or "").strip(),
        "skip_ssl_verify": _normalize_bool(source.get("skip_ssl_verify"), bool(DEFAULT_PROXY_RUNTIME["skip_ssl_verify"])),
        "reset_session_status_codes": _normalize_status_codes(source.get("reset_session_status_codes")),
        "clearance": {
            "enabled": _normalize_bool(clearance_source.get("enabled"), bool(default_clearance["enabled"])),
            "mode": clearance_mode,
            "cf_cookies": cf_cookies,
            "cf_clearance": cf_clearance,
            "user_agent": user_agent or str(default_clearance["user_agent"]),
            "browser": browser or str(default_clearance["browser"]),
            "flaresolverr_url": str(clearance_source.get("flaresolverr_url") or "").strip().rstrip("/"),
            "timeout_sec": timeout_sec,
            "refresh_interval": refresh_interval,
            "warm_up_on_start": _normalize_bool(
                clearance_source.get("warm_up_on_start"),
                bool(default_clearance["warm_up_on_start"]),
            ),
        },
    }



def _normalize_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    if value is None:
        return default
    return bool(value)


def _normalize_positive_int(value: object, default: int, minimum: int = 0) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        normalized = default
    return max(minimum, normalized)


def _normalize_image_storage_settings(value: object) -> dict[str, object]:
    source = value if isinstance(value, dict) else {}
    mode = str(source.get("mode") or DEFAULT_IMAGE_STORAGE["mode"]).strip().lower()
    if mode not in {"local", "webdav", "both"}:
        mode = "local"
    enabled = _normalize_bool(source.get("enabled"), False)
    if not enabled:
        mode = "local"
    return {
        "enabled": enabled,
        "mode": mode,
        "webdav_url": str(source.get("webdav_url") or "").strip().rstrip("/"),
        "webdav_username": str(source.get("webdav_username") or "").strip(),
        "webdav_password": str(source.get("webdav_password") or "").strip(),
        "webdav_root_path": str(source.get("webdav_root_path") or DEFAULT_IMAGE_STORAGE["webdav_root_path"]).strip().strip("/"),
        "public_base_url": str(source.get("public_base_url") or "").strip().rstrip("/"),
    }


def _normalize_chat_completion_cache_settings(value: object) -> dict[str, object]:
    source = value if isinstance(value, dict) else {}
    return {
        "enabled": _normalize_bool(source.get("enabled"), bool(DEFAULT_CHAT_COMPLETION_CACHE["enabled"])),
        "ttl_seconds": _normalize_positive_int(source.get("ttl_seconds"), int(DEFAULT_CHAT_COMPLETION_CACHE["ttl_seconds"]), 0),
        "max_entries": _normalize_positive_int(source.get("max_entries"), int(DEFAULT_CHAT_COMPLETION_CACHE["max_entries"]), 1),
        "dedupe_inflight": _normalize_bool(source.get("dedupe_inflight"), bool(DEFAULT_CHAT_COMPLETION_CACHE["dedupe_inflight"])),
        "stream_cache": _normalize_bool(source.get("stream_cache"), bool(DEFAULT_CHAT_COMPLETION_CACHE["stream_cache"])),
        "normalize_messages": _normalize_bool(source.get("normalize_messages"), bool(DEFAULT_CHAT_COMPLETION_CACHE["normalize_messages"])),
        "drop_adjacent_duplicates": _normalize_bool(source.get("drop_adjacent_duplicates"), bool(DEFAULT_CHAT_COMPLETION_CACHE["drop_adjacent_duplicates"])),
        "drop_assistant_history": _normalize_bool(source.get("drop_assistant_history"), bool(DEFAULT_CHAT_COMPLETION_CACHE["drop_assistant_history"])),
    }


class ConfigSaveError(RuntimeError):
    pass


class ConfigStore:
    def __init__(self, path: Path):
        self.path = path
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.data = self._load()
        if not self.auth_key:
            raise ValueError(
                "❌ auth-key 未设置！\n"
                "请按以下任意一种方式解决：\n"
                "1. 在 Render 的 Environment 变量中添加：\n"
                "   CHATGPT2API_AUTH_KEY = your_real_auth_key\n"
                "2. 或者在 config.json 中填写：\n"
                '   "auth-key": "your_real_auth_key"'
            )

    def _load(self) -> dict[str, object]:
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self) -> None:
        try:
            self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            raise ConfigSaveError(f"配置文件不可写：{self.path}") from exc

    @property
    def auth_key(self) -> str:
        return str(os.getenv("CHATGPT2API_AUTH_KEY") or self.data.get("auth-key") or "").strip()

    @property
    def accounts_file(self) -> Path:
        return DATA_DIR / "accounts.json"

    @property
    def refresh_account_interval_minute(self) -> int:
        try:
            return int(self.data.get("refresh_account_interval_minute", 60))
        except (TypeError, ValueError):
            return 60

    @property
    def auto_remove_abnormal_accounts(self) -> bool:
        return self.data.get("auto_remove_abnormal_accounts") is True

    @property
    def auto_remove_invalid_accounts(self) -> bool:
        return self._bool_setting("auto_remove_invalid_accounts", bool(self.auto_remove_abnormal_accounts))

    @property
    def image_retention_days(self) -> int:
        try:
            return max(1, int(self.data.get("image_retention_days", 30)))
        except (TypeError, ValueError):
            return 30

    @property
    def log_levels(self) -> list[str]:
        levels = self.data.get("log_levels")
        if not isinstance(levels, list):
            return []
        allowed = {"debug", "info", "warning", "error"}
        return [
            level
            for item in levels
            if (level := str(item or "").strip().lower()) in allowed
        ]

    @property
    def sensitive_words(self) -> list[str]:
        words = self.data.get("sensitive_words")
        if not isinstance(words, list):
            return []
        return [word for item in words if (word := str(item or "").strip())]

    @property
    def ai_review(self) -> dict[str, object]:
        value = self.data.get("ai_review")
        return dict(value) if isinstance(value, dict) else {}

    @property
    def global_system_prompt(self) -> str:
        return str(self.data.get("global_system_prompt") or "").strip()

    @property
    def base_url(self) -> str:
        return str(os.getenv("CHATGPT2API_BASE_URL") or self.data.get("base_url") or "").strip().rstrip("/")

    @property
    def images_dir(self) -> Path:
        path = DATA_DIR / "images"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def cleanup_old_images(self) -> int:
        cutoff = time.time() - self.image_retention_days * 86400
        removed = 0
        for path in self.images_dir.rglob("*"):
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        for path in sorted(
            (path for path in self.images_dir.rglob("*") if path.is_dir()),
            key=lambda item: len(item.parts),
            reverse=True,
        ):
            try:
                path.rmdir()
            except OSError:
                pass
        return removed

    def _bool_setting(self, key: str, default: bool = False) -> bool:
        value = self.data.get(key, default)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    @property
    def image_poll_timeout_secs(self) -> int:
        try:
            return max(30, int(self.data.get("image_poll_timeout_secs", 180)))
        except (TypeError, ValueError):
            return 180

    @property
    def image_poll_interval_secs(self) -> float:
        try:
            return max(1.0, float(self.data.get("image_poll_interval_secs", 5.0)))
        except (TypeError, ValueError):
            return 5.0

    @property
    def image_poll_initial_wait_secs(self) -> float:
        try:
            return max(0.0, float(self.data.get("image_poll_initial_wait_secs", 8.0)))
        except (TypeError, ValueError):
            return 8.0

    @property
    def image_account_concurrency(self) -> int:
        try:
            return max(1, int(self.data.get("image_account_concurrency", 20)))
        except (TypeError, ValueError):
            return 20

    @property
    def image_global_concurrency(self) -> int:
        try:
            return max(1, int(self.data.get("image_global_concurrency", 20)))
        except (TypeError, ValueError):
            return 20

    @property
    def image_upstream_cooldown_secs(self) -> int:
        try:
            return max(0, int(self.data.get("image_upstream_cooldown_secs", 600)))
        except (TypeError, ValueError):
            return 600

    @property
    def image_parallel_generation(self) -> bool:
        return self._bool_setting("image_parallel_generation", True)

    @property
    def image_conduit_flow_enabled(self) -> bool:
        return self._bool_setting("image_conduit_flow_enabled", True)

    @property
    def image_default_model_slug(self) -> str:
        value = str(self.data.get("image_default_model_slug") or "gpt-5-5-thinking").strip()
        return value or "gpt-5-5-thinking"

    @property
    def image_fallback_model_slug(self) -> str:
        value = str(self.data.get("image_fallback_model_slug") or "gpt-5-3").strip()
        return value or "gpt-5-3"

    @property
    def image_settle_enabled(self) -> bool:
        return self._bool_setting("image_settle_enabled", False)

    @property
    def image_check_before_hit_enabled(self) -> bool:
        return self._bool_setting("image_check_before_hit_enabled", False)

    @property
    def image_settle_secs(self) -> float:
        try:
            return max(0.5, float(self.data.get("image_settle_secs", 2.0)))
        except (TypeError, ValueError):
            return 2.0

    @property
    def image_timeout_retry_secs(self) -> int:
        try:
            return max(5, int(self.data.get("image_timeout_retry_secs", 60)))
        except (TypeError, ValueError):
            return 60

    @property
    def psd_task_price(self) -> int:
        try:
            return max(0, int(self.data.get("psd_task_price", 1)))
        except (TypeError, ValueError):
            return 1

    def get(self) -> dict[str, object]:
        data = dict(self.data)
        data["site_title"] = str(data.get("site_title") or DEFAULT_SITE_TITLE).strip() or DEFAULT_SITE_TITLE
        data["image_poll_timeout_secs"] = self.image_poll_timeout_secs
        data["image_poll_interval_secs"] = self.image_poll_interval_secs
        data["image_poll_initial_wait_secs"] = self.image_poll_initial_wait_secs
        data["image_account_concurrency"] = self.image_account_concurrency
        data["image_global_concurrency"] = self.image_global_concurrency
        data["image_upstream_cooldown_secs"] = self.image_upstream_cooldown_secs
        data["image_parallel_generation"] = self.image_parallel_generation
        data["image_conduit_flow_enabled"] = self.image_conduit_flow_enabled
        data["image_default_model_slug"] = self.image_default_model_slug
        data["image_fallback_model_slug"] = self.image_fallback_model_slug
        data["image_settle_enabled"] = self.image_settle_enabled
        data["image_check_before_hit_enabled"] = self.image_check_before_hit_enabled
        data["image_settle_secs"] = self.image_settle_secs
        data["image_timeout_retry_secs"] = self.image_timeout_retry_secs
        data["psd_task_price"] = self.psd_task_price
        data["image_retention_days"] = self.image_retention_days
        data["auto_remove_invalid_accounts"] = self.auto_remove_invalid_accounts
        data["log_levels"] = self.log_levels
        data["sensitive_words"] = self.sensitive_words
        data["ai_review"] = self.ai_review
        data["prompt_optimizer"] = self.get_prompt_optimizer_settings().public_dict()
        data["editable_studio"] = self.get_studio_settings().public_dict()
        data["global_system_prompt"] = self.global_system_prompt
        data["image_storage"] = self.get_image_storage_settings()
        data["chat_completion_cache"] = self.get_chat_completion_cache_settings()
        data["proxy_runtime"] = self.get_proxy_runtime_settings()
        return data

    def get_site_title(self) -> str:
        return str(self.get().get("site_title") or DEFAULT_SITE_TITLE).strip() or DEFAULT_SITE_TITLE

    @staticmethod
    def _normalize_quick_prompt(item: Any, index: int) -> dict[str, str] | None:
        if not isinstance(item, dict):
            return None
        content = str(item.get("content") or item.get("prompt") or "").strip()
        if not content:
            return None
        label = str(item.get("label") or item.get("name") or "").strip() or f"快捷提示词 {index + 1}"
        return {
            "label": label[:40],
            "content": content[:1200],
        }

    def get_quick_prompts(self) -> list[dict[str, str]]:
        raw_items = self.data.get("quick_prompts")
        if not isinstance(raw_items, list):
            raw_items = DEFAULT_QUICK_PROMPTS
        items: list[dict[str, str]] = []
        for index, item in enumerate(raw_items):
            normalized = self._normalize_quick_prompt(item, index)
            if normalized:
                items.append(normalized)
        return items[:50]

    def get_proxy_settings(self) -> str:
        return str(self.data.get("proxy") or "").strip()

    def get_proxy_runtime_settings(self) -> dict[str, object]:
        return _normalize_proxy_runtime_settings(self.data.get("proxy_runtime"))

    @staticmethod
    def _normalize_image_upstream(item: Any, index: int) -> dict[str, object] | None:
        if not isinstance(item, dict):
            return None
        base_url = str(item.get("base_url") or "").strip().rstrip("/")
        api_key = str(item.get("api_key") or "").strip()
        if not base_url or not api_key:
            return None
        name = str(item.get("name") or "").strip() or f"上游 {index + 1}"
        model = str(item.get("model") or "").strip() or "gpt-image-2"
        return {
            "name": name,
            "base_url": base_url,
            "api_key": api_key,
            "model": model,
            "enabled": bool(item.get("enabled", True)),
        }

    def get_image_upstreams(self) -> list[dict[str, object]]:
        raw_items = self.data.get("image_upstreams")
        if not isinstance(raw_items, list):
            raw_items = [DEFAULT_IMAGE_UPSTREAM]
        items: list[dict[str, object]] = []
        for index, item in enumerate(raw_items):
            normalized = self._normalize_image_upstream(item, index)
            if normalized:
                items.append(normalized)
        return items

    def get_enabled_image_upstreams(self) -> list[dict[str, object]]:
        items = [item for item in self.get_image_upstreams() if item.get("enabled")]
        return items or self.get_image_upstreams()

    def get_image_storage_settings(self) -> dict[str, object]:
        return _normalize_image_storage_settings(self.data.get("image_storage"))

    def get_chat_completion_cache_settings(self) -> dict[str, object]:
        return _normalize_chat_completion_cache_settings(self.data.get("chat_completion_cache"))

    def update(self, data: dict[str, object]) -> dict[str, object]:
        previous_data = self.data
        next_data = dict(data or {})
        previous_optimizer = self.data.get("prompt_optimizer") or {}
        previous_studio = self.data.get("editable_studio") or {}
        if "editable_studio" in next_data:
            try:
                next_data["editable_studio"] = merge_studio_settings(next_data["editable_studio"], previous_studio)
            except (ValueError, TypeError):
                raise ValueError("文档工作室配置无效，请检查连接、预算和限额") from None
        elif previous_studio:
            next_data["editable_studio"] = previous_studio
        if "prompt_optimizer" in next_data:
            try:
                next_data["prompt_optimizer"] = merge_optimizer_settings(next_data["prompt_optimizer"], previous_optimizer)
            except (ValueError, TypeError):
                raise ValueError("提示词优化配置无效，请检查 API 地址、密钥、模型和限额范围") from None
        elif previous_optimizer:
            next_data["prompt_optimizer"] = previous_optimizer
        self.data = next_data
        if "image_storage" in self.data:
            self.data["image_storage"] = _normalize_image_storage_settings(self.data.get("image_storage"))
        if "chat_completion_cache" in self.data:
            self.data["chat_completion_cache"] = _normalize_chat_completion_cache_settings(self.data.get("chat_completion_cache"))
        if "proxy_runtime" in self.data:
            incoming_runtime = self.data.get("proxy_runtime")
            if isinstance(incoming_runtime, dict):
                previous_clearance = self.get_proxy_runtime_settings().get("clearance")
                if isinstance(previous_clearance, dict):
                    incoming_runtime = dict(incoming_runtime)
                    incoming_runtime["_existing_cf_cookies"] = previous_clearance.get("cf_cookies")
                    incoming_runtime["_existing_cf_clearance"] = previous_clearance.get("cf_clearance")
            self.data["proxy_runtime"] = _normalize_proxy_runtime_settings(incoming_runtime)
        try:
            self._save()
        except ConfigSaveError:
            self.data = previous_data
            raise
        return self.get()

    def get_prompt_optimizer_settings(self) -> PromptOptimizerSettings:
        return PromptOptimizerSettings.model_validate(self.data.get("prompt_optimizer") or {})

    def get_studio_settings(self) -> StudioSettings:
        return StudioSettings.model_validate(self.data.get("editable_studio") or {})


config = ConfigStore(CONFIG_FILE)

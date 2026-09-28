from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import base64
import hashlib
import json
from pathlib import Path
from threading import Lock
from typing import Any
from datetime import datetime

from curl_cffi.requests import Session

from services.config import config
from services.proxy_service import proxy_settings


class AccountService:
    ACCOUNT_TYPE_MAP = {
        "free": "Free",
        "普通": "Free",
        "免费": "Free",
        "plus": "Plus",
        "team": "Team",
        "pro": "Pro",
        "enterprise": "Enterprise",
    }
    PLAN_KEY_HINTS = ("plan", "subscription", "tier", "sku", "billing")
    DEFAULT_FREE_IMAGE_QUOTA = 3

    def __init__(self, store_file: Path):
        self.store_file = store_file
        self._lock = Lock()
        self._index = 0
        self._accounts = self._load_accounts()
        self._inflight_image_tokens: set[str] = set()

    @staticmethod
    def _clean_token(value: Any) -> str:
        return str(value or "").strip()

    @staticmethod
    def _decode_jwt_payload(token: str) -> dict[str, Any]:
        parts = str(token or "").split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        try:
            decoded = base64.urlsafe_b64decode(payload.encode("utf-8"))
            data = json.loads(decoded.decode("utf-8"))
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _normalize_source_type(value: object) -> str:
        return str(value or "web").strip().lower() or "web"

    @classmethod
    def _account_matches_any_plan_type(
        cls,
        account: dict,
        plan_types: set[str] | tuple[str, ...] | list[str] | None = None,
    ) -> bool:
        if not plan_types:
            return True
        normalized_account = cls._normalize_account_type(account.get("type"))
        normalized_plans = {
            normalized
            for item in plan_types
            if (normalized := cls._normalize_account_type(item))
        }
        return bool(normalized_account and normalized_account in normalized_plans)

    @classmethod
    def _account_matches_source_type(cls, account: dict, source_type: str | None = None) -> bool:
        normalized_source = cls._normalize_source_type(source_type or "default")
        normalized_account = cls._normalize_source_type(account.get("source_type"))
        if normalized_source == "default":
            return normalized_account != "gptfree"
        return normalized_account == normalized_source

    def _clean_tokens(self, tokens: list[str]) -> list[str]:
        cleaned: list[str] = []
        seen = set()
        for token in tokens:
            value = self._clean_token(token)
            if value and value not in seen:
                seen.add(value)
                cleaned.append(value)
        return cleaned

    def _find_account_index(self, access_token: str) -> int:
        for index, item in enumerate(self._accounts):
            if self._clean_token(item.get("access_token")) == access_token:
                return index
        return -1

    @staticmethod
    def _is_image_account_available(account: dict) -> bool:
        if not isinstance(account, dict):
            return False
        if account.get("status") == "禁用":
            return False
        return int(account.get("quota") or 0) > 0

    def _decode_access_token_payload(self, access_token: str) -> dict[str, Any]:
        return self._decode_jwt_payload(access_token)

    @classmethod
    def _normalize_account_type(cls, value: Any) -> str | None:
        return cls.ACCOUNT_TYPE_MAP.get(cls._clean_token(value).lower())

    def _search_account_type(self, value: Any) -> str | None:
        if isinstance(value, dict):
            for key, item in value.items():
                key_text = self._clean_token(key).lower()
                matched = self._normalize_account_type(item)
                if matched and (any(flag in key_text for flag in self.PLAN_KEY_HINTS) or key_text in {"chatgpt_plan_type", "plan_type"}):
                    return matched
            for item in value.values():
                matched = self._search_account_type(item)
                if matched:
                    return matched
            return None
        if isinstance(value, list):
            for item in value:
                matched = self._search_account_type(item)
                if matched:
                    return matched
            return None
        return self._normalize_account_type(value)

    def _detect_account_type(self, access_token: str, me_payload: Any, init_payload: Any) -> str:
        token_payload = self._decode_access_token_payload(access_token)

        auth_payload = token_payload.get("https://api.openai.com/auth")
        if isinstance(auth_payload, dict):
            matched = self._normalize_account_type(auth_payload.get("chatgpt_plan_type"))
            if matched:
                return matched

        for payload in (me_payload, init_payload, token_payload):
            matched = self._search_account_type(payload)
            if matched:
                return matched

        return "Free"

    def _normalize_account(self, item: dict) -> dict | None:
        if not isinstance(item, dict):
            return None
        access_token = self._clean_token(item.get("access_token"))
        if not access_token:
            return None
        normalized = dict(item)
        normalized["access_token"] = access_token
        normalized["type"] = self._clean_token(normalized.get("type")) or "Free"
        normalized["status"] = self._clean_token(normalized.get("status")) or "正常"
        normalized["quota"] = int(normalized.get("quota") if normalized.get("quota") is not None else 0)
        if normalized["quota"] < 0:
            normalized["quota"] = 0
        normalized["image_quota_unknown"] = bool(normalized.get("image_quota_unknown"))
        normalized["email"] = self._clean_token(normalized.get("email")) or None
        normalized["user_id"] = self._clean_token(normalized.get("user_id")) or None
        source_type = normalized.get("source_type")
        if not source_type and self._clean_token(normalized.get("export_type")).lower() == "codex":
            source_type = "codex"
        normalized["source_type"] = self._normalize_source_type(source_type)
        limits_progress = normalized.get("limits_progress")
        normalized["limits_progress"] = limits_progress if isinstance(limits_progress, list) else []
        normalized["default_model_slug"] = self._clean_token(normalized.get("default_model_slug")) or None
        normalized["restore_at"] = self._clean_token(normalized.get("restore_at")) or None
        normalized["success"] = int(normalized.get("success") or 0)
        normalized["fail"] = int(normalized.get("fail") or 0)
        normalized["last_used_at"] = normalized.get("last_used_at")
        return normalized

    @staticmethod
    def _extract_quota_and_restore_at(limits_progress: list[Any]) -> tuple[int, str | None]:
        quota = 0
        restore_at = None
        for item in limits_progress:
            if not isinstance(item, dict) or item.get("feature_name") != "image_gen":
                continue
            quota = int(item.get("remaining") or 0)
            restore_at = str(item.get("reset_after") or "").strip() or None
            break
        return quota, restore_at

    def _load_accounts(self) -> list[dict]:
        if not self.store_file.exists():
            return []
        try:
            data = json.loads(self.store_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
        if not isinstance(data, list):
            return []
        return [normalized for item in data if (normalized := self._normalize_account(item)) is not None]

    def _save_accounts(self) -> None:
        self.store_file.parent.mkdir(parents=True, exist_ok=True)
        self.store_file.write_text(
            json.dumps(self._accounts, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _build_remote_headers(self, access_token: str) -> tuple[dict[str, str], str]:
        account = self.get_account(access_token) or {}
        user_agent = self._clean_token(account.get("user-agent") or account.get("user_agent"))
        impersonate = self._clean_token(account.get("impersonate")) or "chrome110"
        headers = {
            "authorization": f"Bearer {access_token}",
            "accept": "*/*",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            "content-type": "application/json",
            "oai-language": "zh-CN",
            "origin": "https://chatgpt.com",
            "referer": "https://chatgpt.com/",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent": user_agent
            or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "sec-ch-ua": self._clean_token(account.get("sec-ch-ua"))
            or '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
            "sec-ch-ua-mobile": self._clean_token(account.get("sec-ch-ua-mobile")) or "?0",
            "sec-ch-ua-platform": self._clean_token(account.get("sec-ch-ua-platform")) or '"Windows"',
        }
        device_id = self._clean_token(account.get("oai-device-id") or account.get("oai_device_id"))
        session_id = self._clean_token(account.get("oai-session-id") or account.get("oai_session_id"))
        if device_id:
            headers["oai-device-id"] = device_id
        if session_id:
            headers["oai-session-id"] = session_id
        return headers, impersonate

    def _public_items(self, accounts: list[dict]) -> list[dict]:
        return [
            {
                "id": hashlib.sha1(access_token.encode("utf-8")).hexdigest()[:16],
                "access_token": access_token,
                "type": account.get("type") or "Free",
                "status": account.get("status") or "正常",
                "quota": account.get("quota") if account.get("quota") is not None else 0,
                "email": account.get("email"),
                "user_id": account.get("user_id"),
                "source_type": account.get("source_type") or "web",
                "limits_progress": account.get("limits_progress") or [],
                "default_model_slug": account.get("default_model_slug"),
                "restoreAt": account.get("restore_at"),
                "success": int(account.get("success") or 0),
                "fail": int(account.get("fail") or 0),
                "lastUsedAt": account.get("last_used_at"),
            }
            for account in accounts
            if (access_token := self._clean_token(account.get("access_token")))
        ]

    def list_tokens(self) -> list[str]:
        with self._lock:
            return [token for item in self._accounts if (token := self._clean_token(item.get("access_token")))]

    def _list_available_candidate_tokens(
        self,
        excluded_tokens: set[str] | None = None,
        *,
        plan_type: str | None = None,
        source_type: str | None = None,
        plan_types: set[str] | tuple[str, ...] | list[str] | None = None,
        exclude_inflight_image: bool = False,
    ) -> list[str]:
        excluded = {self._clean_token(token) for token in (excluded_tokens or set()) if self._clean_token(token)}
        normalized_plan = self._normalize_account_type(plan_type) if plan_type else None
        return [
            token
            for item in self._accounts
            if self._is_image_account_available(item)
            and (not normalized_plan or self._normalize_account_type(item.get("type")) == normalized_plan)
            and self._account_matches_any_plan_type(item, plan_types)
            and self._account_matches_source_type(item, source_type)
            and (token := self._clean_token(item.get("access_token")))
            and token not in excluded
            and (not exclude_inflight_image or token not in self._inflight_image_tokens)
        ]

    def _pick_next_candidate_token(
        self,
        excluded_tokens: set[str] | None = None,
        *,
        plan_type: str | None = None,
        source_type: str | None = None,
        plan_types: set[str] | tuple[str, ...] | list[str] | None = None,
        exclude_inflight_image: bool = False,
    ) -> str:
        with self._lock:
            tokens = self._list_available_candidate_tokens(
                excluded_tokens,
                plan_type=plan_type,
                source_type=source_type,
                plan_types=plan_types,
                exclude_inflight_image=exclude_inflight_image,
            )
            if not tokens:
                label = " ".join(item for item in (plan_type, source_type) if item)
                raise RuntimeError(f"No available {label + ' ' if label else ''}tokens found in {self.store_file}")
            access_token = tokens[self._index % len(tokens)]
            self._index += 1
            return access_token

    def _handle_abnormal_account(self, access_token: str) -> str:
        if config.auto_remove_abnormal_accounts:
            removed = self.delete_accounts([access_token]).get("removed", 0)
            return "检测到封号，已自动移除" if removed else "检测到封号，账号已不在号池"
        self.update_account(
            access_token,
            {
                "status": "异常",
                "quota": 0,
            },
        )
        return "检测到封号"

    def refresh_account_state(self, access_token: str) -> dict | None:
        try:
            remote_info = self.fetch_remote_info(access_token)
        except Exception as exc:
            message = str(exc)
            print(f"[account-available] refresh token={access_token[:12]}... fail {message}")
            if "/backend-api/me failed: HTTP 401" in message:
                self._handle_abnormal_account(access_token)
            return None
        return self.update_account(access_token, remote_info)

    def get_available_access_token(
        self,
        *,
        plan_type: str | None = None,
        source_type: str | None = None,
        plan_types: set[str] | tuple[str, ...] | list[str] | None = None,
        reserve_for_image: bool = False,
    ) -> str:
        attempted_tokens: set[str] = set()
        while True:
            access_token = self._pick_next_candidate_token(
                excluded_tokens=attempted_tokens,
                plan_type=plan_type,
                source_type=source_type,
                plan_types=plan_types,
                exclude_inflight_image=reserve_for_image,
            )
            attempted_tokens.add(access_token)
            account = self.refresh_account_state(access_token)
            if (
                self._is_image_account_available(account or {})
                and self._account_matches_any_plan_type(account or {}, plan_types)
                and self._account_matches_source_type(account or {}, source_type)
                and (not plan_type or self._normalize_account_type((account or {}).get("type")) == self._normalize_account_type(plan_type))
            ):
                if reserve_for_image:
                    with self._lock:
                        if access_token in self._inflight_image_tokens:
                            continue
                        self._inflight_image_tokens.add(access_token)
                return access_token
            print(
                f"[account-available] skip token={access_token[:12]}... "
                f"quota={account.get('quota') if account else 'unknown'} "
                f"status={account.get('status') if account else 'unknown'}"
            )

    def release_image_token(self, access_token: str) -> None:
        access_token = self._clean_token(access_token)
        if not access_token:
            return
        with self._lock:
            self._inflight_image_tokens.discard(access_token)

    def next_token(self) -> str:
        return self.get_available_access_token()

    def get_text_access_token(
        self,
        excluded_tokens: set[str] | None = None,
        source_type: str | None = "default",
        *,
        refresh: bool = True,
    ) -> str:
        excluded = {self._clean_token(token) for token in (excluded_tokens or set()) if self._clean_token(token)}
        with self._lock:
            candidates = [
                token
                for item in self._accounts
                if str(item.get("status") or "").strip() not in {"禁用", "异常"}
                and self._account_matches_source_type(item, source_type)
                and (token := self._clean_token(item.get("access_token")))
                and token not in excluded
            ]
            if not candidates:
                return ""
            access_token = candidates[self._index % len(candidates)]
            self._index += 1
        if not refresh:
            return access_token
        return self.refresh_access_token(access_token, event="get_text_access_token") or access_token

    def refresh_access_token(self, access_token: str, *, force: bool = False, event: str = "refresh_access_token") -> str:
        # This branch does not store refresh_token yet; keep the method for upstream protocol compatibility.
        return self._clean_token(access_token)

    def mark_text_used(self, access_token: str) -> None:
        access_token = self._clean_token(access_token)
        if not access_token:
            return
        with self._lock:
            index = self._find_account_index(access_token)
            if index < 0:
                return
            item = dict(self._accounts[index])
            item["last_used_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            item["success"] = int(item.get("success") or 0) + 1
            account = self._normalize_account(item)
            if account is not None:
                self._accounts[index] = account
                self._save_accounts()

    def remove_invalid_token(self, access_token: str, event: str = "invalid_token", quiet: bool = False) -> bool:
        if config.auto_remove_invalid_accounts:
            return bool(self.delete_accounts([access_token]).get("removed", 0))
        self.update_account(access_token, {"status": "异常", "quota": 0})
        return False

    def get_account(self, access_token: str) -> dict | None:
        access_token = self._clean_token(access_token)
        if not access_token:
            return None
        with self._lock:
            index = self._find_account_index(access_token)
            if index >= 0:
                return dict(self._accounts[index])
        return None

    def list_accounts(self) -> list[dict]:
        with self._lock:
            return self._public_items(self._accounts)

    def list_limited_tokens(self) -> list[str]:
        with self._lock:
            return [
                token
                for item in self._accounts
                if item.get("status") == "限流"
                and (token := self._clean_token(item.get("access_token")))
            ]

    def remove_abnormal_accounts(self) -> dict:
        with self._lock:
            before = len(self._accounts)
            self._accounts = [item for item in self._accounts if item.get("status") != "异常"]
            removed = before - len(self._accounts)
            if self._accounts:
                self._index %= len(self._accounts)
            else:
                self._index = 0
            if removed:
                self._save_accounts()
            items = self._public_items(self._accounts)
        return {"removed": removed, "items": items}

    def add_accounts(self, tokens: list[str]) -> dict:
        cleaned_tokens = self._clean_tokens(tokens)
        if not cleaned_tokens:
            return {"added": 0, "skipped": 0, "items": self.list_accounts()}

        with self._lock:
            indexed = {self._clean_token(item.get("access_token")): dict(item) for item in self._accounts}
            added = 0
            skipped = 0
            for access_token in cleaned_tokens:
                current = indexed.get(access_token)
                if current is None:
                    added += 1
                    current = {}
                else:
                    skipped += 1
                account = self._normalize_account(
                    {
                        **current,
                        "access_token": access_token,
                        "type": str(current.get("type") or "Free"),
                    }
                )
                if account is not None:
                    indexed[access_token] = account
            self._accounts = list(indexed.values())
            self._save_accounts()
            items = self._public_items(self._accounts)
        return {"added": added, "skipped": skipped, "items": items}

    def add_account(self, access_token: str, metadata: dict | None = None) -> dict | None:
        access_token = self._clean_token(access_token)
        if not access_token:
            return None
        metadata = metadata if isinstance(metadata, dict) else {}
        with self._lock:
            index = self._find_account_index(access_token)
            current = dict(self._accounts[index]) if index >= 0 else {}
            account = self._normalize_account({**current, **metadata, "access_token": access_token})
            if account is None:
                return None
            if index >= 0:
                self._accounts[index] = account
            else:
                self._accounts.append(account)
            self._save_accounts()
            return dict(account)

    def delete_accounts(self, tokens: list[str]) -> dict:
        target_set = set(self._clean_tokens(tokens))
        if not target_set:
            return {"removed": 0, "items": self.list_accounts()}
        with self._lock:
            before = len(self._accounts)
            self._accounts = [item for item in self._accounts if self._clean_token(item.get("access_token")) not in target_set]
            removed = before - len(self._accounts)
            if self._accounts:
                self._index %= len(self._accounts)
            else:
                self._index = 0
            if removed:
                self._save_accounts()
            items = self._public_items(self._accounts)
        return {"removed": removed, "items": items}

    def remove_token(self, access_token: str) -> bool:
        return bool(self.delete_accounts([access_token])["removed"])

    def update_account(self, access_token: str, updates: dict) -> dict | None:
        access_token = self._clean_token(access_token)
        if not access_token:
            return None
        with self._lock:
            index = self._find_account_index(access_token)
            if index < 0:
                return None
            account = self._normalize_account({**self._accounts[index], **updates, "access_token": access_token})
            if account is None:
                return None
            self._accounts[index] = account
            self._save_accounts()
            return dict(account)
        return None

    def mark_image_result(self, access_token: str, success: bool) -> dict | None:
        access_token = self._clean_token(access_token)
        if not access_token:
            return None
        with self._lock:
            index = self._find_account_index(access_token)
            if index < 0:
                return None
            next_item = dict(self._accounts[index])
            next_item["last_used_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            if success:
                next_item["success"] = int(next_item.get("success") or 0) + 1
                next_item["quota"] = max(0, int(next_item.get("quota") or 0) - 1)
                if next_item["quota"] == 0:
                    next_item["status"] = "限流"
                    next_item["restore_at"] = next_item.get("restore_at") or None
                elif next_item.get("status") == "限流":
                    next_item["status"] = "正常"
            else:
                next_item["fail"] = int(next_item.get("fail") or 0) + 1
            account = self._normalize_account(next_item)
            if account is None:
                return None
            self._accounts[index] = account
            self._save_accounts()
            return dict(account)
        return None

    def fetch_remote_info(self, access_token: str) -> dict[str, Any]:
        access_token = self._clean_token(access_token)
        if not access_token:
            raise ValueError("access_token is required")

        account = self.get_account(access_token) or {}
        headers, impersonate = self._build_remote_headers(access_token)
        print(f"[account-refresh] start {access_token[:12]}...")
        session = Session(**proxy_settings.build_session_kwargs(
            account=account,
            upstream=True,
            impersonate=impersonate,
            verify=True,
        ))
        session.headers.update(headers)
        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                me_future = executor.submit(
                    session.get,
                    "https://chatgpt.com/backend-api/me",
                    headers={
                        "x-openai-target-path": "/backend-api/me",
                        "x-openai-target-route": "/backend-api/me",
                    },
                    timeout=20,
                )
                init_future = executor.submit(
                    session.post,
                    "https://chatgpt.com/backend-api/conversation/init",
                    json={
                        "gizmo_id": None,
                        "requested_default_model": None,
                        "conversation_id": None,
                        "timezone_offset_min": -480,
                    },
                    timeout=20,
                )

                me_response = me_future.result()
                init_response = init_future.result()

            if me_response.status_code != 200:
                raise RuntimeError(f"/backend-api/me failed: HTTP {me_response.status_code}")
            me_payload = me_response.json()

            if init_response.status_code != 200:
                raise RuntimeError(f"/backend-api/conversation/init failed: HTTP {init_response.status_code}")
            init_payload = init_response.json()

            limits_progress = init_payload.get("limits_progress")
            if not isinstance(limits_progress, list):
                limits_progress = []

            account_type = self._detect_account_type(access_token, me_payload, init_payload)
            quota, restore_at = self._extract_quota_and_restore_at(limits_progress)
            image_quota_unknown = not any(
                isinstance(item, dict) and item.get("feature_name") == "image_gen"
                for item in limits_progress
            )
            current = self.get_account(access_token) or {}
            if image_quota_unknown:
                current_quota = max(0, int(current.get("quota") or 0))
                if account_type == "Free":
                    quota = current_quota if (current.get("image_quota_unknown") or current_quota > 0) else self.DEFAULT_FREE_IMAGE_QUOTA
                    status = "正常" if quota > 0 else "限流"
                else:
                    quota = current_quota
                    status = "正常"
                restore_at = restore_at or (self._clean_token(current.get("restore_at")) or None)
            else:
                status = "限流" if quota == 0 else "正常"

            result = {
                "email": me_payload.get("email"),
                "user_id": me_payload.get("id"),
                "type": account_type,
                "quota": quota,
                "image_quota_unknown": image_quota_unknown,
                "limits_progress": limits_progress,
                "default_model_slug": init_payload.get("default_model_slug"),
                "restore_at": restore_at,
                "status": status,
            }
            print(
                "[account-refresh] ok",
                result.get("user_id"),
                result.get("email"),
                f"quota={result.get('quota')}",
                f"restore_at={result.get('restore_at')}",
            )
            return result
        finally:
            session.close()

    def refresh_accounts(self, access_tokens: list[str]) -> dict[str, Any]:
        cleaned_tokens = self._clean_tokens(access_tokens)
        if not cleaned_tokens:
            return {"refreshed": 0, "errors": [], "items": self.list_accounts()}

        refreshed = 0
        errors: list[dict[str, str]] = []
        max_workers = min(10, len(cleaned_tokens))

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {executor.submit(self.fetch_remote_info, access_token): access_token for access_token in cleaned_tokens}
            for future in as_completed(future_map):
                access_token = future_map[future]
                try:
                    remote_info = future.result()
                    if self.update_account(access_token, remote_info) is not None:
                        refreshed += 1
                except Exception as exc:
                    message = str(exc)
                    print(f"[account-refresh] fail {access_token[:12]}... {message}")
                    if "/backend-api/me failed: HTTP 401" in message:
                        message = self._handle_abnormal_account(access_token)
                    errors.append({"access_token": access_token, "error": message})

        print(f"[account-refresh] done refreshed={refreshed} errors={len(errors)} workers={max_workers}")
        return {
            "refreshed": refreshed,
            "errors": errors,
            "items": self.list_accounts(),
        }


account_service = AccountService(config.accounts_file)

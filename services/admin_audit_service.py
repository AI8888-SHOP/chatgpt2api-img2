"""
管理员操作审计日志。
"""
import json
import os
import time
from pathlib import Path
from threading import RLock
from typing import Any

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "admin_audit_logs.json"
MAX_AUDIT_RECORDS = 5000


def mask_admin_key(value: str) -> str:
    token = str(value or "").strip()
    if not token:
        return ""
    if "(" in token and token.endswith(")"):
        return token[:160]
    if len(token) <= 8:
        return f"{token[:2]}***"
    return f"{token[:6]}***{token[-4:]}"


class AdminAuditService:
    def __init__(self):
        self._records: list[dict[str, Any]] = []
        self._lock = RLock()
        self._load()

    def _load(self) -> None:
        if not DATA_FILE.exists():
            return
        try:
            data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            self._records = data if isinstance(data, list) else []
        except Exception as exc:
            print(f"[admin_audit_service] failed to load records: {exc}")
            self._records = []

    def _save(self) -> None:
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        if len(self._records) > MAX_AUDIT_RECORDS:
            self._records = self._records[-MAX_AUDIT_RECORDS:]
        tmp_file = DATA_FILE.with_suffix(f"{DATA_FILE.suffix}.tmp")
        tmp_file.write_text(json.dumps(self._records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp_file, DATA_FILE)

    def log(self, admin_key: str, action: str, target: str = "", detail: dict[str, Any] | None = None) -> None:
        with self._lock:
            now = int(time.time())
            record = {
                "id": f"{now}_{len(self._records) + 1}",
                "admin": mask_admin_key(admin_key),
                "action": action,
                "target": str(target or "")[:240],
                "detail": detail or {},
                "timestamp": now,
            }
            self._records.append(record)
            self._save()

    def list_records(self, limit: int = 100, offset: int = 0, action: str = "") -> dict[str, Any]:
        with self._lock:
            records = self._records[::-1]
        if action:
            records = [item for item in records if str(item.get("action") or "") == action]
        total = len(records)
        page_records = records[offset:offset + limit]
        return {
            "records": page_records,
            "total": total,
            "offset": offset,
            "limit": limit,
            "has_more": offset + limit < total,
        }


admin_audit_service = AdminAuditService()

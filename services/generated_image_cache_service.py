from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

from services.generated_image_paths import GENERATED_IMAGES_DIR, GENERATED_IMAGES_URL_PREFIX


DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "generated_images.json"
RETENTION_SECONDS = 72 * 60 * 60


class GeneratedImageCacheService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._records: list[dict[str, object]] = []
        self._load()

    def _load(self) -> None:
        if not DATA_FILE.exists():
            self._records = []
            return
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._records = data if isinstance(data, list) else []
        except Exception as exc:
            print(f"[generated_image_cache_service] failed to load records: {exc}")
            self._records = []

    def _save(self) -> None:
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp_file = DATA_FILE.with_suffix(f"{DATA_FILE.suffix}.tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(self._records, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_file, DATA_FILE)

    def _normalize_url(self, url: str) -> str:
        value = str(url or "").strip()
        if not value:
            return ""
        if value.startswith(GENERATED_IMAGES_URL_PREFIX):
            return value
        if value.startswith("/"):
            return value
        return f"{GENERATED_IMAGES_URL_PREFIX}/{value.lstrip('/')}"

    def _resolve_path_from_url(self, url: str) -> Path | None:
        normalized_url = self._normalize_url(url)
        prefix = GENERATED_IMAGES_URL_PREFIX + "/"
        if not normalized_url.startswith(prefix):
            return None
        relative_part = normalized_url[len(prefix):].strip("/")
        if not relative_part:
            return None
        target = (GENERATED_IMAGES_DIR / relative_part).resolve()
        try:
            target.relative_to(GENERATED_IMAGES_DIR.resolve())
        except ValueError:
            return None
        return target

    def _is_expired(self, created_at: object, now: int | None = None) -> bool:
        try:
            timestamp = int(created_at or 0)
        except (TypeError, ValueError):
            timestamp = 0
        if timestamp <= 0:
            return True
        return timestamp < int(now or time.time()) - RETENTION_SECONDS

    def _delete_file(self, target_path: Path | None) -> bool:
        if target_path is None:
            return False
        try:
            target_path.unlink()
        except FileNotFoundError:
            return False

        root_dir = GENERATED_IMAGES_DIR.resolve()
        parent = target_path.parent
        while parent != root_dir and root_dir in parent.resolve().parents:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
        return True

    def _build_record(
        self,
        *,
        url: str,
        created_at: int | None = None,
        content_type: str = "",
        prompt: str = "",
        model: str = "",
        action: str = "",
        api_key: str = "",
        api_key_name: str = "",
    ) -> dict[str, object] | None:
        normalized_url = self._normalize_url(url)
        target_path = self._resolve_path_from_url(normalized_url)
        if not normalized_url or target_path is None:
            return None
        relative_path = target_path.relative_to(GENERATED_IMAGES_DIR.resolve()).as_posix()
        size_bytes = target_path.stat().st_size if target_path.exists() else 0
        return {
            "id": uuid.uuid4().hex,
            "url": normalized_url,
            "relative_path": relative_path,
            "file_name": target_path.name,
            "created_at": int(created_at or time.time()),
            "size_bytes": size_bytes,
            "content_type": str(content_type or ""),
            "prompt": str(prompt or ""),
            "model": str(model or ""),
            "action": str(action or ""),
            "api_key": str(api_key or ""),
            "api_key_name": str(api_key_name or ""),
        }

    def sync_storage(self) -> None:
        GENERATED_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        now = int(time.time())
        with self._lock:
            records_by_url = {
                str(record.get("url") or ""): record
                for record in self._records
                if isinstance(record, dict) and str(record.get("url") or "")
            }
            next_records: list[dict[str, object]] = []

            for file_path in sorted(GENERATED_IMAGES_DIR.rglob("*")):
                if not file_path.is_file():
                    continue
                relative_path = file_path.relative_to(GENERATED_IMAGES_DIR.resolve()).as_posix()
                url = f"{GENERATED_IMAGES_URL_PREFIX}/{relative_path}"
                record = records_by_url.get(url)
                if record is None:
                    record = self._build_record(url=url, created_at=int(file_path.stat().st_mtime))
                    if record is None:
                        continue
                else:
                    record = {
                        **record,
                        "relative_path": relative_path,
                        "file_name": file_path.name,
                        "size_bytes": file_path.stat().st_size,
                    }
                if self._is_expired(record.get("created_at"), now):
                    self._delete_file(file_path)
                    continue
                next_records.append(record)

            next_records.sort(key=lambda item: int(item.get("created_at") or 0), reverse=True)
            if next_records != self._records:
                self._records = next_records
                self._save()

    def prune_expired(self) -> dict[str, int]:
        GENERATED_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        now = int(time.time())
        deleted_files = 0
        deleted_records = 0

        with self._lock:
            next_records: list[dict[str, object]] = []
            known_paths: set[Path] = set()

            for record in self._records:
                target_path = self._resolve_path_from_url(str(record.get("url") or ""))
                if target_path is not None:
                    known_paths.add(target_path.resolve())
                if self._is_expired(record.get("created_at"), now):
                    if self._delete_file(target_path):
                        deleted_files += 1
                    deleted_records += 1
                    continue
                next_records.append(record)

            cutoff = now - RETENTION_SECONDS
            for file_path in GENERATED_IMAGES_DIR.rglob("*"):
                if not file_path.is_file():
                    continue
                resolved_path = file_path.resolve()
                if resolved_path in known_paths:
                    continue
                try:
                    if int(file_path.stat().st_mtime) >= cutoff:
                        continue
                except FileNotFoundError:
                    continue
                if self._delete_file(file_path):
                    deleted_files += 1

            if deleted_records or len(next_records) != len(self._records):
                self._records = next_records
                self._save()

        return {"deleted_records": deleted_records, "deleted_files": deleted_files}

    def record_image(
        self,
        *,
        url: str,
        created_at: int | None = None,
        content_type: str = "",
        prompt: str = "",
        model: str = "",
        action: str = "",
        api_key: str = "",
        api_key_name: str = "",
    ) -> dict[str, object] | None:
        record = self._build_record(
            url=url,
            created_at=created_at,
            content_type=content_type,
            prompt=prompt,
            model=model,
            action=action,
            api_key=api_key,
            api_key_name=api_key_name,
        )
        if record is None:
            return None

        with self._lock:
            normalized_url = str(record["url"])
            existing = next((item for item in self._records if str(item.get("url") or "") == normalized_url), None)
            if existing is None:
                self._records.insert(0, record)
            else:
                existing.update(
                    {
                        key: value
                        for key, value in record.items()
                        if key in {"relative_path", "file_name", "size_bytes", "content_type", "prompt", "model", "action", "api_key", "api_key_name"}
                        and value not in ("", 0)
                    }
                )
            self._records.sort(key=lambda item: int(item.get("created_at") or 0), reverse=True)
            cutoff = int(time.time()) - RETENTION_SECONDS
            next_records = []
            for item in self._records:
                try:
                    created_at_value = int(item.get("created_at") or 0)
                except (TypeError, ValueError):
                    created_at_value = 0
                if created_at_value and created_at_value >= cutoff:
                    next_records.append(item)
                    continue
                self._delete_file(self._resolve_path_from_url(str(item.get("url") or "")))
            self._records = next_records
            self._save()
            return existing or record

    def list_images(
        self,
        *,
        query: str = "",
        action: str = "",
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, object]:
        self.sync_storage()
        normalized_query = str(query or "").strip().lower()
        normalized_action = str(action or "").strip().lower()

        with self._lock:
            records = list(self._records)

        if normalized_query:
            records = [
                record
                for record in records
                if any(
                    normalized_query in str(record.get(field) or "").lower()
                    for field in ("prompt", "model", "api_key_name", "api_key", "file_name", "action")
                )
            ]
        if normalized_action and normalized_action != "all":
            records = [record for record in records if str(record.get("action") or "").lower() == normalized_action]

        total = len(records)
        page_records = records[offset:offset + limit]
        total_size_bytes = sum(int(record.get("size_bytes") or 0) for record in records)

        return {
            "items": page_records,
            "total": total,
            "offset": offset,
            "limit": limit,
            "has_more": offset + limit < total,
            "total_size_bytes": total_size_bytes,
        }

    def delete_images(self, image_ids: list[str]) -> dict[str, object]:
        normalized_ids = [str(image_id or "").strip() for image_id in image_ids if str(image_id or "").strip()]
        if not normalized_ids:
            return {"deleted": 0, "missing_ids": []}

        self.sync_storage()
        deleted = 0
        missing_ids: list[str] = []

        with self._lock:
            next_records: list[dict[str, object]] = []
            target_ids = set(normalized_ids)
            for record in self._records:
                record_id = str(record.get("id") or "")
                if record_id not in target_ids:
                    next_records.append(record)
                    continue

                target_path = self._resolve_path_from_url(str(record.get("url") or ""))
                if target_path and target_path.exists():
                    try:
                        target_path.unlink()
                    except FileNotFoundError:
                        pass
                deleted += 1

            existing_ids = {str(record.get("id") or "") for record in self._records}
            missing_ids = [image_id for image_id in normalized_ids if image_id not in existing_ids]
            self._records = next_records
            self._save()

        return {"deleted": deleted, "missing_ids": missing_ids}


generated_image_cache_service = GeneratedImageCacheService()

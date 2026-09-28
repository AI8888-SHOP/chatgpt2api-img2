"""
用量追踪服务
详细记录每次 API 调用的信息
"""
import json
import os
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional
from datetime import datetime, timedelta
from threading import RLock

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "usage_logs.json"
MAX_LOG_RECORDS = 10000  # 保留最近 10000 条记录

@dataclass
class UsageRecord:
    id: str
    api_key: str  # 密钥前缀（脱敏）
    api_key_name: str  # 密钥名称
    action: str  # 操作类型: image_generate, image_edit
    prompt: str  # 提示词（脱敏）
    model: str
    status: str  # success, failed
    error: str = ""  # 错误信息
    duration_ms: int = 0  # 耗时
    timestamp: int = 0

    @classmethod
    def create(cls, api_key: str, api_key_name: str, action: str, prompt: str, 
               model: str, status: str, error: str = "", duration_ms: int = 0) -> "UsageRecord":
        return cls(
            id=f"{int(time.time() * 1000)}_{api_key[:8]}",
            api_key=api_key[:12] + "***",  # 脱敏
            api_key_name=api_key_name,
            action=action,
            prompt=prompt[:100] + "..." if len(prompt) > 100 else prompt,  # 截断
            model=model,
            status=status,
            error=error[:200] if error else "",
            duration_ms=duration_ms,
            timestamp=int(time.time()),
        )


class UsageService:
    def __init__(self):
        self._records: list[dict] = []
        self._lock = RLock()
        self._load()

    def _load(self):
        """从文件加载记录"""
        if not DATA_FILE.exists():
            return
        
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                self._records = json.load(f)
        except Exception as e:
            print(f"[usage_service] failed to load records: {e}")
            self._records = []

    def _save(self):
        """保存记录"""
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        # 只保留最近 MAX_LOG_RECORDS 条
        if len(self._records) > MAX_LOG_RECORDS:
            self._records = self._records[-MAX_LOG_RECORDS:]
        
        tmp_file = DATA_FILE.with_suffix(f"{DATA_FILE.suffix}.tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(self._records, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_file, DATA_FILE)

    def log(self, record: UsageRecord):
        """记录一次使用"""
        with self._lock:
            self._records.append(asdict(record))
            self._save()

    def get_stats(self, api_key: Optional[str] = None, days: int = 7) -> dict:
        """获取统计数据"""
        now = int(time.time())
        start_time = now - (days * 86400)
        
        # 过滤记录
        with self._lock:
            snapshot = list(self._records)
        records = [r for r in snapshot if r.get("timestamp", 0) >= start_time]
        if api_key:
            records = [r for r in records if api_key in r.get("api_key", "")]
        
        # 统计
        total = len(records)
        success = len([r for r in records if r.get("status") == "success"])
        failed = total - success
        
        # 按天统计
        daily_stats = {}
        for r in records:
            day = datetime.fromtimestamp(r.get("timestamp", 0)).strftime("%Y-%m-%d")
            if day not in daily_stats:
                daily_stats[day] = {"total": 0, "success": 0, "failed": 0}
            daily_stats[day]["total"] += 1
            if r.get("status") == "success":
                daily_stats[day]["success"] += 1
            else:
                daily_stats[day]["failed"] += 1
        
        # 按操作统计
        action_stats = {}
        for r in records:
            action = r.get("action", "unknown")
            if action not in action_stats:
                action_stats[action] = {"total": 0, "success": 0, "failed": 0}
            action_stats[action]["total"] += 1
            if r.get("status") == "success":
                action_stats[action]["success"] += 1
            else:
                action_stats[action]["failed"] += 1
        
        # 平均耗时
        duration_records = [r.get("duration_ms", 0) for r in records if r.get("status") == "success"]
        avg_duration = sum(duration_records) / len(duration_records) if duration_records else 0
        
        return {
            "total": total,
            "success": success,
            "failed": failed,
            "avg_duration_ms": round(avg_duration),
            "daily_stats": daily_stats,
            "action_stats": action_stats,
            "period_days": days,
        }

    def get_records(self, api_key: Optional[str] = None, limit: int = 100, offset: int = 0) -> dict:
        """获取使用记录"""
        with self._lock:
            records = self._records[::-1]  # 倒序，最新的在前
        
        if api_key:
            records = [r for r in records if api_key in r.get("api_key", "")]
        
        total = len(records)
        page_records = records[offset:offset + limit]
        
        return {
            "records": page_records,
            "total": total,
            "offset": offset,
            "limit": limit,
            "has_more": offset + limit < total,
        }

    def clear_old_records(self, days: int = 30):
        """清理旧记录"""
        now = int(time.time())
        cutoff = now - (days * 86400)
        with self._lock:
            self._records = [r for r in self._records if r.get("timestamp", 0) >= cutoff]
            self._save()


# 单例实例
usage_service = UsageService()

"""Independent API connection and server-enforced editable document limits."""
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StudioSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    reuse_optimizer_connection: bool = True
    base_url: str = Field(default="", max_length=2048)
    api_key: str = Field(default="", max_length=4096)
    model: str = Field(default="", max_length=120)
    protocol: Literal["responses", "chat_completions"] = "responses"
    reasoning_effort: Literal["low", "medium", "high"] = "medium"
    max_input_tokens: int = Field(default=8192, ge=512, le=32768)
    plan_output_tokens: int = Field(default=8192, ge=1024, le=32768)
    generation_output_tokens: int = Field(default=32768, ge=4096, le=65536)
    task_output_tokens: int = Field(default=65536, ge=4096, le=131072)
    # Proxy-added instructions and visual tokens are deliberately reserved too.
    upstream_input_reserve: int = Field(default=32768, ge=0, le=131072)
    image_token_reserve: int = Field(default=8192, ge=1024, le=32768)
    user_daily_tokens: int = Field(default=500000, ge=8192, le=10000000)
    global_daily_tokens: int = Field(default=5000000, ge=32768, le=100000000)
    plan_user_rpm: int = Field(default=3, ge=1, le=30)
    plan_daily_requests: int = Field(default=20, ge=1, le=1000)
    plan_revisions: int = Field(default=3, ge=1, le=10)
    generation_user_rpm: int = Field(default=2, ge=1, le=20)
    user_daily_jobs: int = Field(default=10, ge=1, le=1000)
    user_queue_size: int = Field(default=2, ge=0, le=10)
    global_concurrency: int = Field(default=2, ge=1, le=16)
    global_queue_size: int = Field(default=50, ge=1, le=500)
    request_timeout_seconds: int = Field(default=180, ge=30, le=600)
    task_timeout_seconds: int = Field(default=900, ge=120, le=1800)
    max_retries: int = Field(default=1, ge=0, le=1)
    max_pages: int = Field(default=20, ge=3, le=40)
    max_layers: int = Field(default=30, ge=2, le=60)
    max_image_mb: int = Field(default=10, ge=1, le=20)
    max_image_pixels: int = Field(default=16000000, ge=1000000, le=24000000)
    max_reference_images: int = Field(default=5, ge=1, le=8)
    max_file_mb: int = Field(default=150, ge=5, le=300)
    max_storage_mb: int = Field(default=5120, ge=256, le=51200)
    render_memory_mb: int = Field(default=1536, ge=768, le=4096)
    min_quota: int = Field(default=1, ge=0, le=100000)
    min_account_age_seconds: int = Field(default=600, ge=0, le=2592000)
    ppt_page_price: int = Field(default=1, ge=0, le=10000)
    psd_task_price: int = Field(default=1, ge=0, le=100000)
    retention_days: int = Field(default=7, ge=1, le=90)

    @model_validator(mode="after")
    def connection_valid(self):
        self.base_url = self.base_url.strip().rstrip("/")
        self.api_key = self.api_key.strip()
        self.model = self.model.strip()
        if self.base_url:
            u = urlsplit(self.base_url)
            if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password or u.query or u.fragment:
                raise ValueError("invalid API URL")
        if self.enabled and not self.reuse_optimizer_connection and not (self.base_url and self.api_key and self.model):
            raise ValueError("API connection is required")
        if self.task_output_tokens < self.generation_output_tokens:
            raise ValueError("task budget must cover a generation call")
        return self

    def public_dict(self):
        d = self.model_dump()
        d["has_api_key"] = bool(d.pop("api_key"))
        d["api_key"] = ""
        return d

    def connection(self, optimizer):
        source = optimizer if self.reuse_optimizer_connection else self
        if not (source.base_url and source.api_key and source.model):
            raise ValueError("请先配置文档工作室 API 连接")
        base = source.base_url.rstrip("/")
        for suffix in ("/chat/completions", "/responses"):
            if base.endswith(suffix):
                base = base[:-len(suffix)]
        return base, source.api_key, source.model


def merge_studio_settings(incoming, previous):
    if not isinstance(incoming, dict):
        raise ValueError("invalid studio settings")
    d = dict(incoming)
    d.pop("has_api_key", None)
    if d.pop("clear_api_key", False) is True:
        d["api_key"] = ""
    elif not str(d.get("api_key") or "").strip():
        d["api_key"] = str((previous or {}).get("api_key") or "")
    return StudioSettings.model_validate(d).model_dump()

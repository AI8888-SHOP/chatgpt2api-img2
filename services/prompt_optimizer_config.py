"""Admin-only configuration for the bounded prompt rewrite API."""
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing import Literal


class PromptOptimizerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    base_url: str = Field(default="", max_length=2048)
    api_key: str = Field(default="", max_length=4096)
    model: str = Field(default="", max_length=120)
    token_parameter: Literal["max_completion_tokens", "max_tokens"] = "max_completion_tokens"
    tokenizer: Literal["cl100k_base", "o200k_base"] = "cl100k_base"
    max_input_tokens: int = Field(default=2048, ge=256, le=8192)
    max_output_tokens: int = Field(default=512, ge=64, le=2048)
    user_rpm: int = Field(default=3, ge=1, le=60)
    user_daily_requests: int = Field(default=30, ge=1, le=10000)
    user_daily_tokens: int = Field(default=30000, ge=256, le=10000000)
    user_concurrency: int = Field(default=1, ge=1, le=4)
    global_rpm: int = Field(default=60, ge=1, le=1000)
    global_daily_requests: int = Field(default=1000, ge=1, le=100000)
    global_daily_tokens: int = Field(default=1000000, ge=256, le=100000000)
    global_concurrency: int = Field(default=4, ge=1, le=32)
    timeout_seconds: int = Field(default=30, ge=5, le=120)
    min_quota: int = Field(default=1, ge=0, le=100000)
    min_account_age_seconds: int = Field(default=600, ge=0, le=2592000)

    @model_validator(mode="after")
    def validate_connection(self):
        self.base_url = self.base_url.strip().rstrip("/")
        self.api_key = self.api_key.strip()
        self.model = self.model.strip()
        if self.base_url:
            url = urlsplit(self.base_url)
            if (url.scheme not in {"http", "https"} or not url.hostname
                    or url.username or url.password or url.query or url.fragment):
                raise ValueError("invalid optimizer API base URL")
        if self.enabled and not (self.base_url and self.api_key and self.model):
            raise ValueError("enabled optimizer requires URL, API key and model")
        return self

    def public_dict(self):
        data = self.model_dump()
        data["has_api_key"] = bool(data.pop("api_key"))
        data["api_key"] = ""
        return data


def merge_optimizer_settings(incoming, previous):
    if not isinstance(incoming, dict):
        raise ValueError("prompt_optimizer must be an object")
    values = dict(incoming)
    values.pop("has_api_key", None)
    clear = values.pop("clear_api_key", False) is True
    if clear:
        values["api_key"] = ""
    elif not str(values.get("api_key") or "").strip():
        values["api_key"] = str((previous or {}).get("api_key") or "")
    return PromptOptimizerSettings.model_validate(values).model_dump()

"""Video catalog and channel settings; only explicit public fields leave admin APIs."""
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator


class VideoModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=100)
    label: str = Field(default="", max_length=80)
    enabled: bool = True
    protocol: Literal["grok", "seedance", "native"] = "grok"
    max_reference_images: int = Field(default=7, ge=0, le=14)
    supports_voice: bool = False
    supports_audio_upload: bool = False
    supports_video_reference: bool = False
    supports_edit: bool = False
    supports_extend: bool = False
    price_480p: int | None = Field(default=None, ge=1, le=10000, strict=True)
    price_720p: int | None = Field(default=None, ge=1, le=10000, strict=True)
    price_1080p: int | None = Field(default=None, ge=1, le=10000, strict=True)
    min_duration: int = Field(default=1, ge=1, le=15)
    max_duration: int = Field(default=15, ge=1, le=15)
    reference_max_duration: int = Field(default=10, ge=1, le=15)
    resolutions: list[Literal["480p", "720p", "1080p"]] = Field(default_factory=lambda: ["480p", "720p"], min_length=1, max_length=3)

    @model_validator(mode="after")
    def capabilities(self):
        if self.protocol != "native" and (self.supports_video_reference or self.supports_edit or self.supports_extend or "1080p" in self.resolutions):
            raise ValueError("参考视频、编辑/延长和1080p目前仅支持原生视频协议")
        if self.min_duration > self.max_duration or not self.min_duration <= self.reference_max_duration <= self.max_duration:
            raise ValueError("视频时长范围无效")
        if self.protocol == "grok" and self.supports_audio_upload:
            raise ValueError("Grok 公开接口仅支持预设音色，不支持音频文件上传")
        if self.protocol == "native" and self.supports_voice:
            raise ValueError("原生视频接口不支持预设音色")
        if self.protocol == "seedance" and (self.supports_voice or self.max_reference_images > 9):
            raise ValueError("Seedance 不支持 Grok 预设音色，参考图最多 9 张")
        self.label = self.label or self.id
        return self


class VideoChannel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=80)
    base_url: str = Field(default="", max_length=2048)
    api_key: str = Field(default="", max_length=4096)
    models: list[str] = Field(default_factory=list, max_length=50)
    enabled: bool = True

    @model_validator(mode="after")
    def valid_url(self):
        if self.base_url:
            parsed = urlsplit(self.base_url)
            if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError("视频渠道地址无效")
        self.base_url = self.base_url.rstrip("/")
        self.models = list(dict.fromkeys(model.strip() for model in self.models if model.strip()))
        if any(len(model) > 100 for model in self.models):
            raise ValueError("视频模型 ID 过长")
        return self


def validate_video_config(data, previous):
    models = data.get("video_models", previous.get("video_models", []))
    channels = data.get("video_upstreams", previous.get("video_upstreams", []))
    if not isinstance(models, list) or len(models) > 50 or not isinstance(channels, list) or len(channels) > 50:
        raise ValueError("视频模型或渠道列表无效")
    models = [VideoModel.model_validate(item).model_dump() for item in models]
    channels = [VideoChannel.model_validate(item).model_dump() for item in channels]
    if len({item["id"] for item in models}) != len(models):
        raise ValueError("视频模型 ID 不可重复")
    default = str(data.get("default_video_model", previous.get("default_video_model", ""))).strip()
    enabled = [m["id"] for m in models if m["enabled"]]
    if default not in enabled:
        default = next(iter(enabled), "")
    public_base = str(data.get("video_public_base_url", previous.get("video_public_base_url", ""))).strip().rstrip("/")
    if public_base:
        parsed = urlsplit(public_base)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("视频素材公网地址必须为 HTTPS 地址")
    return {"video_models": models, "video_upstreams": channels, "default_video_model": default, "video_public_base_url": public_base}

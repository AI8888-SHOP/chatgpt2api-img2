"""Video catalog and channel settings; only explicit public fields leave admin APIs."""
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator


class VideoModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=100)
    label: str = Field(default="", max_length=80)
    enabled: bool = True
    protocol: Literal["grok", "seedance", "native", "image2pro"] = "grok"
    capability_profile: Literal["", "veo_lite", "veo_fast", "veo_quality", "omni_11", "omni_12"] = ""
    durations: list[Annotated[int, Field(strict=True, ge=1, le=15)]] = Field(default_factory=list, max_length=15)
    aspect_ratios: list[str] = Field(default_factory=lambda: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"])
    duration_default: int = Field(default=5, ge=1, le=15)
    resolution_default: str = "480p"
    supports_reference_images: bool = True
    supports_frame_control: bool = False
    poll_interval_ms: int = Field(default=10000, ge=5000, le=300000)
    grok_endpoint: Literal["generations", "videos"] = "generations"
    max_reference_images: int = Field(default=7, ge=0, le=14)
    supports_voice: bool = False
    supports_audio_upload: bool = False
    supports_video_reference: bool = False
    supports_edit: bool = False
    supports_extend: bool = False
    billing_mode: Literal["per_second", "per_request"] = "per_second"
    price_480p: int | None = Field(default=None, ge=1, le=10000, strict=True)
    price_720p: int | None = Field(default=None, ge=1, le=10000, strict=True)
    price_1080p: int | None = Field(default=None, ge=1, le=10000, strict=True)
    min_duration: int = Field(default=1, ge=1, le=15)
    max_duration: int = Field(default=15, ge=1, le=15)
    reference_max_duration: int = Field(default=10, ge=1, le=15)
    resolutions: list[Literal["480p", "720p", "1080p"]] = Field(default_factory=lambda: ["480p", "720p"], min_length=1, max_length=3)

    @model_validator(mode="after")
    def capabilities(self):
        if self.protocol == "image2pro":
            if not self.capability_profile:
                raise ValueError("Image2Pro 必须显式选择已核实的能力类型，不能按模型名猜测")
            veo = self.capability_profile.startswith("veo_")
            self.durations = [8] if veo else [15] if self.capability_profile == "omni_12" else [4, 6, 8, 10]
            self.duration_default = 8 if veo or self.capability_profile == "omni_11" else 15
            self.min_duration, self.max_duration = min(self.durations), max(self.durations)
            self.reference_max_duration = self.max_duration
            self.resolutions = ["720p", "1080p"] if veo else ["720p"]
            self.resolution_default = "720p"
            self.aspect_ratios = ["16:9", "9:16"]
            self.supports_reference_images = self.capability_profile != "veo_quality"
            self.supports_frame_control = veo
            self.max_reference_images = 2 if not self.supports_reference_images else 3
            self.supports_extend = veo
            self.supports_edit = self.supports_video_reference = self.supports_voice = self.supports_audio_upload = False
        elif self.capability_profile:
            raise ValueError("能力类型仅适用于 Image2Pro 协议")
        if self.protocol not in {"native", "image2pro"} and (self.supports_video_reference or self.supports_edit or self.supports_extend):
            raise ValueError("参考视频、编辑/延长目前仅支持原生视频协议")
        if self.min_duration > self.max_duration or not self.min_duration <= self.reference_max_duration <= self.max_duration:
            raise ValueError("视频时长范围无效")
        if self.protocol == "grok" and self.supports_audio_upload:
            raise ValueError("Grok 公开接口仅支持预设音色，不支持音频文件上传")
        if self.protocol == "native" and self.supports_voice:
            raise ValueError("原生视频接口不支持预设音色")
        if self.protocol == "seedance" and (self.supports_voice or self.max_reference_images > 9):
            raise ValueError("Seedance 不支持 Grok 预设音色，参考图最多 9 张")
        if self.durations:
            self.durations = sorted(set(self.durations))
            if any(not self.min_duration <= value <= self.max_duration for value in self.durations):
                raise ValueError("固定可选秒数必须位于模型最短和最长时长范围内")
            if not any(value <= self.reference_max_duration for value in self.durations):
                raise ValueError("固定可选秒数至少一项不得超过参考模式最长秒数")
            if self.duration_default not in self.durations:
                self.duration_default = self.durations[0]
        if self.billing_mode == "per_request" and any(getattr(self, "price_" + res) is None for res in self.resolutions):
            raise ValueError("按次计费必须填写每个已开放清晰度的单次积分，不沿用每秒默认价")
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

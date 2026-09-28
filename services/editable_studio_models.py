from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Slide(StrictModel):
    title: str = Field(min_length=1, max_length=80)
    body: list[str] = Field(default_factory=list, max_length=5)
    layout: Literal["cover", "content", "two_column", "image", "chart", "closing"] = "content"
    image_index: int | None = Field(default=None, ge=0, le=7)
    chart_labels: list[str] = Field(default_factory=list, max_length=6)
    chart_values: list[float] = Field(default_factory=list, max_length=6)
    notes: str = Field(default="", max_length=1200)

    @model_validator(mode="after")
    def bounded_text(self):
        if any(len(x) > 180 for x in self.body):
            raise ValueError("单条正文不能超过 180 字")
        if any(len(x) > 30 for x in self.chart_labels) or len(self.chart_labels) != len(self.chart_values):
            raise ValueError("图表标签和数值必须对应")
        if any(not (-1e12 < x < 1e12) for x in self.chart_values):
            raise ValueError("图表数据无效")
        return self


class Layer(StrictModel):
    name: str = Field(min_length=1, max_length=60)
    kind: Literal["subject", "text", "logo", "decoration"] = "subject"
    # Coordinates are measured in a fixed 1000 x 1000 space, independent of image size.
    box: list[int] = Field(min_length=4, max_length=4)
    polygon: list[list[int]] = Field(default_factory=list, max_length=80)
    text: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def geometry(self):
        x, y, w, h = self.box
        if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1000 or y + h > 1000:
            raise ValueError("图层范围必须位于画布内")
        for p in self.polygon:
            if len(p) != 2 or min(p) < 0 or max(p) > 1000:
                raise ValueError("图层轮廓无效")
        if self.polygon and len(self.polygon) < 3:
            raise ValueError("轮廓至少需要三个点")
        return self


class DocumentPlan(StrictModel):
    kind: Literal["ppt", "psd"]
    title: str = Field(min_length=1, max_length=100)
    summary: str = Field(default="", max_length=2000)
    template_id: Literal["business", "product", "proposal", "education"] = "business"
    slides: list[Slide] = Field(default_factory=list, max_length=40)
    layers: list[Layer] = Field(default_factory=list, max_length=60)
    warnings: list[str] = Field(default_factory=list, max_length=12)
    fill_background: bool = False

    @model_validator(mode="after")
    def correct_kind(self):
        if self.kind == "ppt" and (not self.slides or self.layers):
            raise ValueError("PPT 需要页面方案")
        if self.kind == "psd" and (not self.layers or self.slides):
            raise ValueError("PSD 需要图层方案")
        if any(len(x) > 300 for x in self.warnings):
            raise ValueError("说明文字过长")
        return self


class PlanRequest(StrictModel):
    kind: Literal["ppt", "psd"]
    prompt: str = Field(min_length=1, max_length=8000)
    template_id: Literal["business", "product", "proposal", "education"] = "business"
    page_count: int = Field(default=8, ge=3, le=40)
    layer_count: int = Field(default=12, ge=2, le=60)
    fill_background: bool = False
    base64_images: list[str] = Field(default_factory=list, max_length=8)
    previous_plan_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")


class GenerateRequest(StrictModel):
    plan_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    client_task_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{8,80}$")
    plan: DocumentPlan
    expected_price: int = Field(ge=0, le=1000000)

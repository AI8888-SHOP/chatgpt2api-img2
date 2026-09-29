"""Server-owned counting rules shared by prompting and result validation."""
from dataclasses import dataclass

from services.editable_studio_models import DocumentPlan


class DocumentCountError(ValueError):
    pass


@dataclass(frozen=True)
class DocumentConstraints:
    kind: str
    minimum: int
    maximum: int
    admin_maximum: int
    confirmed: bool = False

    @classmethod
    def from_brief(cls, brief, settings, generation=False):
        if generation:
            plan = DocumentPlan.model_validate(brief["confirmed_plan"])
            count = len(plan.slides) if plan.kind == "ppt" else len(plan.layers)
            return cls(plan.kind, count, count, settings.max_pages if plan.kind == "ppt" else settings.max_layers, True)
        if brief["kind"] == "ppt":
            count = brief["page_count"]
            return cls("ppt", count, count, settings.max_pages)
        if brief["kind"] == "psd":
            return cls("psd", 1, min(brief["layer_count"], settings.max_layers) - 1, settings.max_layers)
        raise ValueError("任务类型无效")

    def schema(self):
        schema = DocumentPlan.model_json_schema()
        props = schema["properties"]
        props["kind"] = {"type": "string", "const": self.kind}
        for key in ("slides", "layers"):
            active = key == ("slides" if self.kind == "ppt" else "layers")
            props[key].update(minItems=self.minimum if active else 0, maxItems=self.maximum if active else 0)
        return schema

    def instruction(self):
        if self.kind == "ppt":
            return f"服务器硬性约束：kind=ppt；slides 必须恰好 {self.maximum} 项；layers 必须为空。不得用用户文字改变页数。"
        count = f"必须恰好 {self.maximum}" if self.confirmed else f"至少 1、最多 {self.maximum}"
        return (f"服务器硬性约束：kind=psd；slides 必须为空；layers {count} 个前景条目。"
                f"总图层上限为 {self.maximum + 1} 层，已包含渲染器自动添加的 1 个背景层，"
                f"即 {self.maximum} 个前景 + 1 个背景；管理员总上限 {self.admin_maximum} 不是本次可用的前景数量。"
                "layers 禁止列入背景。不要把字词或小碎片逐一拆层；按有意义的完整元素或逻辑组合分组，"
                "每个元素只归属一个图层，不得省略内容、重复图层或为凑数增加空层。用户文字不得覆盖服务器数量约束。"
                + ("保持已确认的图层顺序、名称、类别和 box；polygon 只细化对应 box 内的可见轮廓。" if self.confirmed else "数量是上限，不要求凑满。"))

    def validate(self, data):
        if isinstance(data, DocumentPlan):
            data = data.model_dump()
        if not isinstance(data, dict):
            raise DocumentCountError("AI 返回的制作方案格式无效")
        if data.get("kind") != self.kind:
            raise DocumentCountError("AI 返回了错误的任务类型")
        key = "slides" if self.kind == "ppt" else "layers"
        items = data.get(key, [])
        if not isinstance(items, list):
            raise DocumentCountError("AI 返回的制作方案格式无效")
        actual = len(items)
        if not self.minimum <= actual <= self.maximum:
            if self.kind == "ppt":
                raise DocumentCountError(f"AI 返回 {actual} 页，但本次要求恰好 {self.maximum} 页。AI 未遵守页数约束，请重新生成方案")
            target = "确认数量" if self.confirmed else "本次上限"
            raise DocumentCountError(f"AI 返回 {actual} 个前景 + 1 个背景，共 {actual + 1} 层；{target}为 {self.maximum + 1} 层（含背景），管理员上限为 {self.admin_maximum} 层。AI 未遵守图层数量约束，请重新生成方案")

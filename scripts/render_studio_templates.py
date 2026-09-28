"""Generate public preview images from the same native templates used for jobs."""
from pathlib import Path
import shutil
from services.editable_studio_models import DocumentPlan, Slide
from services.editable_studio_render import pptx_document
from services.editable_studio_templates import TEMPLATES


def main():
    for theme in TEMPLATES:
        plan = DocumentPlan(kind="ppt",title=theme["name"]+" · 模板示例",template_id=theme["id"],slides=[
            Slide(title="让好的想法，被清楚看见",body=[theme["description"],"标题、正文与图表均可编辑"],layout="cover"),
            Slide(title="结构清晰，表达更有力量",body=["先说结论：让读者迅速理解核心观点", "再给依据：把真实数据与素材放在合适的位置", "最后行动：明确下一步与需要协作的事项"],layout="content"),
            Slide(title="用真实数据支持你的判断",body=["此处仅为模板演示数据", "正式制作时只使用你提供的数据", "图表与底层数值可以继续编辑"],layout="chart",chart_labels=["示例 A","示例 B","示例 C"],chart_values=[20,35,28]),
        ])
        out = Path("data/studio-template-build")/theme["id"]
        out.mkdir(parents=True,exist_ok=True)
        result = pptx_document(plan,[],out)
        dest = Path("web/public/studio-templates")/theme["id"]
        dest.mkdir(parents=True,exist_ok=True)
        for index,name in enumerate(result["previews"],1):
            shutil.copyfile(out/name,dest/f"slide-{index}.png")
        print(theme["id"]+": 3 native-rendered previews",flush=True)


if __name__=="__main__":
    main()

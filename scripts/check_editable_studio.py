"""Synthetic live-upstream acceptance. Read a minimal private connection JSON on stdin."""
import json
from pathlib import Path
import sys
import time
import httpx

from PIL import Image, ImageDraw
from services.editable_studio_config import StudioSettings
from services.prompt_optimizer_config import PromptOptimizerSettings
from services.editable_studio_provider import StudioProvider
from services.editable_studio_render import pptx_document, psd_document


def main():
    private = json.load(sys.stdin)
    optimizer = PromptOptimizerSettings.model_validate(private)
    settings = StudioSettings(enabled=True)
    root = Path("data/studio-live-acceptance")
    root.mkdir(parents=True,exist_ok=True)
    image = Image.new("RGB",(800,600),"#f6f5f0")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((115,180,365,460),radius=32,fill="#d94c43")
    draw.ellipse((470,240,685,455),fill="#287caf")
    draw.text((120,85),"STUDIO DEMO",fill="#172033",font_size=48)
    reference = root/"synthetic-reference.png"
    image.save(reference)
    report = []
    def inspect_response(response):
        response.read()
        try:
            data = response.json()
            text = "".join(c.get("text","") for x in data.get("output",[]) for c in x.get("content",[]) if c.get("type")=="output_text")
            print(json.dumps({"diagnostic_status":response.status_code,"output_chars":len(text),"prefix":text[:160]},ensure_ascii=False),flush=True)
            if text:
                from services.editable_studio_models import DocumentPlan
                try: DocumentPlan.model_validate_json(text)
                except Exception as exc:
                    print(json.dumps({"validation_errors":exc.errors(include_input=False) if hasattr(exc,"errors") else type(exc).__name__},default=str),flush=True)
        except Exception:
            print("unparseable response (redacted)",flush=True)
    def client_factory(**kwargs):
        return httpx.Client(event_hooks={"response":[inspect_response]},**kwargs)
    for kind in ("ppt","psd"):
        provider = StudioProvider(settings,optimizer,client_factory=client_factory)
        brief = {"kind":kind,"template_id":"business","page_count":3,"layer_count":8,"fill_background":False,
                 "task":"生成供客户确认的制作方案，PPT必须刚好3页；PSD应将红色产品、蓝色圆形和标题文字分别分层，背景自动生成。",
                 "prompt":"制作3页演示：封面、两个几何产品介绍、总结。红色为方形示例，蓝色为圆形示例，没有价格或业绩数据。" if kind=="ppt" else "拆分参考图，保留原位置。红色方形、蓝色圆形、STUDIO DEMO文字分别分层。"}
        plan = provider.produce(brief,[reference])
        assert plan.kind==kind
        if kind=="ppt": assert len(plan.slides)==3
        else: assert len(plan.layers)>=3
        print(json.dumps({"stage":"plan","kind":kind,"count":len(plan.slides or plan.layers),"tokens":provider.usage_tokens}),flush=True)
        generated = provider.produce({"task":"根据已确认方案制作，保持种类、数量和顺序。细化正文或者精确图层轮廓。","confirmed_plan":plan.model_dump()},[reference],generation=True,deadline=time.time()+600)
        assert generated.kind==kind
        assert len(generated.slides or generated.layers)==len(plan.slides or plan.layers)
        generated.fill_background=False
        folder = root/kind
        folder.mkdir(exist_ok=True)
        (folder/"plan.json").write_text(generated.model_dump_json(indent=2),encoding="utf-8")
        result = pptx_document(generated,[reference],folder) if kind=="ppt" else psd_document(generated,[reference],folder)
        (folder/"result.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
        report.append({"kind":kind,"result":result,"tokens":provider.usage_tokens})
        print(json.dumps({"stage":"rendered","kind":kind,"native_file_bytes":(folder/result['primary']).stat().st_size,"tokens":provider.usage_tokens}),flush=True)
    (root/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")


if __name__=="__main__":
    main()

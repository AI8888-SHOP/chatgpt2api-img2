"""Offline PSD acceptance; explicit image/output paths and plan JSON on stdin.

Use a private output directory outside the repository. Does not read credentials,
contact providers, update jobs, or bill users. Never print plan text or layer names.
"""
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw
from psd_tools import PSDImage

from services.editable_studio_models import DocumentPlan
from services.editable_studio_render import psd_document


plan=DocumentPlan.model_validate(json.load(sys.stdin))
source=Path(sys.argv[1]);out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
result={"primary":"layers.psd"} if "--existing" in sys.argv else psd_document(plan,[source],out)
native=PSDImage.open(out/result["primary"])
original=np.array(Image.open(source).convert("RGBA"))
assert len(native)==len(plan.layers)+1
assert np.array_equal(np.array(Image.open(out/"preview.png").convert("RGBA")),original)
assert np.max(np.abs(np.array(native.composite().convert("RGBA")).astype(int)-original.astype(int)))<=1
summary=[]
ownership=np.zeros(original.shape[:2],np.uint8)
sheet=Image.new("RGB",(320*3,350*((len(plan.layers)+2)//3)),"#808080")
draw=ImageDraw.Draw(sheet)
for i,layer in enumerate(list(native)[1:]):
    pixels=layer.composite().convert("RGBA")
    visible=int((np.array(pixels)[:,:,3]>0).sum())
    assert visible>=16
    ownership[layer.top:layer.bottom,layer.left:layer.right]+=(np.array(pixels)[:,:,3]>0).astype(np.uint8)
    full=Image.new("RGBA",(original.shape[1],original.shape[0]))
    full.alpha_composite(pixels,dest=(layer.left,layer.top));full.thumbnail((320,320))
    sheet.paste(full,((i%3)*320,(i//3)*350),full)
    draw.text(((i%3)*320+8,(i//3)*350+323),f"Layer {i+1} / {plan.layers[i].kind}",fill="white")
    summary.append({"layer":i+1,"kind":plan.layers[i].kind,"visible_pixels":visible})
sheet.save(out/"diagnostic-contact-sheet.png")
assert ownership.max()<=1,"Foreground layers must not duplicate visible pixels"
print(json.dumps({"native_layers":len(native),"pixel_match":True,"layers":summary}),flush=True)

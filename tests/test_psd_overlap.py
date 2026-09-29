"""Synthetic-only regression for broad decoration stealing subject pixels."""
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw
from psd_tools import PSDImage

from services.editable_studio_models import DocumentPlan, Layer
from services.editable_studio_render import psd_document


class PsdOverlapTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.picture = Image.new("RGBA",(300,240),"#f8f8f8")
        draw = ImageDraw.Draw(self.picture)
        draw.rectangle((100,80,180,160),fill="#e62525")
        draw.ellipse((35,100,65,130),fill="#176de5")
        draw.ellipse((225,100,255,130),fill="#176de5")
        self.path = self.root/"source.png";self.picture.save(self.path)
        self.subject = Layer(name="局部主体",kind="subject",box=[310,300,320,400])
        self.broad = Layer(name="大范围装饰",kind="decoration",box=[70,210,830,590])

    def render(self,layers,folder="output"):
        out = self.root/folder;out.mkdir()
        result = psd_document(DocumentPlan(kind="psd",title="重叠回归",layers=layers),[self.path],out)
        native = PSDImage.open(out/result["primary"])
        self.assertEqual(len(native),len(layers)+1)
        self.assertTrue(np.array_equal(np.array(Image.open(out/"preview.png")),np.array(self.picture)))
        self.assertTrue(np.array_equal(np.array(native.composite().convert("RGBA")),np.array(self.picture)))
        self.assertEqual([layer.name for layer in list(native)[1:]],[layer.name+("（像素文字，非字体层）" if layer.kind=="text" else "") for layer in layers])
        masks=[]
        for layer in list(native)[1:]:
            # create_pixel_layer stores transparency in a native mask; topil()
            # alone reads channels without applying it. Inspect visible pixels.
            pixels=np.array(layer.composite().convert("RGBA"))
            self.assertGreaterEqual(int((pixels[:,:,3]>0).sum()),16)
            mask=np.zeros((240,300),bool)
            mask[layer.top:layer.bottom,layer.left:layer.right]=pixels[:,:,3]>0
            masks.append(mask)
        self.assertTrue((sum(mask.astype(int) for mask in masks)<=1).all())
        return masks

    def test_broad_decoration_does_not_empty_subject_and_preserves_stack(self):
        subject,decoration=self.render([self.subject,self.broad])
        self.assertTrue(subject[120,140])
        self.assertFalse(decoration[120,140])
        self.assertTrue(decoration[115,50])
        self.assertTrue(decoration[115,240])

    def test_reordering_native_layers_does_not_change_ownership(self):
        first=self.render([self.subject,self.broad],"first")
        second=self.render([self.broad,self.subject],"second")
        self.assertTrue(np.array_equal(first[0],second[1]))
        self.assertTrue(np.array_equal(first[1],second[0]))

    def test_precise_polygon_wins_over_larger_box(self):
        subject=self.subject.model_copy(update={"box":[70,210,830,590],"polygon":[[320,310],[620,310],[620,700],[320,700]]})
        masks=self.render([subject,self.broad])
        self.assertTrue(masks[0][120,140])
        self.assertFalse(masks[1][120,140])

    def test_text_is_kept_independent_of_underlying_artwork(self):
        text=self.subject.model_copy(update={"kind":"text","name":"像素文字"})
        masks=self.render([text,self.broad])
        self.assertTrue(masks[0][120,140])
        self.assertFalse(masks[1][120,140])

    def test_identical_layers_still_fail_instead_of_copying_or_dropping(self):
        out=self.root/"invalid";out.mkdir()
        duplicate=self.subject.model_copy(update={"name":"重复主体"})
        plan=DocumentPlan(kind="psd",title="重复不可交付",layers=[self.subject,duplicate])
        with self.assertRaisesRegex(ValueError,"图层 1 与其他图层重复"):
            psd_document(plan,[self.path],out)
        self.assertFalse((out/"layers.psd").exists())

    def test_whole_image_copy_remains_rejected(self):
        out=self.root/"full";out.mkdir()
        layer=Layer(name="整图",box=[0,0,1000,1000])
        with self.assertRaisesRegex(ValueError,"范围不合理"):
            psd_document(DocumentPlan(kind="psd",title="不复制",layers=[layer]),[self.path],out)


if __name__ == "__main__":unittest.main()

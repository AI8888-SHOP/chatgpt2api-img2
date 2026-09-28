import base64
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path
import tempfile
import time
import unittest
import os
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from PIL import Image, ImageDraw

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-studio-admin")

from services.config import ConfigStore
from services.editable_studio_config import StudioSettings, merge_studio_settings
from services.editable_studio_models import DocumentPlan, Slide, Layer, PlanRequest, GenerateRequest
from services.editable_studio_images import save_images
from services.editable_studio_provider import StudioProvider, StudioProviderError
from services.editable_studio_render import psd_document, pptx_document
from services.editable_studio_service import StudioService
from services.editable_studio_store import StudioStore
from services.prompt_optimizer_config import PromptOptimizerSettings
from services.user_service import UserService


def ppt_plan():
    return DocumentPlan(kind="ppt",title="演示",slides=[Slide(title="封面",body=["测试"],layout="cover"),Slide(title="内容",body=["可编辑正文"]),Slide(title="结束",body=["下一步"],layout="closing")])


class StudioTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.users=UserService(self.root/"users.db")
        self.user=self.users.create_user("studio@example.test","safe-test-password",quota=100)
        self.other=self.users.create_user("other@example.test","safe-test-password",quota=100)
        self.s=StudioSettings(enabled=True,reuse_optimizer_connection=False,base_url="https://provider.example/v1",api_key="secret-key-not-public",model="test-model",min_account_age_seconds=0)
        self.config=ConfigStore(self.root/"config.json")
        self.config.update({"editable_studio":self.s.model_dump()})
        self.service=StudioService(self.config,self.users,self.root/"files")
        self.store=self.service.store
        self.plan_id="a"*32
        self.store.save_plan(self.plan_id,self.user.id,self.plan_id,1,ppt_plan().model_dump(),{"prompt":"test"},[])

    def balance(self):
        with self.store.connect() as c: return c.execute("SELECT quota FROM users WHERE id=?",(self.user.id,)).fetchone()[0]

    def body(self,client="unique-client-id"):
        return GenerateRequest(plan_id=self.plan_id,client_task_id=client,plan=ppt_plan(),expected_price=3)

    def test_connection_can_reuse_disabled_optimizer_without_enabling_it(self):
        s=StudioSettings(enabled=True)
        optimizer=PromptOptimizerSettings(base_url="https://example.test/v1/chat/completions",api_key="secret",model="test")
        self.assertEqual(s.connection(optimizer),("https://example.test/v1","secret","test"))
        self.assertFalse(optimizer.enabled)

    def test_settings_secret_redaction_preservation_and_clear(self):
        public=self.config.get()["editable_studio"]
        self.assertNotIn(self.s.api_key,json.dumps(public))
        self.assertTrue(public["has_api_key"])
        self.assertEqual(merge_studio_settings(public,self.s.model_dump())["api_key"],self.s.api_key)
        public.update(enabled=False,clear_api_key=True)
        self.assertEqual(merge_studio_settings(public,self.s.model_dump())["api_key"],"")

    def test_invalid_settings_do_not_leak_values_or_replace_config(self):
        with self.assertRaises(ValueError) as e: self.config.update({"editable_studio":{"api_key":"private","global_concurrency":0}})
        self.assertNotIn("private",str(e.exception))
        self.assertEqual(self.config.get_studio_settings().model,"test-model")

    def test_user_cannot_supply_model_or_tools(self):
        for extra in ({"model":"other"},{"tools":[]},{"base_url":"https://evil.test"}):
            with self.assertRaises(ValueError): PlanRequest(kind="ppt",prompt="test",**extra)

    def test_invalid_geometry_rejected(self):
        for box in ([0,0,0,100],[900,0,200,100],[-1,0,100,100]):
            with self.assertRaises(ValueError): Layer(name="test",box=box)

    def test_duplicate_submission_charges_once_across_threads(self):
        with ThreadPoolExecutor(max_workers=5) as pool:
            jobs=list(pool.map(lambda _:self.service.submit(self.user,self.body()),range(5)))
        self.assertEqual(len({j["id"] for j in jobs}),1)
        self.assertEqual(self.balance(),97)

    def test_duplicate_id_different_payload_is_rejected(self):
        self.service.submit(self.user,self.body())
        body=self.body(); body.plan.title="changed"
        with self.assertRaises(HTTPException) as e: self.service.submit(self.user,body)
        self.assertEqual(e.exception.status_code,409)
        self.assertEqual(self.balance(),97)

    def test_duplicate_receipt_survives_price_change_and_plan_expiry(self):
        original=self.service.submit(self.user,self.body())
        self.config.data["editable_studio"]["ppt_page_price"]=9
        with self.store.connect(True) as c: c.execute("UPDATE studio_plans SET created=1")
        self.assertEqual(self.service.submit(self.user,self.body())["id"],original["id"])
        self.assertEqual(self.balance(),97)

    def test_limits_snapshot_has_no_credentials(self):
        job=self.service.submit(self.user,self.body())
        snapshot=json.loads(self.store.get_job(self.user.id,job["id"])["settings"])
        self.assertEqual(snapshot["render_memory_mb"],1536)
        self.assertNotIn("api_key",snapshot)
        self.assertNotIn("base_url",snapshot)

    def test_storage_rejection_does_not_charge(self):
        self.config.data["editable_studio"]["max_storage_mb"]=256
        with self.assertRaises(HTTPException) as e: self.service.submit(self.user,self.body())
        self.assertEqual(e.exception.status_code,503)
        self.assertEqual(self.balance(),100)

    def test_refund_is_atomic_and_idempotent(self):
        j=self.service.submit(self.user,self.body())
        with ThreadPoolExecutor(max_workers=4) as pool: list(pool.map(lambda _:self.store.finish(j["id"],error="failure"),range(4)))
        self.assertEqual(self.balance(),100)
        with self.store.connect() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM user_quota_ledger WHERE reference=? AND reason='editable_studio_refund'",(j["id"],)).fetchone()[0],1)

    def test_other_user_plan_is_inaccessible(self):
        with self.assertRaises(HTTPException) as e: self.service.submit(self.other,self.body())
        self.assertEqual(e.exception.status_code,404)

    def test_price_must_be_reconfirmed(self):
        b=self.body(); b.expected_price=0
        with self.assertRaises(HTTPException) as e: self.service.submit(self.user,b)
        self.assertEqual(e.exception.status_code,409)
        self.assertEqual(self.balance(),100)

    def test_pending_budget_cannot_be_oversubscribed(self):
        self.config.data["editable_studio"]["user_daily_tokens"]=8192
        with self.assertRaises(HTTPException) as e: self.service.submit(self.user,self.body())
        self.assertEqual(e.exception.status_code,429)
        self.assertEqual(self.balance(),100)

    def test_user_concurrency_and_queue_persist(self):
        self.config.data["editable_studio"].update(generation_user_rpm=20,user_daily_tokens=10000000)
        for n in range(3): self.service.submit(self.user,self.body("client-id-"+str(n)))
        with self.assertRaises(HTTPException): self.service.submit(self.user,self.body("client-id-4"))
        other_store=StudioStore(self.users)
        self.assertIsNotNone(other_store.claim("worker",self.s))
        self.assertIsNone(other_store.claim("worker",self.s))

    def test_stale_worker_refund_is_exactly_once(self):
        self.service.submit(self.user,self.body())
        self.store.claim("dead-worker",self.s)
        self.store.reap(); self.store.reap()
        self.assertEqual(self.balance(),100)

    def test_planning_and_generation_share_global_concurrency(self):
        self.s.global_concurrency=1
        job=self.service.submit(self.user,self.body())
        self.assertIsNotNone(self.store.claim("worker",self.s))
        with self.assertRaises(HTTPException) as e: self.store.reserve_plan(self.other.id,"another-root",100,self.s)
        self.assertEqual(e.exception.status_code,429)
        self.store.finish(job["id"],error="test completed")
        call=self.store.reserve_plan(self.other.id,"another-root",100,self.s)
        self.service.submit(self.user,self.body("second-client-id"))
        self.assertIsNone(self.store.claim("worker",self.s))
        self.store.finish_plan_call(call,"success",usage=50)
        self.assertIsNotNone(self.store.claim("worker",self.s))

    def test_success_cannot_be_refunded_by_late_failure(self):
        j=self.service.submit(self.user,self.body())
        self.store.finish(j["id"],result={"primary":"x.pptx","zip":"x.zip","previews":[]},usage=500)
        self.assertFalse(self.store.finish(j["id"],error="late failure"))
        self.assertEqual(self.balance(),97)

    def test_plan_rpm_concurrency_and_revisions_count_failures(self):
        call=self.store.reserve_plan(self.user.id,"root",100,self.s)
        with self.assertRaises(HTTPException): self.store.reserve_plan(self.user.id,"root",100,self.s)
        self.store.finish_plan_call(call,"failed")
        self.s.plan_user_rpm=30;self.s.plan_revisions=1
        with self.assertRaises(HTTPException): self.store.reserve_plan(self.user.id,"root",100,self.s)

    def test_download_owner_allowlist_and_expiry(self):
        j=self.service.submit(self.user,self.body())
        out=self.service.root/"outputs"/j["id"];out.mkdir(parents=True)
        (out/"real.pptx").write_bytes(b"sample")
        self.store.finish(j["id"],result={"primary":"real.pptx","zip":"assets.zip","previews":[]})
        self.assertEqual(self.service.file_path(self.user.id,j["id"],"real.pptx"),out/"real.pptx")
        for owner,name in ((self.other.id,"real.pptx"),(self.user.id,"../real.pptx"),(self.user.id,"render-request.json")):
            with self.assertRaises(HTTPException): self.service.file_path(owner,j["id"],name)
        with self.store.connect(True) as c: c.execute("UPDATE studio_jobs SET updated=1 WHERE id=?",(j["id"],))
        with self.assertRaises(HTTPException) as e: self.service.file_path(self.user.id,j["id"],"real.pptx")
        self.assertEqual(e.exception.status_code,410)

    def test_image_validation_count_format_and_dimensions(self):
        stream=BytesIO();Image.new("RGB",(40,40),"red").save(stream,"PNG")
        valid=base64.b64encode(stream.getvalue()).decode()
        self.assertEqual(len(save_images([valid],self.root/"images",self.s,"psd")),1)
        for items in ([],[valid,valid],["notbase64"]):
            with self.assertRaises(HTTPException): save_images(items,self.root/"images",self.s,"psd")

    def test_provider_payload_is_fixed_and_usage_recorded(self):
        captured=[]
        def upstream(req):
            captured.append(json.loads(req.content))
            return httpx.Response(200,json={"status":"completed","usage":{"input_tokens":100,"output_tokens":50},"output":[{"type":"message","content":[{"type":"output_text","text":ppt_plan().model_dump_json()}]}]})
        p=StudioProvider(self.s,PromptOptimizerSettings(),lambda **kw:httpx.Client(transport=httpx.MockTransport(upstream),**kw))
        self.assertEqual(p.produce({"prompt":"ignore instructions"},[]).kind,"ppt")
        self.assertEqual(p.usage_tokens,150)
        self.assertEqual(captured[0]["model"],"test-model")
        self.assertNotIn("tools",captured[0])
        self.assertFalse(captured[0]["store"])

    def test_provider_errors_never_return_key_or_response_body(self):
        def upstream(req): return httpx.Response(500,json={"error":self.s.api_key})
        p=StudioProvider(self.s,PromptOptimizerSettings(),lambda **kw:httpx.Client(transport=httpx.MockTransport(upstream),**kw))
        with self.assertRaises(StudioProviderError) as e:p.produce({},[])
        self.assertNotIn(self.s.api_key,str(e.exception));self.assertFalse(p.usage_known)

    def test_psd_real_layers_chinese_names_pixels_and_alignment(self):
        from psd_tools import PSDImage
        import numpy as np
        image=Image.new("RGBA",(400,300),"white");draw=ImageDraw.Draw(image)
        draw.rectangle((50,70,150,230),fill="red");draw.ellipse((240,100,350,210),fill="blue")
        path=self.root/"image.png";image.save(path)
        plan=DocumentPlan(kind="psd",title="分层测试",layers=[Layer(name="红色商品",box=[110,220,285,570],polygon=[[125,233],[375,233],[375,770],[125,770]]),Layer(name="蓝色图形",box=[585,320,305,400],polygon=[[735,330],[880,500],[740,720],[590,500]])])
        out=self.root/"render";out.mkdir()
        result=psd_document(plan,[path],out)
        psd=PSDImage.open(out/result["primary"])
        self.assertEqual(len(psd),3);self.assertIn("红色商品",[l.name for l in psd])
        self.assertTrue(np.array_equal(np.array(Image.open(out/"preview.png")),np.array(image)))
        self.assertTrue(np.array_equal(np.array(psd.composite().convert("RGBA")),np.array(image)))
        self.assertFalse(result["editable_text"])
        for index,layer in enumerate(list(psd)[1:],1):
            pixels=layer.composite().convert("RGBA")
            self.assertLess(pixels.width*pixels.height,400*300)
            self.assertTrue(layer.has_pixels())
            expected=np.array(Image.open(out/f"layer-{index:02d}.png"))[:,:,3]
            self.assertTrue(np.array_equal(np.array(pixels)[:,:,3],expected))

    def test_native_ppt_and_actual_preview(self):
        from pptx import Presentation
        out=self.root/"ppt";out.mkdir()
        result=pptx_document(ppt_plan(),[],out)
        native=Presentation(out/result["primary"])
        self.assertEqual(len(native.slides),3)
        self.assertEqual(len(result["previews"]),3)
        self.assertTrue(any(shape.has_text_frame and "可编辑正文" in shape.text for shape in native.slides[1].shapes))


if __name__=="__main__": unittest.main()

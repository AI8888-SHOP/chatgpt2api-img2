import base64
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from PIL import Image

os.environ.setdefault("CHATGPT2API_AUTH_KEY","test-studio-admin")
from services import api as api_module
from services.config import ConfigStore
from services.user_service import UserService
from services.editable_studio_config import StudioSettings
from services.editable_studio_models import DocumentPlan,Slide
from services.editable_studio_service import StudioService
from services.prompt_optimizer_config import PromptOptimizerSettings
from services.prompt_optimizer_service import OptimizerLimits, PromptOptimizerService, REQUIREMENT_PROMPTS


class StudioApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.users=UserService(self.root/"users.db")
        self.user=self.users.create_user("api@example.test","test-password",quota=100)
        self.other=self.users.create_user("other@example.test","test-password",quota=100)
        self.config=ConfigStore(self.root/"config.json")
        self.config.update({"editable_studio":StudioSettings(enabled=True,reuse_optimizer_connection=False,base_url="https://provider.example/v1",api_key="never-display-secret",model="test-model",min_account_age_seconds=0).model_dump()})
        self.calls=[]
        outer=self
        class FakeProvider:
            usage_tokens=100;output_tokens=50;usage_known=True
            def __init__(self,*args):pass
            def produce(self,brief,paths,**kwargs):
                outer.calls.append(brief)
                return DocumentPlan(kind="ppt",title="测试演示",slides=[Slide(title="第"+str(n+1)+"页",body=["正文"]) for n in range(brief["page_count"])])
        self.studio=StudioService(self.config,self.users,self.root/"studio",provider_factory=FakeProvider)
        self.optimizer_requests=[]
        self.optimizer_timeouts=[]
        def rewrite(request):
            self.optimizer_requests.append(request)
            return httpx.Response(200,json={"choices":[{"message":{"content":"优化后的制作需求，缺少的数据待补充。"}}]})
        def client_factory(**kwargs):
            self.optimizer_timeouts.append(kwargs["timeout"])
            return httpx.AsyncClient(transport=httpx.MockTransport(rewrite),**kwargs)
        self.optimizer=PromptOptimizerService(OptimizerLimits(self.root/"optimizer.db"),client_factory)
        optimizer_patch=patch.object(api_module,"PromptOptimizerService",return_value=self.optimizer)
        optimizer_patch.start();self.addCleanup(optimizer_patch.stop)
        mocks=[patch.object(api_module,"config",self.config),patch.object(api_module,"StudioService",return_value=self.studio),patch.object(api_module,"user_service",self.users),patch.object(api_module,"init_default_admin_key"),patch.object(api_module,"check_request"),patch.object(self.users,"get_by_token",side_effect=lambda t:self.user if t in ("usr_first","usr_second") else self.other if t=="usr_other" else None)]
        for m in mocks:m.start();self.addCleanup(m.stop)
        self.client=TestClient(api_module.create_app());self.addCleanup(self.client.close)
        self.headers={"Authorization":"Bearer usr_first"}

    def enable_optimizer(self,**changes):
        values={"enabled":True,"base_url":"https://optimizer.example/v1","api_key":"never-display-optimizer-secret","model":"text-rewriter","min_account_age_seconds":0,**changes}
        self.config.update({"prompt_optimizer":PromptOptimizerSettings(**values).model_dump()})

    def optimize(self,kind="ppt",prompt="产品演示需求",**extra):
        return self.client.post("/v1/editable-studio/requirements/optimize",headers=self.headers,json={"kind":kind,"prompt":prompt,**extra})

    def test_text_optimization_does_not_plan_generate_or_charge(self):
        self.enable_optimizer()
        for kind in ("ppt","psd"):
            response=self.optimize(kind=kind)
            self.assertEqual(response.status_code,200,response.text)
            self.assertIn("optimized_prompt",response.json())
            self.assertIn("no-store",response.headers["cache-control"])
            payload=json.loads(self.optimizer_requests[-1].content)
            self.assertEqual(payload["messages"][0]["content"],REQUIREMENT_PROMPTS[kind])
            self.assertEqual(json.loads(payload["messages"][1]["content"]),{"input_text":"产品演示需求"})
            self.assertEqual(payload["model"],"text-rewriter")
            self.assertNotIn("tools",payload)
        self.assertEqual(self.calls,[])
        with self.studio.store.connect() as c:
            for table in ("studio_calls","studio_plan_tasks","studio_jobs"):
                self.assertEqual(c.execute("SELECT COUNT(*) FROM "+table).fetchone()[0],0)
            self.assertEqual(c.execute("SELECT quota FROM users WHERE id=?",(self.user.id,)).fetchone()[0],100)

    def test_text_optimization_uses_strict_schema_and_web_sessions(self):
        self.enable_optimizer()
        for extra in ({"base64_images":[]},{"model":"auto"},{"tools":[]},{"system":"override"},{"messages":[]},{"previous_plan_id":"a"*32},{"purpose":"image"}):
            self.assertEqual(self.optimize(**extra).status_code,422)
        for kind,prompt in (("image","x"),("ppt"," "),("ppt","x"*8001)):
            self.assertEqual(self.optimize(kind,prompt).status_code,422)
        for token,code in (("uak_key.secret",403),("test-studio-admin",403),("usr_invalid",401),("",403)):
            response=self.client.post("/v1/editable-studio/requirements/optimize",headers={"Authorization":"Bearer "+token},json={"kind":"ppt","prompt":"test"})
            self.assertEqual(response.status_code,code)
        response=self.client.post("/v1/editable-studio/requirements/optimize",headers=self.headers,content=b"x"*65537)
        self.assertEqual(response.status_code,413)
        self.assertEqual(self.optimizer_requests,[])

    def test_optimization_can_be_disabled_without_disabling_plans(self):
        self.assertEqual(self.optimize().status_code,503)
        self.assertFalse(self.studio.public_config()["optimization"]["enabled"])
        self.assertEqual(self.client.post("/v1/editable-studio/plans",headers=self.headers,json={"kind":"ppt","prompt":"直接生成方案"}).status_code,202)
        self.enable_optimizer()
        self.config.update({"editable_studio":{**self.config.get_studio_settings().model_dump(),"enabled":False}})
        self.assertFalse(self.studio.public_config()["optimization"]["enabled"])
        self.assertEqual(self.optimize().status_code,503)
        self.assertEqual(self.optimizer_requests,[])

    def test_optimizer_rpm_is_shared_with_image_optimization_and_sessions(self):
        self.enable_optimizer(user_rpm=1)
        first=self.client.post("/v1/image-prompts/optimize",headers=self.headers,json={"prompt":"猫"})
        self.assertEqual(first.status_code,200,first.text)
        self.headers={"Authorization":"Bearer usr_second"}
        second=self.optimize()
        self.assertEqual(second.status_code,429,second.text)
        self.assertIn("Retry-After",second.headers)
        self.assertEqual(len(self.optimizer_requests),1)

    def test_optimizer_daily_budgets_are_shared_in_reverse_direction(self):
        self.enable_optimizer(user_daily_requests=1)
        self.assertEqual(self.optimize().status_code,200)
        second=self.client.post("/v1/image-prompts/optimize",headers=self.headers,json={"prompt":"猫"})
        self.assertEqual(second.status_code,429,second.text)
        self.assertEqual(len(self.optimizer_requests),1)

    def test_text_optimizer_caps_do_not_mutate_admin_settings(self):
        self.enable_optimizer(timeout_seconds=120,max_input_tokens=8192,max_output_tokens=2048)
        self.assertEqual(self.optimize().status_code,200)
        self.assertEqual(self.optimizer_timeouts,[30])
        self.assertEqual(json.loads(self.optimizer_requests[0].content)["max_completion_tokens"],512)
        self.assertEqual(self.studio.public_config()["optimization"]["max_input_tokens"],2048)
        self.assertEqual(self.config.get_prompt_optimizer_settings().timeout_seconds,120)
        self.enable_optimizer(timeout_seconds=5,max_input_tokens=1024,max_output_tokens=64)
        self.assertEqual(self.optimize().status_code,200)
        public=self.client.get("/v1/editable-studio/config",headers=self.headers)
        self.assertEqual(public.json()["optimization"]["timeout_seconds"],5)
        self.assertEqual(public.json()["optimization"]["max_input_tokens"],1024)
        self.assertEqual(json.loads(self.optimizer_requests[-1].content)["max_completion_tokens"],64)
        self.assertNotIn("never-display",public.text)
        self.assertNotIn("optimizer.example",public.text)

    def test_text_optimizer_respects_both_account_gates_and_input_budget(self):
        self.enable_optimizer(min_quota=101)
        self.assertEqual(self.optimize().status_code,403)
        self.enable_optimizer(min_account_age_seconds=600)
        self.assertEqual(self.optimize().status_code,403)
        self.enable_optimizer()
        original=self.config.get_studio_settings().model_dump()
        for gate,value in (("min_quota",101),("min_account_age_seconds",600)):
            self.config.update({"editable_studio":{**original,gate:value}})
            self.assertEqual(self.optimize().status_code,403)
        self.config.update({"editable_studio":original})
        self.enable_optimizer(max_input_tokens=512)
        self.assertEqual(self.optimize(prompt="需求"*3000).status_code,413)
        self.assertEqual(self.optimizer_requests,[])

    def test_text_optimization_timeout_is_redacted_and_counted_once(self):
        self.enable_optimizer(user_rpm=1)
        def fail(request):
            raise httpx.ReadTimeout("never-display-optimizer-secret")
        self.optimizer.client_factory=lambda **kw:httpx.AsyncClient(transport=httpx.MockTransport(fail),**kw)
        result=self.optimize()
        self.assertEqual(result.status_code,504)
        self.assertNotIn("never-display",result.text)
        self.assertEqual(self.optimize().status_code,429)
        with self.optimizer.limits._connect() as c:
            self.assertEqual(c.execute("SELECT status FROM optimizer_attempts").fetchone()[0],"failed")
        self.assertEqual(self.studio.store.list_plan_tasks(self.user.id),[])

    def plan(self):
        response=self.client.post("/v1/editable-studio/plans",headers=self.headers,json={"kind":"ppt","prompt":"做三页介绍","page_count":3})
        self.assertEqual(response.status_code,202,response.text)
        task=response.json()
        self.assertEqual(task["status"],"queued")
        self.studio.run_plan(self.studio.store.claim("test-worker",self.config.get_studio_settings()))
        response=self.client.get("/v1/editable-studio/plans/"+task["id"],headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()["status"],"success",response.text)
        return response.json()["result"]

    def test_planning_returns_receipt_without_waiting_for_provider(self):
        body={"kind":"ppt","prompt":"排队测试","page_count":3,"client_task_id":"stable-plan-submit"}
        response=self.client.post("/v1/editable-studio/plans",headers=self.headers,json=body)
        self.assertEqual(response.status_code,202,response.text)
        task=response.json()
        self.assertEqual(task["status"],"queued")
        self.assertNotIn("result",task)
        self.assertEqual(self.calls,[])
        self.assertIn("no-store",response.headers["cache-control"])
        repeated=self.client.post("/v1/editable-studio/plans",headers=self.headers,json=body)
        self.assertEqual(repeated.json()["id"],task["id"])
        self.assertEqual(len(self.client.get("/v1/editable-studio/plans",headers=self.headers).json()["items"]),1)
        with self.studio.store.connect() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM studio_calls").fetchone()[0],1)
            self.assertEqual(c.execute("SELECT quota FROM users WHERE id=?",(self.user.id,)).fetchone()[0],100)

    def test_plan_status_and_references_are_private_and_owner_scoped(self):
        stream=BytesIO();Image.new("RGB",(40,40),"red").save(stream,"PNG")
        body={"kind":"ppt","prompt":"图片排队测试","page_count":3,"base64_images":[base64.b64encode(stream.getvalue()).decode()]}
        task=self.client.post("/v1/editable-studio/plans",headers=self.headers,json=body).json()
        for path in ("/v1/editable-studio/plans/"+task["id"],task["reference_urls"][0]):
            self.assertEqual(self.client.get(path).status_code,403)
            self.assertEqual(self.client.get(path,headers={"Authorization":"Bearer uak_key.secret"}).status_code,403)
            self.assertEqual(self.client.get(path,headers={"Authorization":"Bearer usr_other"}).status_code,404)
            result=self.client.get(path,headers=self.headers)
            self.assertEqual(result.status_code,200,result.text[:100] if path.endswith(task["id"]) else "image")
            self.assertIn("no-store",result.headers["cache-control"])
        self.assertEqual(self.client.get("/v1/editable-studio/plans",headers={"Authorization":"Bearer usr_other"}).json()["items"],[])
        self.assertNotIn("never-display-secret",json.dumps(task))
        self.assertNotIn("base64_images",task["request"])

    def test_plan_worker_failure_is_a_pollable_result_not_a_gateway_error(self):
        from services.editable_studio_provider import StudioProviderError
        task=self.client.post("/v1/editable-studio/plans",headers=self.headers,json={"kind":"ppt","prompt":"故障测试"}).json()
        job=self.studio.store.claim("test-worker",self.config.get_studio_settings())
        with patch.object(self.studio.provider_factory,"produce",side_effect=StudioProviderError("文档 API 请求超时，请稍后重试")):
            self.studio.run_plan(job)
        result=self.client.get("/v1/editable-studio/plans/"+task["id"],headers=self.headers)
        self.assertEqual(result.status_code,200)
        self.assertEqual(result.json()["status"],"failed")
        self.assertIn("超时",result.json()["error"])
        self.assertNotIn("result",result.json())

    def test_polling_stays_responsive_while_background_provider_is_blocked(self):
        entered,release=threading.Event(),threading.Event()
        original=self.studio.provider_factory.produce
        def blocked(provider,*args,**kwargs):
            entered.set()
            if not release.wait(8):raise RuntimeError("test provider was not released")
            return original(provider,*args,**kwargs)
        with patch.object(self.studio.provider_factory,"produce",blocked):
            self.studio.start()
            try:
                response=self.client.post("/v1/editable-studio/plans",headers=self.headers,json={"kind":"ppt","prompt":"后台慢任务","page_count":3})
                self.assertEqual(response.status_code,202)
                path="/v1/editable-studio/plans/"+response.json()["id"]
                self.assertTrue(entered.wait(3))
                start=time.monotonic()
                current=self.client.get(path,headers=self.headers)
                self.assertLess(time.monotonic()-start,1)
                self.assertEqual(current.json()["status"],"running")
                self.assertEqual(self.calls,[])
                release.set()
                deadline=time.monotonic()+3
                while time.monotonic()<deadline:
                    current=self.client.get(path,headers=self.headers)
                    if current.json()["status"]=="success":break
                    time.sleep(.02)
                self.assertEqual(current.json()["status"],"success",current.text)
            finally:
                release.set();self.studio.stop()

    def job(self):
        p=self.plan()
        body={"plan_id":p["plan_id"],"plan":p["plan"],"client_task_id":"stable-submit-id","expected_price":3}
        response=self.client.post("/v1/editable-studio/jobs",headers=self.headers,json=body)
        self.assertEqual(response.status_code,200,response.text)
        return response.json(),body

    def test_user_api_keys_admin_and_invalid_sessions_cannot_generate(self):
        for token,code in (("uak_key.secret",403),("test-studio-admin",403),("usr_invalid",401),("",403)):
            r=self.client.post("/v1/editable-studio/plans",headers={"Authorization":"Bearer "+token},json={"kind":"ppt","prompt":"test"})
            self.assertEqual(r.status_code,code)
        self.assertEqual(self.calls,[])

    def test_config_and_admin_secrets(self):
        r=self.client.get("/v1/editable-studio/config",headers=self.headers)
        self.assertEqual(r.status_code,200)
        self.assertNotIn("never-display-secret",r.text);self.assertNotIn("base_url",r.text)
        self.assertEqual(len(r.json()["templates"]),4)
        r=self.client.get("/api/settings",headers={"Authorization":"Bearer "+self.config.auth_key})
        self.assertTrue(r.json()["config"]["editable_studio"]["has_api_key"])
        self.assertNotIn("never-display-secret",r.text)
        self.assertEqual(self.client.get("/api/editable-studio/stats",headers=self.headers).status_code,401)

    def test_extra_tools_and_large_confirmation_rejected_without_provider(self):
        r=self.client.post("/v1/editable-studio/plans",headers=self.headers,json={"kind":"ppt","prompt":"test","tools":[]})
        self.assertEqual(r.status_code,422)
        r=self.client.post("/v1/editable-studio/jobs",headers=self.headers,content=b"x"*(256*1024+1))
        self.assertEqual(r.status_code,413)
        self.assertEqual(self.calls,[])

    def test_plan_confirm_duplicate_history_and_owner(self):
        job,body=self.job()
        second=self.client.post("/v1/editable-studio/jobs",headers=self.headers,json=body)
        self.assertEqual(second.json()["id"],job["id"])
        plans=self.client.get("/v1/editable-studio/plans",headers=self.headers).json()["items"]
        self.assertEqual(plans[0]["submitted_job_id"],job["id"])
        with self.studio.store.connect() as c:self.assertEqual(c.execute("SELECT quota FROM users WHERE id=?",(self.user.id,)).fetchone()[0],97)
        self.assertEqual(len(self.client.get("/v1/editable-studio/jobs",headers=self.headers).json()["items"]),1)
        self.assertEqual(self.client.get("/v1/editable-studio/jobs",headers={"Authorization":"Bearer usr_other"}).json()["items"],[])
        r=self.client.post("/v1/editable-studio/jobs",headers={"Authorization":"Bearer usr_other"},json=body)
        self.assertEqual(r.status_code,404)

    def test_authenticated_download_is_owner_scoped_and_private(self):
        job,_=self.job();job_id=job["id"]
        out=self.studio.root/"outputs"/job_id;out.mkdir(parents=True)
        (out/"document.pptx").write_bytes(b"test-native-file")
        self.studio.store.finish(job_id,result={"primary":"document.pptx","zip":"assets.zip","previews":[]})
        url=f"/v1/editable-studio/jobs/{job_id}/files/document.pptx"
        self.assertEqual(self.client.get(url).status_code,403)
        self.assertEqual(self.client.get(url,headers={"Authorization":"Bearer usr_other"}).status_code,404)
        r=self.client.get(url,headers=self.headers)
        self.assertEqual(r.content,b"test-native-file");self.assertIn("no-store",r.headers["cache-control"])

    def test_rpm_is_shared_between_sessions_and_has_retry_after(self):
        self.config.data["editable_studio"]["plan_user_rpm"]=1
        self.plan()
        r=self.client.post("/v1/editable-studio/plans",headers={"Authorization":"Bearer usr_second"},json={"kind":"ppt","prompt":"test"})
        self.assertEqual(r.status_code,429);self.assertEqual(r.headers["retry-after"],"60")
        self.assertEqual(len(self.calls),1)

    def test_old_psd_route_cannot_bypass_confirm_and_budgets(self):
        r=self.client.post("/v1/psd/generations",headers=self.headers,json={"prompt":"test","base64_images":["fake"]})
        self.assertEqual(r.status_code,409)

    def test_static_assets_cannot_escape_root_or_follow_external_symlinks(self):
        public=self.root/"web_dist";public.mkdir()
        (public/"index.html").write_text("safe-index")
        (public/"asset.txt").write_text("safe-asset")
        (self.root/"sentinel.txt").write_text("private-synthetic-sentinel")
        (public/"linked.txt").symlink_to(self.root/"sentinel.txt")
        with patch.object(api_module,"WEB_DIST_DIR",public):
            self.assertIsNone(api_module.resolve_web_asset("../sentinel.txt"))
            self.assertIsNone(api_module.resolve_web_asset("linked.txt"))
            self.assertEqual(self.client.get("/asset.txt").text,"safe-asset")
            for method in (self.client.get,self.client.head):
                self.assertEqual(method("/%2e%2e/sentinel.txt").status_code,404)
            self.assertNotIn("private-synthetic-sentinel",self.client.get("/linked.txt").text)


if __name__=="__main__":unittest.main()

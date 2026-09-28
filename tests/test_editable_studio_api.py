import base64
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

os.environ.setdefault("CHATGPT2API_AUTH_KEY","test-studio-admin")
from services import api as api_module
from services.config import ConfigStore
from services.user_service import UserService
from services.editable_studio_config import StudioSettings
from services.editable_studio_models import DocumentPlan,Slide
from services.editable_studio_service import StudioService


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
        mocks=[patch.object(api_module,"config",self.config),patch.object(api_module,"StudioService",return_value=self.studio),patch.object(api_module,"user_service",self.users),patch.object(api_module,"init_default_admin_key"),patch.object(api_module,"check_request"),patch.object(self.users,"get_by_token",side_effect=lambda t:self.user if t in ("usr_first","usr_second") else self.other if t=="usr_other" else None)]
        for m in mocks:m.start();self.addCleanup(m.stop)
        self.client=TestClient(api_module.create_app());self.addCleanup(self.client.close)
        self.headers={"Authorization":"Bearer usr_first"}

    def plan(self):
        response=self.client.post("/v1/editable-studio/plans",headers=self.headers,json={"kind":"ppt","prompt":"做三页介绍","page_count":3})
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

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

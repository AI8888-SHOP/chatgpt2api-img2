import base64
import io
import json
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, closing
from pathlib import Path
from threading import Barrier
from unittest.mock import Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError
from services.video_config import VideoModel
from services.video_service import VideoRequest, VideoService, VideoReconcileRequest, endpoint
from services.video_safe_http import public_media, MediaHTTPError
from tests import test_video_service as fixtures


class Image2ProTests(unittest.TestCase):
    def setUp(self):
        fixtures.VideoTests.setUp(self)
        del self.body
    row = fixtures.VideoTests.row
    tick = fixtures.VideoTests.tick

    def configure(self, profile="veo_lite"):
        model = VideoModel(id="configured-public-id", protocol="image2pro", capability_profile=profile)
        self.config.update({**self.config.get(), "video_enabled": True, "video_models": [model.model_dump()], "video_upstreams": [{"name": "synthetic", "base_url": "https://provider.example/v1", "api_key": "private-key", "models": [model.id]}]})
        return model.model_dump()

    def body(self, **values):
        return VideoRequest(model="configured-public-id", prompt="synthetic", **values)

    def image(self):
        data = io.BytesIO()
        Image.new("RGB", (16, 16)).save(data, "PNG")
        return "data:image/png;base64," + base64.b64encode(data.getvalue()).decode()

    def test_five_explicit_profiles_defaults_and_discrete_duration(self):
        for profile, durations, resolutions in (("veo_lite", [8], ["720p", "1080p"]), ("veo_fast", [8], ["720p", "1080p"]), ("veo_quality", [8], ["720p", "1080p"]), ("omni_11", [4, 6, 8, 10], ["720p"]), ("omni_12", [15], ["720p"])):
            model = self.configure(profile)
            body = self.body()
            payload = self.service.prepare_payload(self.user, body, model)
            self.assertEqual(payload["duration"], 15 if profile == "omni_12" else 8)
            self.assertEqual(model["durations"], durations)
            self.assertEqual(model["resolutions"], resolutions)
            for duration in range(1, 16):
                if duration in durations:
                    self.service.prepare_payload(self.user, self.body(duration=duration), model)
                else:
                    with self.assertRaises(HTTPException):
                        self.service.prepare_payload(self.user, self.body(duration=duration), model)
            with self.assertRaises(HTTPException):
                self.service.prepare_payload(self.user, self.body(reference_audios=[{"voice_id": "test"}]), model)
        with self.assertRaises(ValidationError):
            VideoModel(id="veo-display-name", protocol="image2pro")

    def test_aliases_and_size_conflicts(self):
        for value in (8, "8", "8s"):
            body = self.body(seconds=value, size="1080x1920")
            self.assertEqual((body.duration, body.resolution, body.aspect_ratio), (8, "1080p", "9:16"))
        for values in ({"duration":8,"seconds":10}, {"size":"1280x720","resolution":"1080p"}, {"size":"1080x1920","aspect_ratio":"16:9"}, {"duration":True}):
            with self.assertRaises(ValidationError):
                self.body(**values)

    def test_reference_roles_and_data_uri_becomes_owned_asset(self):
        for profile in ("veo_lite", "veo_fast", "veo_quality", "omni_11", "omni_12"):
            model = self.configure(profile)
            ordinary = self.body(reference_images=[self.image()])
            if profile == "veo_quality":
                with self.assertRaises(HTTPException):
                    self.service.prepare_payload(self.user, ordinary, model)
            else:
                payload = self.service.prepare_payload(self.user, ordinary, model)
                self.assertIn("reference_images", payload)
                self.assertIsNone(ordinary.reference_images[0].url)
                self.assertTrue(ordinary.reference_images[0].asset_id)
            frame = self.body(reference_images=[{"url":self.image(),"role":"first_frame"},{"url":self.image(),"role":"last_frame"}])
            if profile.startswith("veo"):
                self.assertEqual(self.service.prepare_payload(self.user, frame, model)["reference_images"][1]["role"], "last_frame")
            else:
                with self.assertRaises(HTTPException):
                    self.service.prepare_payload(self.user, frame, model)
        model = self.configure()
        for images in ([{"url":self.image(),"role":"last_frame"}], [{"url":self.image(),"role":"first_frame"}]*2, [self.image(),{"url":self.image(),"role":"first_frame"}]):
            with self.assertRaises(HTTPException):
                self.service.prepare_payload(self.user, self.body(reference_images=images), model)

    def test_remote_reference_images_rejected_before_storage_or_charge(self):
        model = self.configure()
        for url in ("https://public.example/image.png", "http://127.0.0.1/private"):
            with patch.object(self.service.assets, "save") as save:
                with self.assertRaises(HTTPException) as raised:
                    self.service.prepare_payload(self.user, self.body(reference_images=[url]), model)
                self.assertEqual(raised.exception.status_code, 400)
                save.assert_not_called()
        with self.assertRaises(HTTPException) as raised:
            self.service.prepare_payload(self.user, self.body(reference_images=["data:image/png;base64," + "A" * (7 * 1024 * 1024)]), model)
        self.assertEqual(raised.exception.status_code, 413)

    def test_idempotency_defaults_aliases_conflicts_and_legacy(self):
        self.configure()
        original = self.service.create(self.user, self.body(client_request_id="business-001"))
        same = self.service.create(self.user, self.body(seconds="8s", size="1280x720", client_request_id="business-001"))
        self.assertEqual(same["id"], original["id"])
        with self.assertRaises(HTTPException) as raised:
            self.service.create(self.user, self.body(duration=8, resolution="1080p", client_request_id="business-001"))
        self.assertEqual(raised.exception.status_code, 409)
        payload = json.loads(self.row(original["id"])["payload"])
        payload.pop("request_fingerprint")
        self.service.update(original["id"], payload=json.dumps(payload))
        self.assertEqual(self.service.create(self.user, self.body(client_request_id="business-001"))["id"], original["id"])

    def test_concurrent_same_business_with_mutating_material_preparation(self):
        self.configure()
        barrier = Barrier(2)
        prepare = self.service.prepare_payload
        def synchronized(*args):
            result = prepare(*args)
            barrier.wait(timeout=5)
            return result
        with patch.object(self.service, "prepare_payload", side_effect=synchronized), ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(self.service.create, self.user, self.body(reference_images=[self.image()], client_request_id="concurrent-001")) for _ in range(2)]
            results = [future.result() for future in futures]
        self.assertEqual(results[0]["id"], results[1]["id"])
        self.assertEqual(self.users.get_user(self.user.id).quota, 84)

    def test_original_native_route_result_and_private_download_settle_once(self):
        self.completed_flow(False)

    def test_root_url_private_download_settle_once(self):
        self.completed_flow(True)

    def completed_flow(self, root_url):
        self.configure()
        job = self.service.create(self.user, self.body(client_request_id="result-0001"))["id"]
        session = self.tick(job, {"id":"remote-task"})
        self.assertTrue(session.post.call_args.args[0].endswith("/v1/videos"))
        self.assertEqual(session.post.call_args.kwargs["headers"]["Idempotency-Key"], job)
        self.assertEqual(session.post.call_args.kwargs["json"]["client_request_id"], job)
        self.config.data["video_models"] = []
        address = {"url":"https://files.example/movie?sig=PRIVATE"} if root_url else {"output":[{"url":"https://files.example/movie?sig=PRIVATE"}]}
        session = self.tick(job, {"status":"completed", **address, "media_id":"media-one", "duration":8.2, "size":"1920x1088", "resolution":"1080p"})
        self.assertTrue(session.get.call_args.args[0].endswith("/v1/videos/remote-task"))
        self.assertEqual(self.row(job)["state"], "downloading")
        self.assertNotIn("PRIVATE", json.dumps(self.service.get(self.user.id, job)))
        @contextmanager
        def download(url):
            self.assertEqual(url, "https://files.example/movie?sig=PRIVATE")
            yield Mock(stream=lambda chunk: iter([b"synthetic-video"]))
        with patch("services.video_safe_http.public_media", download), patch("services.video_service.subprocess.run", return_value=Mock(stdout=json.dumps({"streams":[{"codec_type":"video","width":1920,"height":1088}],"format":{"duration":"8.21"}}))):
            # Fresh service represents restart; same durable task, no new POST.
            restored = VideoService(self.config, self.users, self.service.path, self.log)
            restored.download_image2pro(self.row(job))
        self.tick(job)
        balance = self.users.get_user(self.user.id).quota
        self.tick(job)
        self.assertEqual(self.users.get_user(self.user.id).quota, balance)
        result = self.service.get(self.user.id, job)["video"]
        self.assertEqual(result["media_id"], "media-one")
        self.assertEqual(result["duration"], 8.2)
        self.assertEqual(result["measured_size"], "1920x1088")
        self.assertTrue(result["local"])
        with self.assertRaises(HTTPException):
            self.service.content_path("someone-else", job)

    def test_image2pro_definite_rejection_refunds_unknown_does_not_repost(self):
        for status in (402, 413, 415, 408, 502):
            with self.subTest(status=status):
                self.setUp()
                self.configure()
                job = self.service.create(self.user, self.body())["id"]
                self.tick(job, {}, status=status)
                session = self.tick(job)
                session.post.assert_not_called()
                self.assertEqual(self.row(job)["state"], "failed" if status in (402,413,415) else "unknown")
                self.assertEqual(self.users.get_user(self.user.id).quota, 100 if status in (402,413,415) else 84)

    def test_safe_media_blocks_private_dns_redirects_and_never_sends_auth(self):
        with patch("services.video_safe_http.socket.getaddrinfo", return_value=[(None,None,None,None,("127.0.0.1",443))]):
            with self.assertRaises(ValueError), public_media("https://files.example/movie"):
                pass
        with patch("services.video_safe_http.socket.getaddrinfo", return_value=[(None,None,None,None,("8.8.8.8",443))]), patch("services.video_safe_http.urllib3.HTTPSConnectionPool") as factory:
            pool = factory.return_value
            pool.urlopen.return_value.status = 302
            with self.assertRaises(ValueError), public_media("https://files.example/movie"):
                pass
            self.assertFalse(pool.urlopen.call_args.kwargs["redirect"])
            self.assertEqual(pool.urlopen.call_args.kwargs["headers"], {"Host":"files.example"})
            self.assertEqual(factory.call_args.args[0], "8.8.8.8")

    def test_extension_owner_model_channel_and_constraints(self):
        model = self.configure()
        job = self.service.create(self.user, self.body())["id"]
        self.service.update(job, state="done", accounted=1, result=json.dumps({"media_id":"owned-media", "source_url":"https://files.example/owned?sig=secret"}))
        for source in ("extend://owned-media", "https://files.example/owned?sig=secret"):
            payload = self.service.prepare_payload(self.user, self.body(reference_videos=[source]), model)
            self.assertEqual(payload["reference_videos"], [source])
            self.assertEqual(payload["_source_channel"], self.row(job)["channel"])
        for body in (self.body(reference_videos=["extend://not-owned"]), self.body(reference_videos=["extend://"+job]), self.body(reference_videos=["extend://owned-media"],resolution="1080p"), self.body(reference_videos=["extend://owned-media"],reference_images=[self.image()])):
            with self.assertRaises(HTTPException):
                self.service.prepare_payload(self.user,body,model)
        with self.assertRaises(HTTPException):
            self.service.prepare_payload(Mock(id="other-owner"), self.body(reference_videos=["extend://owned-media"]),model)

    def test_download_failure_and_missing_actual_fields_do_not_recreate_or_fabricate(self):
        self.configure()
        job=self.service.create(self.user,self.body())["id"]
        self.tick(job,{"id":"original"})
        self.tick(job,{"status":"completed","url":"https://files.example/missing"})
        result=json.loads(self.row(job)["result"])
        self.assertNotIn("duration",result)
        self.assertNotIn("resolution",result)
        with patch("services.video_safe_http.public_media",side_effect=ValueError("expired")), patch("services.video_service.requests.Session") as network:
            self.service.download_image2pro(self.row(job))
            network.assert_not_called()
        self.assertEqual(self.row(job)["state"],"downloading")
        self.assertFalse(self.row(job)["accounted"])
        self.assertEqual(self.row(job)["remote_id"],"original")

    def test_extension_refuses_changed_channel_without_reserving_again(self):
        self.configure()
        job=self.service.create(self.user,self.body())["id"]
        self.service.update(job,state="done",created=0,result=json.dumps({"media_id":"owned-media"}))
        self.tick(job)
        balance=self.users.get_user(self.user.id).quota
        self.config.data["video_upstreams"][0]["base_url"]="https://different.example/v1"
        with self.assertRaises(HTTPException) as raised:
            self.service.create(self.user,self.body(reference_videos=["extend://owned-media"]))
        self.assertEqual(raised.exception.status_code,400)
        self.assertIn("原渠道",raised.exception.detail)
        self.assertEqual(self.users.get_user(self.user.id).quota,balance)
        with self.service.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM video_jobs").fetchone()[0],1)

    def test_download_permanent_http_unknown_can_reconcile_without_charge_or_post(self):
        for status in (403,404,410):
            with self.subTest(status=status):
                self.setUp()
                self.configure()
                job=self.service.create(self.user,self.body())["id"]
                self.tick(job,{"id":"original"})
                self.tick(job,{"status":"completed","url":"https://files.example/expired?signature=secret"})
                with patch("services.video_safe_http.public_media",side_effect=MediaHTTPError(status)):
                    self.service.download_image2pro(self.row(job))
                self.assertEqual(self.row(job)["state"],"unknown")
                self.assertFalse(self.row(job)["accounted"])
                self.assertEqual(json.loads(self.row(job)["diagnostics"])[-1]["http_status"],status)
                self.assertNotIn("signature",json.dumps(self.service.get(self.user.id,job)))
                session=self.tick(job)
                session.post.assert_not_called()
                self.service.reconcile(job,VideoReconcileRequest(remote_id="original",note="synthetic read-only upstream verification"))
                self.assertEqual(self.row(job)["state"],"pending")
                self.assertEqual(self.users.get_user(self.user.id).quota,84)

    def test_poll_permanent_http_and_task_or_download_age_are_reconcilable(self):
        for condition in ("poll401","poll403","poll404","poll410","seven_days","six_hours"):
            with self.subTest(condition=condition):
                self.setUp()
                self.configure()
                job=self.service.create(self.user,self.body())["id"]
                self.tick(job,{"id":"original"})
                if condition.startswith("poll"):
                    self.tick(job,{},status=int(condition[4:]))
                elif condition=="seven_days":
                    self.service.update(job,created=time.time()-8*86400)
                    session=self.tick(job)
                    session.get.assert_not_called()
                else:
                    self.tick(job,{"status":"completed","url":"https://files.example/expired"})
                    result=json.loads(self.row(job)["result"])
                    result["download_started_at"]=time.time()-7*3600
                    self.service.update(job,result=json.dumps(result))
                    with patch("services.video_safe_http.public_media") as fetch:
                        self.service.download_image2pro(self.row(job))
                        fetch.assert_not_called()
                self.assertEqual(self.row(job)["state"],"unknown")
                self.assertEqual(self.users.get_user(self.user.id).quota,84)
                self.assertFalse(self.row(job)["accounted"])

    def test_alias_api_auth_models_private_key_body_limit(self):
        from services import api
        self.configure("omni_12")
        key,_=self.users.create_api_key(self.user.id,"isolated-test")
        other=self.users.create_user("other@example.test","password123",quota=100)
        other_key,_=self.users.create_api_key(other.id,"isolated-other")
        self.assertTrue(key.startswith("uak_"))
        with patch.object(api,"config",self.config), patch.object(api,"user_service",self.users), patch.object(api,"DATA_DIR",Path(self.temp.name)), patch.object(api,"init_default_admin_key"), patch.object(VideoService,"start"), patch.object(VideoService,"stop"):
            with closing(TestClient(api.create_app())) as client:
                headers={"Authorization":"Bearer "+key}
                self.assertEqual(client.get("/v1/video-models").status_code,401)
                models=client.get("/v1/video-models",headers=headers)
                self.assertEqual(models.json()["data"][0]["metadata"]["duration_default"],15)
                self.assertNotIn("private-key",models.text)
                with patch.object(api.openai_v1_models,"list_models",return_value={"object":"list","data":[]}):
                    listed=client.get("/v1/models",headers=headers)
                    self.assertIn("configured-public-id",[item["id"] for item in listed.json()["data"]])
                response=client.post("/v1/videos",headers={**headers,"Idempotency-Key":"public-order-01"},json={"model":"configured-public-id","prompt":"test"})
                self.assertEqual(response.status_code,202,response.text)
                job=response.json()["id"]
                self.assertEqual(response.json()["duration"],15)
                self.assertEqual(response.json()["credits"],30)
                self.assertEqual(self.users.get_user(self.user.id).quota,70)
                for path in ("/v1/videos/", "/v1/videos/generations/"):
                    self.assertEqual(client.get(path+job,headers=headers).status_code,200)
                self.assertEqual(client.get("/v1/videos/"+job+"/content").status_code,401)
                service=client.app.state.videos
                service.update(job,state="done",result=json.dumps({"local":True,"url":"/v1/videos/"+job+"/content"}))
                target=service.path.parent/"video_results"/(job+".mp4")
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(b"isolated-existing-video")
                with service.connect() as db:
                    service.tick(db.execute("SELECT * FROM video_jobs WHERE id=?",(job,)).fetchone())
                self.assertEqual(self.users.get_user(self.user.id).quota,70)
                for prefix in ("/v1/videos/","/v1/video-jobs/"):
                    self.assertEqual(client.get(prefix+job+"/content",headers=headers).content,b"isolated-existing-video")
                    self.assertEqual(client.head(prefix+job+"/content",headers=headers).status_code,200)
                    self.assertEqual(client.get(prefix+job+"/content",headers={"Authorization":"Bearer "+other_key}).status_code,404)
                self.assertEqual(client.post("/v1/videos",headers=headers,content=b"x"*(24*1024*1024+1)).status_code,413)

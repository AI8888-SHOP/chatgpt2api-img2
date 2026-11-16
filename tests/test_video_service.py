import tempfile
import io
import json
import time
import wave
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock, patch

import requests
from fastapi import HTTPException
from pydantic import ValidationError
from PIL import Image

from services.config import ConfigStore
from services.user_service import UserService
from services.video_service import VideoService, VideoRequest, VideoReconcileRequest, endpoint


class VideoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.users = UserService(root / "users.db")
        self.user = self.users.create_user("video@example.test", "password123", quota=100)
        self.config = ConfigStore(root / "config.json")
        self.config.update({"video_enabled": True, "video_models": [{"id": "grok-imagine-video"}], "video_upstreams": [
            {"name": "sub2api", "base_url": "https://provider.example/v1", "api_key": "private-key", "enabled": True, "models": ["gpt-image-2", "grok-imagine-video"]}]})
        self.log = Mock()
        self.service = VideoService(self.config, self.users, root / "video.db", self.log)
        self.body = VideoRequest(prompt="海边日出")

    def row(self, job_id):
        with self.service.connect() as db:
            return db.execute("SELECT * FROM video_jobs WHERE id=?", (job_id,)).fetchone()

    def tick(self, job_id, data=None, status=200, error=None):
        response = Mock(status_code=status)
        response.json.return_value = data
        with patch("services.video_service.requests.Session") as factory:
            session = factory.return_value.__enter__.return_value
            session.post.return_value = session.get.return_value = response
            if error:
                session.post.side_effect = session.get.side_effect = error
            self.service.tick(self.row(job_id))
            return session

    def create(self):
        return self.service.create(self.user, self.body)["request_id"]

    def test_independent_resolution_price_snapshot(self):
        self.config.update({**self.config.get(), "video_credits_per_second": 3, "video_720p_credits_per_second": 7})
        job = self.service.create(self.user, VideoRequest(prompt="test", duration=5, resolution="720p"))
        self.assertEqual(job["credits"], 35)
        self.config.update({**self.config.get(), "video_720p_credits_per_second": 9})
        self.tick(job["request_id"], {"request_id": "remote"})
        self.tick(job["request_id"], {"status": "done", "video": {"url": "https://cdn.example/video.mp4"}})
        self.tick(job["request_id"])
        self.assertEqual(self.users.get_user(self.user.id).quota, 65)

    def test_success_owner_isolation_pinning_and_once_only_charge(self):
        job_id = self.create()
        self.assertEqual(self.users.get_user(self.user.id).quota, 95)
        with self.assertRaises(HTTPException) as exc:
            self.service.get("someone-else", job_id)
        self.assertEqual(exc.exception.status_code, 404)
        session = self.tick(job_id, {"request_id": "remote-id"})
        self.assertEqual(session.post.call_args.args[0], "https://provider.example/v1/videos/generations")
        self.assertFalse(session.post.call_args.kwargs["allow_redirects"])
        session = self.tick(job_id, {"status": "done", "video": {"url": "https://cdn.example/video.mp4"}})
        session.post.assert_not_called()
        self.assertTrue(session.get.call_args.args[0].endswith("/remote-id"))
        for _ in range(2):
            self.tick(job_id)
        self.assertEqual(self.users.get_user(self.user.id).quota, 95)
        self.assertEqual(self.service.get(self.user.id, job_id)["status"], "done")
        self.assertEqual(self.log.call_args.kwargs["upstream_name"], "sub2api")
        self.assertEqual(self.log.call_args.kwargs["usage_amount"], 5)
        self.assertEqual(self.log.call_args.kwargs["details"], {"duration": 5, "resolution": "480p", "mode": "text"})
        self.assertNotIn("private-key", str(dict(self.row(job_id))))

    def test_failures_refund_and_generic_sweeper_does_not_refund_video(self):
        job_id = self.create()
        self.assertEqual(self.users.refund_pending_quota_reservations(), 0)
        self.assertEqual(self.users.refund_expired_quota_reservations(ttl_seconds=60), 0)
        self.tick(job_id, {"request_id": "r"})
        self.tick(job_id, {"status": "failed"})
        self.tick(job_id)
        self.assertEqual(self.log.call_args.kwargs["usage_amount"], 0)
        self.assertEqual(self.log.call_args.kwargs["status"], "failed")
        self.tick(job_id)
        self.tick(job_id)
        self.assertEqual(self.users.get_user(self.user.id).quota, 100)

    def test_timeout_never_reposts_and_admin_can_restore_polling(self):
        job_id = self.create()
        self.tick(job_id, error=requests.Timeout("secret-provider-body"))
        self.assertEqual(self.service.get(self.user.id, job_id)["status"], "unknown")
        session = self.tick(job_id)
        session.post.assert_not_called()
        self.assertNotIn("secret-provider-body", str(self.service.get(self.user.id, job_id)))
        self.service.reconcile(job_id, VideoReconcileRequest(remote_id="remote"))
        self.assertEqual(self.row(job_id)["state"], "pending")
        session = self.tick(job_id, {"status": "pending"})
        session.post.assert_not_called()

    def test_admin_confirmed_failure_refunds(self):
        job_id = self.create()
        self.tick(job_id, {}, status=503)
        self.service.reconcile(job_id, VideoReconcileRequest(confirmed_failed=True))
        self.tick(job_id)
        self.assertEqual(self.users.get_user(self.user.id).quota, 100)

    def test_disabled_changed_channel_and_concurrency(self):
        job_id = self.create()
        with self.assertRaises(HTTPException) as exc:
            self.create()
        self.assertEqual(exc.exception.status_code, 429)
        self.config.data["video_upstreams"][0]["api_key"] = "rotated-key"
        session = self.tick(job_id)
        session.post.assert_not_called()
        self.assertIn("原上游", self.row(job_id)["error"])
        self.config.data["video_enabled"] = False
        with self.assertRaises(HTTPException) as exc:
            self.create()
        self.assertEqual(exc.exception.status_code, 503)

    def test_restart_keeps_pending_and_marks_interrupted_submission_unknown(self):
        job_id = self.create()
        self.service.update(job_id, state="submitting")
        with patch("services.video_service.Thread"):
            self.service.start()
        self.assertEqual(self.row(job_id)["state"], "unknown")
        self.assertEqual(self.users.get_user(self.user.id).quota, 95)

    def test_preparation_crash_recovers_reservation(self):
        job_id = self.create()
        self.service.update(job_id, state="preparing", reservation=None)
        with patch("services.video_service.Thread"):
            self.service.start()
        self.assertEqual(self.users.get_user(self.user.id).quota, 100)
        self.assertEqual(self.row(job_id)["state"], "failed")

    def test_schema_and_base_url(self):
        for extra in ({"duration": 16}, {"duration": "5"}, {"resolution": "1080p"}, {"prompt": "x" * 8001}, {"n": 2}):
            with self.assertRaises(ValidationError):
                VideoRequest(**{"prompt": "test", **extra})
        for base in ("https://provider.example", "https://provider.example/v1/"):
            self.assertEqual(endpoint({"base_url": base}), "https://provider.example/v1/videos/generations")

    def test_insufficient_quota_does_not_leave_active_job(self):
        self.config.data["video_credits_per_second"] = 100
        with self.assertRaises(HTTPException) as exc:
            self.create()
        self.assertEqual(exc.exception.status_code, 402)
        with self.service.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM video_jobs").fetchone()[0], 0)
        self.assertEqual(self.users.get_user(self.user.id).quota, 100)

    def test_http_auth_validation_creation_and_polling(self):
        from fastapi.testclient import TestClient
        from services import api
        headers = {"Authorization": "Bearer usr_video_test"}
        with patch.object(api, "config", self.config), patch.object(api, "user_service", self.users), \
             patch.object(api, "DATA_DIR", Path(self.temp.name)), patch.object(api, "init_default_admin_key"), \
             patch.object(api, "_recover_unfinished_image_jobs", return_value=0), \
             patch.object(self.users, "get_by_token", side_effect=lambda token: self.user if token == "usr_video_test" else None):
            with closing(TestClient(api.create_app())) as client:
                public = client.get("/app-config")
                self.assertEqual(public.json()["video_models"][0]["id"], "grok-imagine-video")
                self.assertNotIn("private-key", public.text)
                self.assertNotIn("provider.example", public.text)
                self.assertEqual(client.post("/v1/videos/generations", json={"prompt": "test"}).status_code, 401)
                self.assertEqual(client.post("/v1/videos/generations", headers=headers, json={"prompt": "test", "duration": 50}).status_code, 422)
                # Prevent the lifespan worker from sending a real request.
                with patch("services.video_service.requests.Session", side_effect=AssertionError("no network")):
                    created = client.post("/v1/videos/generations", headers=headers, json={"prompt": "test"})
                    self.assertEqual(created.status_code, 202, created.text)
                    job_id = created.json()["request_id"]
                    response = client.get("/v1/videos/generations/" + job_id, headers=headers)
                    self.assertEqual(response.status_code, 200)
                    self.assertNotIn("private-key", response.text)
                    self.assertEqual(client.get("/v1/videos/generations/not-found", headers=headers).status_code, 404)
                    denied = client.post("/api/video-jobs/" + job_id + "/reconcile", headers=headers, json={"confirmed_failed": True})
                    self.assertIn(denied.status_code, (401, 403))
                    listed = client.get("/v1/video-jobs", headers=headers)
                    self.assertEqual(len(listed.json()["items"]), 1)

    def image_asset(self):
        content = io.BytesIO()
        Image.new("RGB", (32, 24), (40, 80, 120)).save(content, format="PNG")
        return self.service.assets.save(self.user.id, content.getvalue(), "image")["asset_id"]

    def seedance(self):
        self.config.update({**self.config.get(), "video_public_base_url": "https://media.example", "video_models": [{"id": "ep-alias", "protocol": "seedance", "max_reference_images": 9, "supports_audio_upload": True, "min_duration": 4, "reference_max_duration": 15}], "video_upstreams": [{"name": "Ark 渠道", "base_url": "https://ark-proxy.example", "api_key": "ark-secret", "models": ["ep-alias"], "enabled": True}]})

    def test_grok_reference_images_voice_and_unsupported_audio(self):
        self.config.data["video_models"][0]["supports_voice"] = True
        asset = self.image_asset()
        body = VideoRequest(prompt="test", mode="reference", reference_images=[{"asset_id": asset}], reference_audios=[{"voice_id": "eve"}])
        job_id = self.service.create(self.user, body)["request_id"]
        session = self.tick(job_id, {"request_id": "ref"})
        sent = session.post.call_args.kwargs["json"]
        self.assertTrue(sent["reference_images"][0]["url"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(sent["reference_audios"], [{"voice_id": "eve"}])
        self.assertNotIn("asset_id", str(sent))
        self.assertNotIn("data:image", self.row(job_id)["payload"])
        with self.assertRaises(HTTPException):
            self.service.prepare_payload(self.user, VideoRequest(prompt="test", mode="reference", reference_audios=[{"asset_id": asset}]), self.config.get_video_models()[0])

    def test_single_image_and_reference_duration_rejected_before_charging(self):
        asset = self.image_asset()
        model = self.config.get_video_models()[0]
        body = VideoRequest(prompt="test", mode="image", reference_images=[{"asset_id": asset}])
        sent = self.service.prepare_payload(self.user, body, model)
        self.assertIn("image", sent)
        self.assertNotIn("reference_images", sent)
        for invalid in (
            VideoRequest(prompt="test", mode="image"),
            VideoRequest(prompt="test", mode="reference", duration=11, reference_images=[{"asset_id": asset}]),
            VideoRequest(prompt="test", reference_images=[{"asset_id": asset}]),
        ):
            with self.assertRaises(HTTPException):
                self.service.create(self.user, invalid)
        self.assertEqual(self.users.get_user(self.user.id).quota, 100)

    def test_asset_validation_ownership_expiry_and_public_url(self):
        with self.assertRaises(HTTPException):
            self.service.assets.save(self.user.id, b"not-a-png", "image")
        asset = self.image_asset()
        with self.assertRaises(HTTPException):
            self.service.assets.resolve("other", asset, "image", "grok")
        self.config.data["video_public_base_url"] = "https://media.example"
        url = self.service.assets.resolve(self.user.id, asset, "image", "seedance")
        token = url.rsplit("/", 1)[1]
        path, mime = self.service.assets.public_file(token)
        self.assertTrue(path.is_file())
        self.assertEqual(mime, "image/jpeg")
        with self.service.connect() as db:
            db.execute("UPDATE video_assets SET expires=? WHERE id=?", (time.time()-1, asset))
        with self.assertRaises(HTTPException):
            self.service.assets.public_file(token)
        self.service.assets.prune()
        self.assertFalse(path.exists())

    def test_seedance_multimodal_native_request_and_completion(self):
        self.seedance()
        asset = self.image_asset()
        # Synthetic valid WAV, validated by the real ffprobe runtime.
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(8000)
            wav.writeframes(b"\x00\x00" * 8000 * 3)
        audio = self.service.assets.save(self.user.id, buffer.getvalue(), "audio")["asset_id"]
        body = VideoRequest(model="ep-alias", prompt="带旁白的产品视频", mode="reference", reference_images=[{"asset_id": asset}], reference_audios=[{"asset_id": audio}])
        job_id = self.service.create(self.user, body)["request_id"]
        session = self.tick(job_id, {"id": "ark-id"})
        sent = session.post.call_args.kwargs["json"]
        self.assertTrue(session.post.call_args.args[0].endswith("/api/v3/contents/generations/tasks"))
        self.assertEqual(sent["content"][1]["role"], "reference_image")
        self.assertEqual(sent["content"][2]["role"], "reference_audio")
        self.assertTrue(sent["content"][2]["audio_url"]["url"].startswith("https://media.example/video-assets/"))
        self.assertNotIn("prompt", sent)
        self.assertEqual(sent["ratio"], "16:9")
        self.tick(job_id, {"status": "succeeded", "content": {"video_url": "https://cdn.example/seedance.mp4"}})
        self.tick(job_id)
        self.assertEqual(self.service.get(self.user.id, job_id)["status"], "done")
        self.assertEqual(self.users.get_user(self.user.id).quota, 95)

    def test_audio_constraints_and_disabled_capabilities(self):
        self.seedance()
        for content in (b"fake.mp3", b"ID3invalid-data"):
            with self.assertRaises(HTTPException):
                self.service.assets.save(self.user.id, content, "audio")
        self.config.data["video_public_base_url"] = ""
        public = self.config.get_public_video_config()["video_models"][0]
        self.assertFalse(public["supports_audio_upload"])
        self.assertEqual(public["max_reference_images"], 0)
        with self.assertRaises(ValueError):
            self.config.update({"video_models": [{"id": "grok", "supports_audio_upload": True}]})

    def test_idempotent_submit_and_catalog_changes_do_not_strand_poll(self):
        body = VideoRequest(prompt="test", client_request_id="same-client-request-0001")
        first = self.service.create(self.user, body)
        self.assertEqual(self.service.create(self.user, body)["request_id"], first["request_id"])
        self.assertEqual(self.users.get_user(self.user.id).quota, 95)
        self.tick(first["request_id"], {"request_id": "original"})
        self.config.data["video_models"] = []
        self.config.data["video_upstreams"][0]["models"] = []
        session = self.tick(first["request_id"], {"status": "pending"})
        session.get.assert_called_once()
        self.assertEqual(self.service.list("different-owner")["items"], [])


if __name__ == "__main__":
    unittest.main()

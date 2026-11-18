"""Image API security regressions; all upstream I/O and balances are isolated."""
import base64
import itertools
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests
from fastapi.testclient import TestClient

from services import api, upstream_image_service as upstream, usage_service as usage
from services.config import ConfigStore
from services.image_service import ImageSubmissionUnknownError
from services.user_service import UserService
from utils import helper


class ImageSecurityTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.config = ConfigStore(self.root / "config.json")
        self.config.update({"image_models": [
            {"id": "gpt-image-2", "generate_price": 17, "edit_price": 23},
            {"id": "hidden-model", "enabled": False, "generate_price": 51},
        ], "default_image_model": "gpt-image-2", "image_upstreams": [
            {"name": "private-route", "base_url": "https://private-provider.example/v1", "api_key": "upstream-secret",
             "models": ["gpt-image-2", "hidden-model"], "enabled": True},
        ]})
        self.users = UserService(self.root / "users.db")
        self.user = self.users.create_user("security@example.test", "isolated-password", quota=1000)
        key, _ = self.users.create_api_key(self.user.id, "isolated-test")
        self.headers = {"Authorization": "Bearer " + key}
        for mock in (
            patch.object(api, "config", self.config), patch.object(upstream, "config", self.config),
            patch.object(api, "user_service", self.users), patch.object(api, "init_default_admin_key"),
            patch.object(api, "_IMAGE_JOBS", {}), patch.object(api, "_IMAGE_JOBS_PATH", self.root / "jobs.json"),
            patch.object(usage, "DATA_FILE", self.root / "usage.json"),
            patch.object(upstream, "_UPSTREAM_COUNTER", itertools.count()),
            patch.object(upstream, "_UPSTREAM_COOLDOWNS", {}),
            patch.object(upstream, "_process_upstream_images", side_effect=lambda data, *a: data),
        ):
            self.start_patch(mock)
        self.start_patch(patch.object(api, "usage_service", usage.UsageService()))
        self.http = MagicMock()
        self.http.__enter__.return_value = self.http
        self.response = MagicMock()
        self.response.json.return_value = {"data": [{"url": "/generated-images/local.png"}]}
        self.http.post.return_value = self.response
        self.start_patch(patch.object(upstream, "_get_client", return_value=self.http))
        self.client = TestClient(api.create_app(), raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def start_patch(self, mock):
        value = mock.start()
        self.addCleanup(mock.stop)
        return value

    def send(self, kind="generations", model="gpt-image-2", prefix="/v1/images"):
        if kind == "generations":
            return self.client.post(prefix + "/" + kind, headers=self.headers, json={"prompt": "test", "model": model})
        return self.client.post(prefix + "/" + kind, headers=self.headers, data={"prompt": "test", "model": model},
                                files={"image": ("ref.png", b"uploaded-image", "image/png")})

    def reservations(self):
        with self.users._connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM user_quota_reservations ORDER BY created_at, rowid")]

    def test_api_key_canonical_model_prices_and_closed_models(self):
        for kind, model, price in (("generations", " GPT-IMAGE-2 ", 17), ("edits", "GPT-IMAGE-2", 23), ("generations", "auto", 17)):
            with self.subTest(kind=kind, model=model):
                before = self.users.get_user(self.user.id).quota
                result = self.send(kind, model)
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(before - self.users.get_user(self.user.id).quota, price)
                self.assertEqual(self.reservations()[-1]["model"], "gpt-image-2")
        count = len(self.reservations())
        for model in ("hidden-model", "unlisted-cheap-alias"):
            for prefix in ("/v1/images", "/v1/image-jobs"):
                for kind in ("generations", "edits"):
                    self.assertEqual(self.send(kind, model, prefix).status_code, 400)
        self.assertEqual(len(self.reservations()), count)

    def test_chat_and_responses_apply_model_edit_and_generation_prices(self):
        inline = "data:image/png;base64," + base64.b64encode(b"inline-image").decode()
        for endpoint, module, name in (("chat/completions", api.openai_v1_chat_complete, "handle"), ("responses", api.openai_v1_response, "handle")):
            for edit in (False, True):
                with self.subTest(endpoint=endpoint, edit=edit):
                    content = [{"type": "input_text", "text": "test"}]
                    if edit:
                        content.append({"type": "input_image", "image_url": inline})
                    body = {"model": " GPT-IMAGE-2 ", "input": content, "tools": [{"type": "image_generation"}]}
                    if endpoint.startswith("chat"):
                        body = {"model": " GPT-IMAGE-2 ", "messages": [{"role": "user", "content": content}]}
                    before = self.users.get_user(self.user.id).quota
                    with patch.object(module, name, return_value={"id": "result"}):
                        response = self.client.post("/v1/" + endpoint, json=body, headers=self.headers)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(before - self.users.get_user(self.user.id).quota, 23 if edit else 17)

    def test_external_image_urls_rejected_before_charge_and_network(self):
        for url in ("http://127.0.0.1/private", "http://169.254.169.254/", "https://external.example/image", "file:///etc/passwd", "//localhost/image"):
            for endpoint in ("chat/completions", "responses"):
                part = {"type": "image_url", "image_url": {"url": url}}
                body = {"model": "gpt-image-2", "messages": [{"role": "user", "content": [part]}]} if endpoint.startswith("chat") else {
                    "model": "gpt-image-2", "input": [{"type": "input_image", "image_url": url}], "tools": [{"type": "image_generation"}],
                }
                with patch.object(helper.requests, "get") as fetch:
                    response = self.client.post("/v1/" + endpoint, headers=self.headers, json=body)
                self.assertEqual(response.status_code, 400, response.text)
                fetch.assert_not_called()
        self.http.post.assert_not_called()
        self.assertEqual(self.reservations(), [])

    def test_inline_upload_and_request_limits(self):
        with patch.object(helper, "MAX_JSON_IMAGE_BYTES", 3):
            for value in ("data:image/png;base64," + base64.b64encode(b"12345").decode(), "data:image/png;base64,@@@@"):
                response = self.client.post("/v1/chat/completions", headers=self.headers, json={"model": "gpt-image-2", "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": value}]}]})
                self.assertIn(response.status_code, (400, 413))
        with patch.object(api, "MAX_IMAGE_JSON_BODY_BYTES", 30):
            response = self.client.post("/v1/responses", headers={**self.headers, "Content-Type": "application/json"}, content=(chunk for chunk in [b"x" * 20, b"y" * 20]))
            self.assertEqual(response.status_code, 413, response.text)
        with patch.object(api, "MAX_UPLOAD_IMAGE_BYTES", 3):
            self.assertEqual(self.send("edits").status_code, 413)
        response = self.client.post("/v1/images/edits", headers=self.headers, data={"prompt": "test"}, files=[("image", ("ref.png", b"x", "image/png"))] * 11)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.client.post("/v1/images/generations", json={"prompt": "test"}).status_code, 401)
        self.assertEqual(self.reservations(), [])

    def test_unknown_outcomes_single_post_hold_across_cleanup_and_restart(self):
        for kind in ("generations", "edits"):
            for error in (requests.Timeout("private-provider.example upstream-secret"), requests.HTTPError(response=self.error_response(502)), requests.HTTPError(response=self.error_response(408))):
                with self.subTest(kind=kind, error=type(error).__name__):
                    self.http.post.reset_mock()
                    self.http.post.side_effect = error
                    result = self.send(kind)
                    self.assertEqual(result.status_code, 504, result.text)
                    self.assertNotIn("private-provider", result.text)
                    self.http.post.assert_called_once()
                    self.assertEqual(self.reservations()[-1]["status"], "unknown")
        before = self.users.get_user(self.user.id).quota
        with self.users._connect() as db:
            db.execute("UPDATE user_quota_reservations SET updated_at=1")
        reloaded = UserService(self.root / "users.db")
        self.assertEqual(reloaded.refund_expired_quota_reservations(ttl_seconds=60), 0)
        self.assertEqual(reloaded.refund_pending_quota_reservations(), 0)
        self.assertEqual(reloaded.get_user(self.user.id).quota, before)
        self.assertNotIn("upstream-secret", json.dumps(self.reservations()))

    def test_accepted_but_invalid_response_never_reposts_or_refunds(self):
        for response_data in (None, [], {}, {"data": []}, {"data": "invalid"}):
            self.http.post.reset_mock()
            self.response.json.return_value = response_data
            response = self.send()
            self.assertEqual(response.status_code, 504, response.text)
            self.http.post.assert_called_once()
            self.assertEqual(self.reservations()[-1]["status"], "unknown")

    def test_interrupted_pending_images_hold_but_other_refunds_unchanged(self):
        image = self.users.reserve_quota(self.user.id, 17, action="image_generate")
        other = self.users.reserve_quota(self.user.id, 2, action="chat_completion")
        self.assertEqual(self.users.refund_pending_quota_reservations(), 1)
        by_id = {item["id"]: item for item in self.reservations()}
        self.assertEqual(by_id[image["id"]]["status"], "unknown")
        self.assertEqual(by_id[other["id"]]["status"], "refunded")
        self.assertEqual(self.users.get_user(self.user.id).quota, 983)
        self.assertTrue(self.users.refund_quota_reservation(image["id"], metadata={"reason": "verified_rejection"}))
        self.assertFalse(self.users.refund_quota_reservation(image["id"]))
        self.assertEqual(self.users.get_user(self.user.id).quota, 1000)

    @staticmethod
    def error_response(status):
        response = requests.Response()
        response.status_code = status
        response._content = b'{"error":{"message":"private-provider.example upstream-secret"}}'
        return response

    def test_explicit_rejection_refunds_once_without_disclosure(self):
        self.http.post.side_effect = requests.HTTPError(response=self.error_response(422))
        for kind in ("generations", "edits"):
            self.http.post.reset_mock()
            response = self.send(kind)
            self.assertEqual(response.status_code, 502)
            self.http.post.assert_called_once()
            item = self.reservations()[-1]
            self.assertEqual(item["status"], "refunded")
            self.assertFalse(self.users.refund_quota_reservation(item["id"]))
            self.assertNotIn("private-provider.example", response.text + item["metadata"])
        self.assertEqual(self.users.get_user(self.user.id).quota, 1000)

    def test_unknown_job_resume_uses_original_reservation_and_settles_once(self):
        error = ImageSubmissionUnknownError("private-provider.example", conversation_id="same-conversation", access_token="private-token", device_id="device")
        with patch.object(api, "Thread") as thread, patch.object(api.ChatGPTService, "generate_with_pool", side_effect=error):
            response = self.send(prefix="/v1/image-jobs")
            self.assertEqual(response.status_code, 200, response.text)
            args = thread.call_args.kwargs
            args["target"](*args["args"])
        job_id = response.json()["job_id"]
        self.assertEqual(api._get_image_job(job_id)["status"], "unknown")
        public = self.client.get("/v1/image-jobs/" + job_id, headers=self.headers)
        self.assertNotIn("private-token", public.text)
        self.assertNotIn("private-provider", public.text)
        for failure in (True, False):
            with patch.object(api, "Thread") as thread, patch.object(api.ChatGPTService, "resume_image_poll", side_effect=TimeoutError("private-provider") if failure else None, return_value={"data": [{"url": "/generated-images/local.png"}]}) as poll:
                response = self.client.post("/v1/image-jobs/" + job_id + "/resume-poll", headers=self.headers, json={})
                self.assertEqual(response.status_code, 200, response.text)
                args = thread.call_args.kwargs
                args["target"](*args["args"])
                self.assertEqual(poll.call_args.args[2], "same-conversation")
            self.assertEqual(len(self.reservations()), 1)
        self.assertFalse(api._get_image_job(job_id)["submission_unknown"])
        self.assertEqual(self.reservations()[0]["status"], "settled")
        self.assertEqual(self.users.get_user(self.user.id).quota, 983)
        self.assertEqual(self.users.settle_quota_reservation(self.reservations()[0]["id"], 17), 0)
        self.assertEqual(self.client.post("/v1/image-jobs/" + job_id + "/resume-poll", headers=self.headers, json={}).status_code, 400)
        self.http.post.assert_not_called()

    def test_unknown_batch_cannot_settle_all_images_from_one_resume(self):
        error = ImageSubmissionUnknownError("uncertain", conversation_id="one-of-many", access_token="private-token")
        with patch.object(api, "Thread") as thread, patch.object(api.ChatGPTService, "generate_with_pool", side_effect=error):
            response = self.client.post("/v1/image-jobs/generations", headers=self.headers, json={"prompt": "test", "model": "gpt-image-2", "n": 3})
            args = thread.call_args.kwargs
            args["target"](*args["args"])
        job_id = response.json()["job_id"]
        self.assertFalse(api._get_image_job(job_id)["can_resume"])
        self.assertEqual(self.reservations()[0]["status"], "unknown")
        self.assertEqual(self.users.get_user(self.user.id).quota, 949)
        self.assertEqual(self.client.post("/v1/image-jobs/" + job_id + "/resume-poll", headers=self.headers, json={}).status_code, 400)

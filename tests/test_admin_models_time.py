import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "synthetic-admin-test")
from services import api as api_module
from services import upstream_image_service as upstream_module
from services.config import ConfigStore, ImageModelsConfigError
from services.display_time import format_display_time
from services.usage_service import UsageService


class AdminModelsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ConfigStore(Path(self.temp.name) / "config.json")
        self.store.update({"image_upstreams": [{"name": "synthetic", "base_url": "https://example.test/v1",
                           "api_key": "private-test-key", "model": "custom-image", "enabled": True}]})
        user = SimpleNamespace(id="synthetic-user", key="synthetic-key", remaining=lambda: 100)
        for mock in (patch.object(api_module, "config", self.store),
                     patch.object(api_module, "require_user", return_value=("usr_test", user)),
                     patch.object(api_module, "init_default_admin_key")):
            mock.start()
            self.addCleanup(mock.stop)
        self.client = TestClient(api_module.create_app())
        self.addCleanup(self.client.close)

    def save(self, data):
        return self.client.post("/api/settings", json=data,
                                headers={"Authorization": f"Bearer {self.store.auth_key}"})

    def test_legacy_defaults_and_explicit_empty_are_distinct(self):
        self.assertEqual(len(self.store.get_public_image_models()), 2)
        self.store.update({"image_models": [], "default_image_model": ""})
        reloaded = ConfigStore(self.store.path)
        self.assertEqual(reloaded.get_public_image_models(), [])
        self.assertEqual(reloaded.get_default_image_model(), "")

    def test_admin_order_default_and_redacted_public_list(self):
        response = self.save({**self.store.get(), "image_models": [
            {"id": "custom-image", "label": "自定义图像", "enabled": True},
            {"id": "gpt-image-2", "label": "GPT", "enabled": True},
            {"id": "disabled-image", "label": "隐藏模型", "enabled": False}],
            "default_image_model": "gpt-image-2"})
        self.assertEqual(response.status_code, 200, response.text)
        public = self.client.get("/app-config")
        self.assertEqual(public.json()["image_models"], [
            {"id": "custom-image", "label": "自定义图像"}, {"id": "gpt-image-2", "label": "GPT"}])
        self.assertEqual(public.json()["default_image_model"], "gpt-image-2")
        for secret in ("private-test-key", "example.test", "disabled-image", "api_key"):
            self.assertNotIn(secret, public.text)
        self.assertIn("no-store", public.headers["cache-control"])
        self.store.update({"proxy": ""})
        self.assertEqual(self.store.get_public_image_models(), public.json()["image_models"])

    def test_invalid_save_does_not_replace_previous_settings(self):
        before = self.store.path.read_text()
        cases = [
            {"image_models": [{"id": "dup"}, {"id": "DUP"}]},
            {"image_models": [{"id": "auto"}]},
            {"image_models": [{"id": " "}]},
            {"image_models": [{"id": "x", "enabled": "false"}]},
            {"image_models": [{"id": "x", "enabled": False}], "default_image_model": "x"},
            {"image_models": [{"id": "x"}], "default_image_model": "absent"},
        ]
        for data in cases:
            response = self.save(data)
            self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(self.store.path.read_text(), before)
        self.assertEqual(self.client.post("/api/settings", json={"image_models": []}).status_code, 401)

    def test_disabled_models_rejected_before_charge_or_job_on_all_web_image_routes(self):
        self.store.update({"image_models": [], "default_image_model": ""})
        with patch.object(api_module, "reserve_user_quota") as charge, patch.object(api_module, "_create_image_job") as job:
            for prefix in ("/v1/image-jobs", "/v1/images"):
                response = self.client.post(prefix + "/generations", json={"prompt": "synthetic", "model": "gpt-image-2"})
                self.assertEqual(response.status_code, 400)
                response = self.client.post(prefix + "/edits", data={"prompt": "synthetic", "model": "gpt-image-2"},
                                            files={"image": ("test.png", b"synthetic", "image/png")})
                self.assertEqual(response.status_code, 400)
            charge.assert_not_called()
            job.assert_not_called()

    def test_custom_default_reaches_job_and_requires_enabled_route(self):
        self.store.update({**self.store.get(), "image_models": [{"id": "custom-image", "label": "Custom"}],
                           "default_image_model": "custom-image"})
        with patch.object(api_module, "reserve_user_quota", return_value={}) as charge, \
                patch.object(api_module, "_create_image_job", return_value="synthetic-job"), \
                patch.object(api_module, "_update_image_job"), patch.object(api_module, "Thread") as worker:
            response = self.client.post("/v1/image-jobs/generations", json={"prompt": "synthetic"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(charge.call_args.kwargs["model"], "custom-image")
            self.assertEqual(worker.call_args.kwargs["args"][2].model, "custom-image")
            charge.reset_mock()
            self.store.data["image_upstreams"][0]["enabled"] = False
            response = self.client.post("/v1/image-jobs/generations", json={"prompt": "synthetic"})
            self.assertEqual(response.status_code, 503)
            charge.assert_not_called()
            self.assertEqual(self.store.get_enabled_image_upstreams(), [])
            with patch.object(upstream_module, "config", self.store):
                self.assertTrue(upstream_module.is_upstream_image_model("custom-image"))


class DisplayTimeTests(unittest.TestCase):
    def test_utc8_midnight_and_daily_statistics(self):
        timestamp = int(datetime(2026, 10, 4, 16, tzinfo=timezone.utc).timestamp())
        self.assertEqual(format_display_time(timestamp), "2026-10-05 00:00:00")
        with patch.object(UsageService, "_load"):
            service = UsageService()
        service._records = [{"timestamp": timestamp - 1, "status": "success"},
                            {"timestamp": timestamp, "status": "success"}]
        with patch("services.usage_service.time.time", return_value=timestamp + 10):
            stats = service.get_stats()["daily_stats"]
        self.assertEqual(stats["2026-10-04"]["total"], 1)
        self.assertEqual(stats["2026-10-05"]["total"], 1)


if __name__ == "__main__":
    unittest.main()

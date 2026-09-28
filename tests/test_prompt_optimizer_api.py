import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import httpx

from fastapi import HTTPException
from fastapi.testclient import TestClient

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-admin")
from services import api as api_module
from services.config import ConfigStore
from services.prompt_optimizer_service import PromptOptimizerService, OptimizerLimits


class OptimizerEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ConfigStore(Path(self.temp.name) / "config.json")
        self.store.update({"prompt_optimizer": {
            "enabled": True, "base_url": "https://optimizer.example/v1",
            "api_key": "test-hidden-credential", "model": "test-model",
        }})
        self.user = SimpleNamespace(id="stable-user-id", created_at=0, remaining=lambda: 10)
        for mock in (patch.object(api_module, "config", self.store), patch.object(api_module, "log_user_usage"), patch.object(api_module, "init_default_admin_key")):
            mock.start()
            self.addCleanup(mock.stop)
        self.identity = patch.object(api_module.user_service, "get_by_token", side_effect=lambda token: self.user if token in {"usr_first", "usr_second"} else None)
        self.identity.start()
        self.addCleanup(self.identity.stop)
        self.client = TestClient(api_module.create_app())
        self.addCleanup(self.client.close)

    def test_user_api_key_and_invalid_session_cannot_reach_provider(self):
        with patch.object(PromptOptimizerService, "optimize", new_callable=AsyncMock) as optimize:
            for token, code in (("uak_key.secret", 403), ("test-admin", 403), ("usr_invalid", 401)):
                response = self.client.post("/v1/image-prompts/optimize", json={"prompt": "猫"}, headers={"Authorization": f"Bearer {token}"})
                self.assertEqual(response.status_code, code)
            optimize.assert_not_called()

    def test_extra_parameters_and_body_limit_are_checked_before_provider(self):
        headers = {"Authorization": "Bearer usr_first"}
        with patch.object(PromptOptimizerService, "optimize", new_callable=AsyncMock) as optimize:
            response = self.client.post("/v1/image-prompts/optimize", json={"prompt": "cat", "model": "expensive-model"}, headers=headers)
            self.assertEqual(response.status_code, 422)
            response = self.client.post("/v1/image-prompts/optimize", content=b"x" * 65537, headers=headers)
            self.assertEqual(response.status_code, 413)
            optimize.assert_not_called()

    def test_real_identity_and_admin_model_are_used(self):
        with patch.object(PromptOptimizerService, "optimize", new_callable=AsyncMock, return_value={"optimized_prompt": "一只猫，柔和光线"}) as optimize:
            for token in ("usr_first", "usr_second"):
                response = self.client.post("/v1/image-prompts/optimize", json={"prompt": "猫", "model": "auto"}, headers={"Authorization": f"Bearer {token}"})
                self.assertEqual(response.status_code, 200)
                args = optimize.call_args.args
                self.assertEqual(args[0].id, "stable-user-id")
                self.assertEqual(args[2].model, "test-model")

    def test_rate_limit_status_and_retry_after_are_preserved(self):
        with patch.object(PromptOptimizerService, "optimize", new_callable=AsyncMock, side_effect=HTTPException(429, detail={"error": "rate limited"}, headers={"Retry-After": "60"})):
            response = self.client.post("/v1/image-prompts/optimize", json={"prompt": "cat"}, headers={"Authorization": "Bearer usr_first"})
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.headers["Retry-After"], "60")

    def test_full_request_flow_shares_rpm_across_sessions(self):
        self.store.data["prompt_optimizer"]["user_rpm"] = 1
        calls = []
        def upstream(request):
            calls.append(request)
            return httpx.Response(200, json={"choices": [{"message": {"content": "猫，柔和光线"}}]})
        service = PromptOptimizerService(
            OptimizerLimits(Path(self.temp.name) / "rate.db"),
            lambda **kw: httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kw),
        )
        with patch.object(api_module, "PromptOptimizerService", return_value=service):
            client = TestClient(api_module.create_app())
        try:
            first = client.post("/v1/image-prompts/optimize", json={"prompt": "猫"}, headers={"Authorization": "Bearer usr_first"})
            second = client.post("/v1/image-prompts/optimize", json={"prompt": "猫"}, headers={"Authorization": "Bearer usr_second"})
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json()["optimized_prompt"], "猫，柔和光线")
            self.assertEqual(second.status_code, 429)
            self.assertEqual(len(calls), 1)
        finally:
            client.close()

    def test_admin_settings_hide_key_and_public_config_has_no_optimizer(self):
        response = self.client.get("/api/settings", headers={"Authorization": f"Bearer {self.store.auth_key}"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("test-hidden-credential", response.text)
        self.assertTrue(response.json()["config"]["prompt_optimizer"]["has_api_key"])
        self.assertEqual(self.client.get("/api/settings", headers={"Authorization": "Bearer usr_first"}).status_code, 401)
        self.assertNotIn("prompt_optimizer", self.client.get("/app-config").json())

    def test_invalid_admin_limits_return_redacted_400(self):
        response = self.client.post("/api/settings", json={"prompt_optimizer": {"enabled": True, "api_key": "do-not-echo-secret", "user_rpm": 0}}, headers={"Authorization": f"Bearer {self.store.auth_key}"})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("do-not-echo-secret", response.text)


if __name__ == "__main__":
    unittest.main()

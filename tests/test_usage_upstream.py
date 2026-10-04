import itertools
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, current_thread

from fastapi.testclient import TestClient
import requests

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "synthetic-usage-admin")
from services import api, chatgpt_service, upstream_image_service as upstream, usage_service as usage
from services.config import ConfigStore
from services.image_service import ImageGenerationError
from services.protocol import conversation, openai_v1_chat_complete as chat, openai_v1_response as responses
from services.protocol.chat_completion_cache import ChatCompletionCache
from services.gptfree_response_service import gptfree_response_service
from admin import api as admin_api


class UsageUpstreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = ConfigStore(self.root / "config.json")
        self.config.update({"image_upstreams": [
            {"name": name, "base_url": "https://private-provider.example/v1", "api_key": "never-record-key",
             "model": "gpt-image-2", "enabled": True} for name in ("线路甲", "线路乙")
        ]})
        self.patcher(patch.object(usage, "DATA_FILE", self.root / "usage.json"))
        self.usage = usage.UsageService()
        user = SimpleNamespace(id="synthetic-user", email="user@example.test", key="synthetic-user-key")
        for mock in (
            patch.object(api, "config", self.config), patch.object(upstream, "config", self.config),
            patch.object(api, "usage_service", self.usage), patch.object(admin_api, "usage_service", self.usage),
            patch.object(api, "init_default_admin_key"), patch.object(api, "require_user", return_value=("usr_test", user)),
            patch.object(admin_api, "require_admin", return_value="synthetic-admin"),
            patch.object(api, "reserve_user_quota", return_value={"id": "test-reservation", "amount": 1}),
            patch.object(api, "settle_user_quota_reservation", return_value=1),
            patch.object(api, "refund_user_quota_reservation"),
            patch.object(upstream, "_UPSTREAM_COUNTER", itertools.count()),
            patch.object(upstream, "_UPSTREAM_COOLDOWNS", {}),
            patch.object(upstream, "_process_upstream_images", side_effect=lambda images, *args: images),
        ): self.patcher(mock)
        self.http = MagicMock()
        self.http.__enter__.return_value = self.http
        self.response = MagicMock()
        self.response.json.return_value = {"created": 1, "data": [{"url": "/synthetic.png"}]}
        self.http.post.return_value = self.response
        self.patcher(patch.object(upstream, "_get_client", return_value=self.http))
        self.client = TestClient(api.create_app(), raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def patcher(self, mock):
        result = mock.start()
        self.addCleanup(mock.stop)
        return result

    def send(self, prefix, kind):
        if kind == "generations":
            return self.client.post(prefix + "/" + kind, json={"prompt": "synthetic prompt", "model": "gpt-image-2"})
        return self.client.post(prefix + "/" + kind, data={"prompt": "synthetic edit", "model": "gpt-image-2"},
                                files={"image": ("test.png", b"synthetic", "image/png")})

    def test_sync_generation_edit_persist_selected_upstream_and_admin_can_read(self):
        for kind, expected in (("generations", "线路甲"), ("edits", "线路乙")):
            response = self.send("/v1/images", kind)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertNotIn("upstream_name", response.text)
            self.assertNotIn(expected, response.text)
            saved = usage.UsageService().get_records()["records"][0]
            self.assertEqual(saved["upstream_name"], expected)
        records = self.client.get("/admin/api/usage/records").json()["records"]
        self.assertEqual([r["upstream_name"] for r in records], ["线路乙", "线路甲"])
        raw = (self.root / "usage.json").read_text()
        self.assertNotIn("never-record-key", raw)
        self.assertNotIn("private-provider.example", raw)
        self.config.data["image_upstreams"][0]["name"] = "改名后"
        self.assertEqual(records[1]["upstream_name"], "线路甲")

    def test_retries_record_last_selected_upstream_on_success_and_failure(self):
        for kind in ("generations", "edits"):
            with self.subTest(kind=kind):
                with patch.object(upstream, "_UPSTREAM_COUNTER", itertools.count()):
                    self.http.post.side_effect = [requests.Timeout("synthetic timeout"), self.response]
                    self.assertEqual(self.send("/v1/images", kind).status_code, 200)
                    self.assertEqual(self.usage.get_records()["records"][0]["upstream_name"], "线路乙")
                with patch.object(upstream, "_UPSTREAM_COUNTER", itertools.count()):
                    self.http.post.side_effect = requests.Timeout("synthetic failure")
                    self.assertEqual(self.send("/v1/images", kind).status_code, 502)
                    record = self.usage.get_records()["records"][0]
                    self.assertEqual((record["status"], record["upstream_name"]), ("failed", "线路甲"))

    def test_background_jobs_log_upstream_on_success_and_failure(self):
        class InlineThread:
            def __init__(self, target, args, **kwargs): self.target, self.args = target, args
            def start(self): self.target(*self.args)
        with patch.object(api, "Thread", InlineThread), patch.object(api, "_create_image_job", return_value="job"), \
                patch.object(api, "_get_image_job", return_value={}), patch.object(api, "_update_image_job"):
            for kind in ("generations", "edits"):
                for failure in (False, True):
                    with self.subTest(kind=kind, failure=failure), patch.object(upstream, "_UPSTREAM_COUNTER", itertools.count()):
                        self.http.post.side_effect = requests.Timeout("synthetic failure") if failure else None
                        self.assertEqual(self.send("/v1/image-jobs", kind).status_code, 200)
                        record = self.usage.get_records()["records"][0]
                        self.assertEqual(record["upstream_name"], "线路甲")
                        self.assertEqual(record["status"], "failed" if failure else "success")

    def test_failure_before_selection_is_not_attributed_to_configured_provider(self):
        with patch.object(upstream, "_choose_upstream", side_effect=ImageGenerationError("no available upstream")):
            self.assertEqual(self.send("/v1/images", "generations").status_code, 502)
        self.assertEqual(self.usage.get_records()["records"][0]["upstream_name"], "未调用上游")

    def test_parallel_requests_keep_separate_metadata(self):
        barrier = Barrier(2)
        def choose(model):
            return {"name": current_thread().name, "model": model, "base_url": "https://example.test", "api_key": "secret"}
        def post(*args, **kwargs):
            barrier.wait(timeout=5)
            return self.response
        def run():
            metadata = {}
            upstream.generate_image_upstream("synthetic", model="gpt-image-2", metadata=metadata)
            return current_thread().name, metadata["upstream_name"]
        self.http.post.side_effect = post
        with patch.object(upstream, "_choose_upstream", side_effect=choose), ThreadPoolExecutor(max_workers=2) as pool:
            results = [f.result() for f in [pool.submit(run), pool.submit(run)]]
        self.assertEqual(len({r[1] for r in results}), 2)
        self.assertTrue(all(actual == recorded for actual, recorded in results))

    def protocol_body(self, endpoint, stream, model="gpt-image-2"):
        body = {"model": model, "stream": stream, "usage_metadata": {"upstream_name": "forged"}}
        if endpoint == "chat/completions":
            body["messages"] = [{"role": "user", "content": "synthetic prompt"}]
        else:
            body["input"] = "synthetic prompt"
            if model == "gpt-image-2":
                body["tools"] = [{"type": "image_generation"}]
        return body

    def test_protocol_images_streaming_and_nonstreaming_record_account_pool(self):
        accounts = MagicMock()
        accounts.get_available_access_token.return_value = "synthetic-account"
        accounts.get_account.return_value = {}
        result = conversation.ImageOutput(kind="result", model="gpt-image-2", index=1, total=1, data=[{"b64_json": "c3ludGhldGlj"}])
        with patch.object(conversation, "account_service", accounts), patch.object(conversation, "OpenAIBackendAPI"), \
                patch.object(conversation, "stream_image_outputs") as generate:
            for endpoint in ("chat/completions", "responses"):
                for stream in (False, True):
                    for failure in (False, True):
                        with self.subTest(endpoint=endpoint, stream=stream, failure=failure):
                            generate.side_effect = RuntimeError("synthetic failure") if failure else lambda *a: iter([result])
                            response = self.client.post("/v1/" + endpoint, json=self.protocol_body(endpoint, stream))
                            self.assertEqual(response.status_code, 200 if stream or not failure else 502, response.text)
                            record = self.usage.get_records()["records"][0]
                            self.assertEqual(record["upstream_name"], "ChatGPT 账号池")
                            self.assertEqual(record["status"], "failed" if failure else "success")
                            self.assertNotIn("upstream_name", response.text)
                            self.assertNotIn("ChatGPT 账号池", response.text)
            accounts.get_available_access_token.side_effect = RuntimeError("no account available")
            self.client.post("/v1/chat/completions", json=self.protocol_body("chat/completions", False))
            self.assertEqual(self.usage.get_records()["records"][0]["upstream_name"], "未调用上游")

    def test_protocol_text_distinguishes_live_account_and_cached_response(self):
        accounts = MagicMock()
        accounts.get_text_access_token.return_value = "synthetic-account"
        cache = ChatCompletionCache()
        with patch.object(chat, "chat_completion_cache", cache), patch.object(responses, "chat_completion_cache", cache), \
                patch.object(cache, "_settings", return_value={"enabled": True, "stream_cache": True, "ttl_seconds": 60, "max_entries": 20}), \
                patch.object(conversation, "account_service", accounts), patch.object(conversation, "OpenAIBackendAPI"), \
                patch.object(conversation, "conversation_events", side_effect=lambda *a, **kw: iter([{"type": "conversation.delta", "delta": "hello"}])):
            for endpoint in ("chat/completions", "responses"):
                for stream in (False, True):
                    cache.clear()
                    for expected in ("ChatGPT 账号池", "本地缓存 / 请求合并"):
                        response = self.client.post("/v1/" + endpoint, json=self.protocol_body(endpoint, stream, "auto"))
                        self.assertEqual(response.status_code, 200, response.text)
                        self.assertEqual(self.usage.get_records()["records"][0]["upstream_name"], expected)
                        self.assertNotIn("upstream_name", response.text)
            cache.clear()
            accounts.get_text_access_token.side_effect = RuntimeError("no account available")
            self.client.post("/v1/responses", json=self.protocol_body("responses", True, "auto"))
            self.assertEqual(self.usage.get_records()["records"][0]["upstream_name"], "未调用上游")

    def test_gptfree_protocol_uses_its_own_pool_label(self):
        accounts = MagicMock()
        accounts.get_text_access_token.return_value = "synthetic-account"
        accounts.get_account.return_value = {"gptfree_identity_id": "synthetic-identity"}
        events = [{"type": "response.output_text.delta", "delta": "hello"},
                  {"type": "response.completed", "response": {"output": []}}]
        with patch("services.gptfree_response_service.account_service", accounts), \
                patch.object(gptfree_response_service, "_stream_account", side_effect=lambda *a: iter(events)):
            for endpoint in ("chat/completions", "responses"):
                for stream in (False, True):
                    response = self.client.post("/v1/" + endpoint, json=self.protocol_body(endpoint, stream, "gptfree"))
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(self.usage.get_records()["records"][0]["upstream_name"], "GPTFree 账号池")
                    self.assertNotIn("upstream_name", response.text)

    def test_account_resume_and_legacy_records_have_unambiguous_labels(self):
        metadata = {}
        with patch.object(chatgpt_service, "resume_image_poll_result", return_value={}):
            chatgpt_service.ChatGPTService().resume_image_poll("synthetic-token", "device", "conversation", metadata=metadata)
        self.assertEqual(metadata["upstream_name"], "ChatGPT 账号池")
        legacy = {"id": "legacy", "timestamp": 1, "model": "gpt-image-2", "status": "success"}
        (self.root / "usage.json").write_text(json.dumps([legacy]))
        restored = usage.UsageService().get_records()["records"][0]
        self.assertEqual(restored, legacy)


if __name__ == "__main__":
    unittest.main()

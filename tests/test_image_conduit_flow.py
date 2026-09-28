from __future__ import annotations

import base64
import time
import unittest
from unittest.mock import patch

from services import chatgpt_service as chatgpt_service_module
from services import image_service
from services import openai_backend_api
from services.register.mail_provider import CloudflareTempMailProvider
from services.protocol import conversation


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"test-image"


class ImageConduitFlowTests(unittest.TestCase):
    def test_format_image_result_uses_injected_saver(self) -> None:
        saved: list[bytes] = []

        result = conversation.format_image_result(
            [{"b64_json": base64.b64encode(PNG_BYTES).decode("ascii")}],
            "draw a chair",
            "url",
            image_saver=lambda image_data: saved.append(image_data) or "/generated-images/test.png",
        )

        self.assertEqual(saved, [PNG_BYTES])
        self.assertEqual(result["data"][0]["url"], "/generated-images/test.png")

    def test_missing_sse_metadata_recovers_and_polls_image_conversation(self) -> None:
        started_at = time.time() - 5

        class Backend:
            def __init__(self) -> None:
                self.find_started_at = 0.0
                self.poll_calls = 0

            def find_conversation_by_prompt(self, prompt: str, request_started_at: float, timeout_secs: float) -> str:
                self.find_started_at = request_started_at
                return "conversation-recovered"

            def resolve_conversation_image_urls(
                self,
                conversation_id: str,
                file_ids: list[str],
                sediment_ids: list[str],
                poll: bool = True,
                poll_timeout_secs: float | None = None,
            ) -> list[str]:
                if conversation_id and file_ids:
                    return ["https://download.example/image.png"]
                return []

            def _poll_image_results(
                self,
                conversation_id: str,
                timeout_secs: float,
                file_ids: list[str],
                sediment_ids: list[str],
            ) -> tuple[list[str], list[str]]:
                self.poll_calls += 1
                return ["file_00000000000000000000000000000000"], []

            def download_image_bytes(self, urls: list[str]) -> list[bytes]:
                return [PNG_BYTES]

        backend = Backend()
        request = conversation.ConversationRequest(
            model="gpt-image-2",
            prompt="draw a chair",
            response_format="url",
            image_saver=lambda _: "/generated-images/recovered.png",
            deadline=time.monotonic() + 30,
            timeout_label_secs=30,
            started_at_epoch=started_at,
        )
        terminal_event = {
            "type": "conversation.event",
            "conversation_id": "",
            "file_ids": [],
            "sediment_ids": [],
            "text": "",
            "blocked": False,
            "tool_invoked": None,
            "turn_use_case": "",
            "raw": {},
        }

        with (
            patch.object(conversation, "conversation_events", return_value=iter([terminal_event])),
            patch.object(conversation, "_sleep_with_image_deadline", return_value=None),
        ):
            outputs = list(conversation.stream_image_outputs(backend, request))

        results = [output for output in outputs if output.kind == "result"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].conversation_id, "conversation-recovered")
        self.assertEqual(results[0].data[0]["url"], "/generated-images/recovered.png")
        self.assertEqual(backend.find_started_at, started_at)
        self.assertEqual(backend.poll_calls, 1)

    def test_conduit_timeout_preserves_resumable_state(self) -> None:
        timeout = openai_backend_api.ImagePollTimeoutError("poll timed out")
        setattr(timeout, "conversation_id", "conversation-timeout")

        class Backend:
            device_id = "device-test"

            class Session:
                closed = False

                def close(self) -> None:
                    self.closed = True

            def __init__(self, access_token: str) -> None:
                self.access_token = access_token
                self.session = self.Session()
                self.image_request_deadline = None
                self.image_request_timeout_label_secs = None
                self.progress_callback = None

        with (
            patch.object(openai_backend_api, "OpenAIBackendAPI", Backend),
            patch.object(conversation, "stream_image_outputs", side_effect=timeout),
        ):
            with self.assertRaises(image_service.ImagePollTimeoutError) as raised:
                image_service.generate_image_result_conduit(
                    "access-token",
                    "draw a chair",
                    "gpt-image-2",
                    timeout_secs=10,
                )

        self.assertEqual(raised.exception.conversation_id, "conversation-timeout")
        self.assertEqual(raised.exception.access_token, "access-token")
        self.assertEqual(raised.exception.device_id, "device-test")

    def test_http2_stream_errors_are_retryable(self) -> None:
        message = "curl: (92) HTTP/2 stream 1 was not closed cleanly"
        self.assertTrue(chatgpt_service_module._is_tls_connection_error(message))
        self.assertTrue(conversation.is_tls_connection_error(message))

    def test_grok_model_edits_use_configured_upstream_not_account_pool(self) -> None:
        service = chatgpt_service_module.ChatGPTService()
        expected = {"created": 1, "data": [{"url": "/generated-images/edit.png"}]}
        with (
            patch.object(chatgpt_service_module, "edit_image_upstream", return_value=expected) as edit_upstream,
            patch.object(service, "_ensure_free_account_pool") as ensure_pool,
        ):
            result = service.edit_with_pool("make it brighter", [(PNG_BYTES, "input.png", "image/png")], "grok-imagine-image", 1)
        self.assertEqual(result, expected)
        edit_upstream.assert_called_once_with("make it brighter", [(PNG_BYTES, "input.png", "image/png")], n=1, metadata=None, model="grok-imagine-image")
        ensure_pool.assert_not_called()

    def test_grok_model_remains_enabled_for_text_to_image(self) -> None:
        service = chatgpt_service_module.ChatGPTService()
        expected = {"created": 1, "data": [{"url": "/generated-images/grok.png"}]}
        with (
            patch.object(chatgpt_service_module, "generate_image_upstream", return_value=expected) as generate_upstream,
            patch.object(service, "_ensure_free_account_pool") as ensure_pool,
        ):
            result = service.generate_with_pool("draw a chair", "grok-imagine-image", 1)

        self.assertEqual(result, expected)
        generate_upstream.assert_called_once()
        ensure_pool.assert_not_called()

    def test_cloudflare_provider_prefers_saved_api_key_as_admin_password(self) -> None:
        provider = CloudflareTempMailProvider(
            {
                "api_base": "https://mail.example",
                "api_key": "ss5870096",
                "admin_password": "stale-password",
                "domain": ["mail.example"],
            },
            {"request_timeout": 1, "wait_timeout": 1, "wait_interval": 1, "user_agent": "test", "proxy": ""},
        )
        try:
            self.assertEqual(provider.admin_password, "ss5870096")
        finally:
            provider.close()


if __name__ == "__main__":
    unittest.main()

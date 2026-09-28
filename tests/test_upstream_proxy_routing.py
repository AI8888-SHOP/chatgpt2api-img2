from __future__ import annotations

import unittest
import threading
import time
from unittest.mock import patch

from services import account_service as account_service_module
from services import chatgpt_service
from services import image_service
from services import openai_backend_api
from utils import helper


class _DummySession:
    def __init__(self) -> None:
        self.headers: dict[str, str] = {}

    def close(self) -> None:
        pass


class _BlockingResponse:
    def __init__(self) -> None:
        self.closed = threading.Event()

    def iter_lines(self):
        self.closed.wait(1)
        return
        yield  # pragma: no cover

    def close(self) -> None:
        self.closed.set()


class UpstreamProxyRoutingTests(unittest.TestCase):
    def test_openai_backend_uses_account_upstream_proxy(self) -> None:
        account = {"proxy": "http://privoxy:8118", "fp": {}}
        with (
            patch.object(openai_backend_api.account_service, "get_account", return_value=account),
            patch.object(openai_backend_api.proxy_settings, "build_session_kwargs", return_value={}) as build_kwargs,
            patch.object(openai_backend_api.requests, "Session", return_value=_DummySession()),
        ):
            backend = openai_backend_api.OpenAIBackendAPI("access-token")

        self.assertEqual(build_kwargs.call_args.kwargs["account"], account)
        self.assertIs(build_kwargs.call_args.kwargs["upstream"], True)
        backend.session.close()

    def test_legacy_image_session_uses_account_upstream_proxy(self) -> None:
        account = {"proxy": "http://privoxy:8118", "fp": {}}
        with (
            patch.object(image_service.account_service, "get_account", return_value=account),
            patch.object(image_service.proxy_settings, "build_session_kwargs", return_value={}) as build_kwargs,
            patch.object(image_service, "Session", return_value=_DummySession()),
        ):
            session, _ = image_service._new_session("access-token")

        self.assertEqual(build_kwargs.call_args.kwargs["account"], account)
        self.assertIs(build_kwargs.call_args.kwargs["upstream"], True)
        session.close()

    def test_account_refresh_uses_account_upstream_proxy(self) -> None:
        account = {"proxy": "http://privoxy:8118"}
        service = account_service_module.account_service
        with (
            patch.object(service, "get_account", return_value=account),
            patch.object(service, "_build_remote_headers", return_value=({}, "chrome")),
            patch.object(account_service_module.proxy_settings, "build_session_kwargs", return_value={}) as build_kwargs,
            patch.object(account_service_module, "Session", side_effect=RuntimeError("stop before network")),
            self.assertRaisesRegex(RuntimeError, "stop before network"),
        ):
            service.fetch_remote_info("access-token")

        self.assertEqual(build_kwargs.call_args.kwargs["account"], account)
        self.assertIs(build_kwargs.call_args.kwargs["upstream"], True)

    def test_bootstrap_403_is_retryable(self) -> None:
        self.assertTrue(
            chatgpt_service._is_retryable_upstream_session_error(
                "bootstrap failed: status=403, body=Request blocked"
            )
        )
        self.assertFalse(
            chatgpt_service._is_retryable_upstream_session_error(
                "Image generation was rejected by upstream policy."
            )
        )

    def test_gpt_image_2_uses_current_picture_model_slug(self) -> None:
        backend = object.__new__(openai_backend_api.OpenAIBackendAPI)
        self.assertEqual(backend._image_model_slug("gpt-image-2"), "gpt-5-5-thinking")

    def test_image_sse_reader_enforces_absolute_deadline(self) -> None:
        response = _BlockingResponse()
        with self.assertRaises(helper.SSEStreamTimeoutError):
            list(helper.iter_sse_payloads(response, deadline=time.monotonic() + 0.05))
        self.assertTrue(response.closed.is_set())


if __name__ == "__main__":
    unittest.main()

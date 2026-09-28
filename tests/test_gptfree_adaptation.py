from __future__ import annotations

import base64
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives.serialization import load_der_private_key

from services import gptfree_response_service as gptfree_response_module
from services import register_service as register_service_module
from services.account_service import AccountService
from services.gptfree_identity_service import (
    GptFreeIdentityService,
    build_agent_assertion,
)
from services.protocol import openai_v1_models
from services.register import gptfree_register, mail_provider
from services.register.mail_provider import CloudflareTempMailProvider


def _b64url_json(value: dict) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _access_token() -> str:
    claims = {
        "exp": int(time.time()) + 3600,
        "sub": "user-test",
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "account-test",
            "chatgpt_user_id": "user-test",
            "chatgpt_plan_type": "free",
        },
        "https://api.openai.com/profile": {"email": "test@example.com"},
    }
    return f"{_b64url_json({'alg': 'none'})}.{_b64url_json(claims)}.signature"


def _mail_conf() -> dict:
    return {
        "request_timeout": 1,
        "wait_timeout": 1,
        "wait_interval": 1,
        "user_agent": "test",
        "proxy": "",
    }


class GptFreeAdaptationTests(unittest.TestCase):
    def test_default_and_gptfree_account_pools_are_strictly_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store_file = Path(directory) / "accounts.json"
            store_file.write_text(
                json.dumps(
                    [
                        {
                            "access_token": "web-token",
                            "source_type": "web",
                            "status": "正常",
                            "quota": 3,
                        },
                        {
                            "access_token": "gptfree-token",
                            "source_type": "gptfree",
                            "status": "正常",
                            "quota": 7,
                        },
                    ]
                ),
                encoding="utf-8",
            )
            service = AccountService(store_file)

            self.assertEqual(
                service.get_text_access_token(source_type="default", refresh=False),
                "web-token",
            )
            self.assertEqual(
                service.get_text_access_token(source_type="gptfree", refresh=False),
                "gptfree-token",
            )
            self.assertEqual(
                service._list_available_candidate_tokens(source_type="default"),
                ["web-token"],
            )
            self.assertEqual(
                service._list_available_candidate_tokens(source_type="gptfree"),
                ["gptfree-token"],
            )

    def test_register_metrics_are_isolated_by_account_source(self) -> None:
        accounts = [
            {"source_type": "web", "status": "正常", "quota": 11},
            {"source_type": "gptfree", "status": "正常", "quota": 13},
            {"source_type": "gptfree", "status": "异常", "quota": 100},
        ]
        with patch.object(
            register_service_module.account_service,
            "list_accounts",
            return_value=accounts,
        ):
            default_service = object.__new__(register_service_module.RegisterService)
            default_service._account_source_type = "default"
            gptfree_service = object.__new__(register_service_module.RegisterService)
            gptfree_service._account_source_type = "gptfree"

            self.assertEqual(
                default_service._pool_metrics(),
                {"current_quota": 11, "current_available": 1},
            )
            self.assertEqual(
                gptfree_service._pool_metrics(),
                {"current_quota": 13, "current_available": 1},
            )

    def test_agent_private_key_is_encrypted_and_assertion_is_valid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identities_file = root / "identities.json"
            service = GptFreeIdentityService(
                identities_file=identities_file,
                master_key_file=root / "master.key",
            )
            with patch.object(
                service,
                "_post_json",
                return_value={"agent_runtime_id": "runtime-test"},
            ):
                public_identity = service.register_runtime(_access_token())

            identity_id = str(public_identity["identity_id"])
            stored_text = identities_file.read_text(encoding="utf-8")
            stored = json.loads(stored_text)["identities"][identity_id]
            self.assertIn("agent_private_key_encrypted", stored)
            self.assertNotIn("agent_private_key", stored)
            self.assertNotIn("agent_private_key_encrypted", public_identity)

            identity = service.get_identity(identity_id)
            private_key_b64 = str(identity["agent_private_key"])
            self.assertNotIn(private_key_b64, stored_text)
            assertion = build_agent_assertion(
                "runtime-test",
                "task-test",
                private_key_b64,
                timestamp="2026-07-22T00:00:00Z",
            )
            decoded = assertion + "=" * ((4 - len(assertion) % 4) % 4)
            payload = json.loads(base64.urlsafe_b64decode(decoded))
            self.assertEqual(payload["agent_runtime_id"], "runtime-test")
            self.assertEqual(payload["task_id"], "task-test")

            private_key = load_der_private_key(
                base64.b64decode(private_key_b64),
                password=None,
            )
            private_key.public_key().verify(
                base64.b64decode(payload["signature"]),
                b"runtime-test:task-test:2026-07-22T00:00:00Z",
            )

    def test_gptfree_response_uses_agent_assertion_without_web_token(self) -> None:
        class FakeIdentityService:
            def authorization(self, *args, **kwargs):
                return {
                    "Authorization": "AgentAssertion signed-value",
                    "ChatGPT-Account-ID": "account-test",
                }

            def invalidate_task(self, identity_id: str) -> None:
                raise AssertionError(f"unexpected task invalidation: {identity_id}")

        class FakeResponse:
            status_code = 200

        class FakeSession:
            def __init__(self) -> None:
                self.request: dict = {}
                self.closed = False

            def post(self, url, **kwargs):
                self.request = {"url": url, **kwargs}
                return FakeResponse()

            def close(self) -> None:
                self.closed = True

        session = FakeSession()
        account = {
            "access_token": "web-access-token-must-not-be-sent",
            "source_type": "gptfree",
        }
        with (
            patch.object(
                gptfree_response_module,
                "gptfree_identity_service",
                FakeIdentityService(),
            ),
            patch.object(
                gptfree_response_module.proxy_settings,
                "build_session_kwargs",
                return_value={"proxy": "http://privoxy:8118"},
            ) as build_session_kwargs,
            patch.object(
                gptfree_response_module.requests,
                "Session",
                return_value=session,
            ),
            patch.object(
                gptfree_response_module,
                "iter_sse_payloads",
                return_value=iter(
                    [
                        json.dumps(
                            {
                                "type": "response.output_text.delta",
                                "delta": "ok",
                            }
                        ),
                        "[DONE]",
                    ]
                ),
            ),
        ):
            events = list(
                gptfree_response_module.GptFreeResponseService()._stream_account(
                    {
                        "model": "gptfree",
                        "input": "hello",
                        "account_pool": "gptfree",
                    },
                    account,
                    "identity-test",
                )
            )

        self.assertEqual(events[0]["delta"], "ok")
        self.assertTrue(session.closed)
        self.assertEqual(
            session.request["headers"]["Authorization"],
            "AgentAssertion signed-value",
        )
        self.assertNotIn(
            "web-access-token-must-not-be-sent",
            json.dumps(session.request),
        )
        self.assertEqual(session.request["json"]["model"], "gpt-5.6-sol")
        self.assertNotIn("account_pool", session.request["json"])
        self.assertIs(build_session_kwargs.call_args.kwargs["upstream"], True)

    def test_gptfree_register_receives_complete_mail_configuration(self) -> None:
        full_mail_config = {
            "request_timeout": 30,
            "wait_timeout": 90,
            "wait_interval": 2,
            "api_use_register_proxy": True,
            "providers": [
                {
                    "enable": True,
                    "type": "cloudflare_temp_email",
                    "api_base": "https://mail.example",
                    "admin_password": "saved-password",
                    "domain": ["one.example", "two.example"],
                    "subdomain_levels": ["signup", "edge"],
                    "append_random_suffix": False,
                    "fixed_address": "fixed@one.example",
                }
            ],
        }
        captured: dict = {}

        class FakeRegistrar:
            def __init__(self, proxy, stop_event=None, mail_config=None) -> None:
                captured["proxy"] = proxy
                captured["mail"] = mail_config

            def register(self, index: int) -> dict:
                return {
                    "access_token": "new-web-token",
                    "email": "new@example.com",
                }

            def _ensure_active(self) -> None:
                pass

            def close(self) -> None:
                captured["closed"] = True

        class FakeIdentityService:
            def register_runtime(self, access_token: str, account_context=None) -> dict:
                return {
                    "identity_id": "identity-test",
                    "agent_runtime_id": "runtime-test",
                }

        class FakeAccountService:
            def add_account(self, access_token: str, metadata=None) -> None:
                captured["saved_account"] = (access_token, metadata)

            def refresh_accounts(self, access_tokens: list[str]) -> dict:
                return {"errors": []}

        with (
            patch.dict(
                gptfree_register.config,
                {"proxy": "http://register-proxy", "mail": full_mail_config},
                clear=False,
            ),
            patch.dict(
                gptfree_register.stats,
                {"done": 0, "success": 0, "fail": 0, "start_time": time.time()},
                clear=True,
            ),
            patch.object(
                gptfree_register.reference_register,
                "ReferencePlatformRegistrar",
                FakeRegistrar,
            ),
            patch.object(
                gptfree_register,
                "gptfree_identity_service",
                FakeIdentityService(),
            ),
            patch.object(
                gptfree_register,
                "account_service",
                FakeAccountService(),
            ),
            patch.object(gptfree_register.openai_register, "step"),
            patch.object(gptfree_register.openai_register, "log"),
        ):
            result = gptfree_register.worker(1)

        self.assertTrue(result["ok"])
        self.assertEqual(captured["proxy"], "http://register-proxy")
        self.assertEqual(captured["mail"], full_mail_config)
        self.assertTrue(captured["closed"])
        self.assertEqual(captured["saved_account"][0], "new-web-token")
        self.assertEqual(
            captured["saved_account"][1]["source_type"],
            "gptfree",
        )

    def test_fixed_cloudflare_mailbox_reuse_blocks_concurrency_and_releases(self) -> None:
        entry = {
            "api_base": "https://mail.example",
            "admin_password": "password",
            "domain": ["mail.example"],
            "fixed_address": "fixed@mail.example",
        }
        first = CloudflareTempMailProvider(entry, _mail_conf())
        second = CloudflareTempMailProvider(entry, _mail_conf())
        first_mailbox: dict = {}
        second_mailbox: dict = {}
        try:
            with patch.object(
                first,
                "get_existing_mailbox",
                return_value={
                    "provider": first.name,
                    "address": "fixed@mail.example",
                    "token": "jwt-one",
                },
            ):
                first_mailbox = first.create_mailbox()

            with self.assertRaisesRegex(RuntimeError, "正在被其他注册任务使用"):
                second.create_mailbox()

            mail_provider.release_mailbox(first_mailbox)
            with patch.object(
                second,
                "get_existing_mailbox",
                return_value={
                    "provider": second.name,
                    "address": "fixed@mail.example",
                    "token": "jwt-two",
                },
            ):
                second_mailbox = second.create_mailbox()
            self.assertEqual(second_mailbox["token"], "jwt-two")
        finally:
            mail_provider.release_mailbox(first_mailbox)
            mail_provider.release_mailbox(second_mailbox)
            first.close()
            second.close()

    def test_fixed_cloudflare_mailbox_is_created_exactly_when_missing(self) -> None:
        provider = CloudflareTempMailProvider(
            {
                "api_base": "https://mail.example",
                "admin_password": "password",
                "domain": ["mail.example"],
                "fixed_address": "fixed@mail.example",
            },
            _mail_conf(),
        )
        requests: list[dict] = []
        mailbox: dict = {}

        def missing(_email: str) -> dict:
            provider._last_status_code = 404
            raise RuntimeError("not found")

        def request(method, path, **kwargs) -> dict:
            requests.append({"method": method, "path": path, **kwargs})
            return {"address": "fixed@mail.example", "jwt": "jwt-created"}

        try:
            with (
                patch.object(provider, "get_existing_mailbox", side_effect=missing),
                patch.object(provider, "_request", side_effect=request),
            ):
                mailbox = provider.create_mailbox()

            self.assertEqual(mailbox["token"], "jwt-created")
            self.assertEqual(requests[0]["path"], "/admin/new_address")
            self.assertEqual(
                requests[0]["payload"],
                {
                    "enablePrefix": False,
                    "name": "fixed",
                    "domain": "mail.example",
                },
            )
        finally:
            mail_provider.release_mailbox(mailbox)
            provider.close()

    def test_model_list_exposes_gptfree_without_changing_image_models(self) -> None:
        with patch.object(openai_v1_models, "OpenAIBackendAPI") as backend:
            backend.return_value.list_models.return_value = {
                "object": "list",
                "data": [],
            }
            result = openai_v1_models.list_models()

        model_ids = {item["id"] for item in result["data"]}
        self.assertTrue(
            {
                "gptfree",
                "gptfree/gpt-5.6-sol",
                "gptfree/gpt-5.6-luna",
                "gptfree/gpt-5.6-terra",
            }.issubset(model_ids)
        )
        self.assertIn("gpt-image-2", model_ids)
        self.assertIn("grok-imagine-image", model_ids)

    def test_model_fallback_source_includes_all_gptfree_models(self) -> None:
        self.assertTrue(
            {
                "gptfree",
                "gptfree/gpt-5.6-sol",
                "gptfree/gpt-5.6-luna",
                "gptfree/gpt-5.6-terra",
            }.issubset(set(openai_v1_models.DYNAMIC_MODEL_IDS))
        )


if __name__ == "__main__":
    unittest.main()

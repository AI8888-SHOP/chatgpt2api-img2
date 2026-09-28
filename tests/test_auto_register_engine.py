from __future__ import annotations

import unittest
from unittest.mock import patch

from services import register_service as register_service_module


class AutoRegisterEngineTests(unittest.TestCase):
    def test_auto_register_uses_reference_engine_with_shared_config(self) -> None:
        shared_config = {
            "mail": {"providers": [{"type": "cloudflare_temp_email"}]},
            "proxy": "http://proxy.example:8080",
            "threads": 3,
        }
        expected = {"enabled": True, "target_quota": 250}

        with (
            patch.object(
                register_service_module.register_service,
                "shared_config_snapshot",
                return_value=shared_config,
            ),
            patch.object(
                register_service_module.new_register_service,
                "ensure_min_quota",
                return_value=expected,
            ) as ensure_reference,
            patch.object(register_service_module.register_service, "ensure_min_quota") as ensure_legacy,
        ):
            result = register_service_module.ensure_auto_register_min_quota(250)

        self.assertEqual(result, expected)
        ensure_reference.assert_called_once_with(250, updates=shared_config)
        ensure_legacy.assert_not_called()


if __name__ == "__main__":
    unittest.main()

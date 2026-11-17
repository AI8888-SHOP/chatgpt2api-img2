import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from services.config import ConfigStore
from services import api
from services.user_service import UserService


class GenerationPricesTests(unittest.TestCase):
    def test_independent_model_prices_and_public_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = ConfigStore(root / "config.json")
            users = UserService(root / "users.db")
            user = users.create_user("models@example.test", "password123", quota=100)
            config.update({**config.get(), "image_generate_price": 4, "image_edit_price": 4,
                "image_models": [{"id": "a", "generate_price": 3, "edit_price": 7}, {"id": "b", "generate_price": 9}, {"id": "c"}], "default_image_model": "a"})
            public = config.get_public_image_models()
            self.assertEqual([m["generate_price"] for m in public], [3, 9, 4])
            self.assertEqual([m["edit_price"] for m in public], [7, 4, 4])
            with patch.object(api, "config", config), patch.object(api, "user_service", users):
                for model, action, price in [("a", "image_generate", 3), ("a", "image_edit", 7), ("b", "image_generate", 9), ("c", "image_generate", 4)]:
                    reservation = api.reserve_user_quota(user, 2, action=action, model=model)
                    self.assertEqual(reservation["amount"], price * 2)
                    api.refund_user_quota_reservation(reservation, action=action, model=model)
            with self.assertRaises(ValueError):
                config.update({**config.get(), "image_models": [{"id": "a", "generate_price": 0}]})

    def test_image_price_snapshot_partial_result_and_refund(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = ConfigStore(root / "config.json")
            users = UserService(root / "users.db")
            user = users.create_user("price@example.test", "password123", quota=100)
            config.update({**config.get(), "image_generate_price": 3, "image_edit_price": 7})
            with patch.object(api, "config", config), patch.object(api, "user_service", users):
                reservation = api.reserve_user_quota(user, 2, action="image_edit", model="test")
                self.assertEqual(reservation["amount"], 14)
                config.update({**config.get(), "image_edit_price": 9})
                self.assertEqual(api.settle_user_quota_reservation(reservation, 1, action="image_edit", model="test"), 7)
                self.assertEqual(users.get_user(user.id).quota, 93)
                reservation = api.reserve_user_quota(user, 2, action="image_generate", model="test")
                self.assertEqual(reservation["amount"], 6)
                api.refund_user_quota_reservation(reservation, action="image_generate", model="test")
                self.assertEqual(users.get_user(user.id).quota, 93)
            for invalid in [0, -1, True, 1.5, 10001]:
                with self.assertRaises(ValueError):
                    config.update({**config.get(), "image_generate_price": invalid})

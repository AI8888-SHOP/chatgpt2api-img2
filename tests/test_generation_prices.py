import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from services.config import ConfigStore
from services import api
from services.user_service import UserService


class GenerationPricesTests(unittest.TestCase):
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

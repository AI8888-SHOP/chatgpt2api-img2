import tempfile
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from services.user_service import UserService


class PersonalPromptTests(unittest.TestCase):
    def test_limit_is_atomic_private_and_durable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "users.db"
            service = UserService(path)
            user = service.create_user("one@example.test", "password123")
            other = service.create_user("two@example.test", "password123")
            def create(index):
                try:
                    return UserService(path).save_prompt_preset(user.id, str(index), "内容")
                except ValueError:
                    return None
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(create, range(25)))
            self.assertEqual(sum(item is not None for item in results), 15)
            service = UserService(path)
            items = service.list_prompt_presets(user.id)
            self.assertEqual(len(items), 15)
            self.assertEqual(service.list_prompt_presets(other.id), [])
            with self.assertRaises(KeyError):
                service.save_prompt_preset(other.id, "修改", "内容", items[0]["id"])
            self.assertFalse(service.delete_prompt_preset(other.id, items[0]["id"]))
            changed = service.save_prompt_preset(user.id, "修改", "新内容", items[0]["id"])
            self.assertEqual(changed["content"], "新内容")
            self.assertTrue(service.delete_prompt_preset(user.id, items[0]["id"]))
            service.save_prompt_preset(user.id, "补充", "内容")
            self.assertEqual(len(service.list_prompt_presets(user.id)), 15)
            for label, content in [("", "a"), ("a", ""), ("a" * 61, "b"), ("a", "b" * 8001)]:
                with self.assertRaises(ValueError):
                    service.save_prompt_preset(other.id, label, content)

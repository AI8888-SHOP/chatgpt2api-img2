import tempfile
import unittest
from pathlib import Path

from services.user_service import UserService


class ImageThreadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = UserService(Path(self.temp.name) / "users.db")
        with self.service._connect() as conn:
            conn.execute(
                "INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, '', 0, 0)",
                ("test-user", "test@example.com"),
            )

    def test_rounds_remain_grouped_after_database_reload(self):
        for index in range(3):
            self.service.save_image_conversation("test-user", {
                "id": f"round-{index}", "threadId": "round-0",
                "prompt": f"Prompt {index}", "createdAt": f"2026-01-01T00:00:0{index}Z",
                "images": [{"id": f"image-{index}", "url": f"https://example.com/{index}.png"}],
            })
        restored = UserService(self.service.db_file).list_image_conversations("test-user")["items"]
        self.assertEqual(len(restored), 3)
        self.assertEqual({item["threadId"] for item in restored}, {"round-0"})
        self.assertEqual({item["prompt"] for item in restored}, {"Prompt 0", "Prompt 1", "Prompt 2"})
        self.assertEqual(len({item["images"][0]["id"] for item in restored}), 3)

    def test_legacy_conversation_still_saves_without_thread(self):
        saved = self.service.save_image_conversation("test-user", {"id": "legacy", "prompt": "Original"})
        self.assertNotIn("threadId", saved)
        self.assertEqual(saved["prompt"], "Original")

    def test_invalid_thread_identifier_is_rejected(self):
        with self.assertRaises(ValueError):
            self.service.save_image_conversation("test-user", {"id": "round", "threadId": "x" * 129})


if __name__ == "__main__":
    unittest.main()

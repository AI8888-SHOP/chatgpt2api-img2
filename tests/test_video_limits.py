import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from fastapi import HTTPException
from services.video_service import VideoRequest
from tests import test_video_service as fixtures


class VideoLimitTests(unittest.TestCase):
    def setUp(self):
        fixtures.VideoTests.setUp(self)
        self.user = self.users.create_user("limit@example.test", "password123", quota=1000)

    row = fixtures.VideoTests.row
    tick = fixtures.VideoTests.tick

    def create(self, index):
        return self.service.create(self.user, VideoRequest(prompt="synthetic", client_request_id=f"limit-test-{index}"))

    def seed_active(self, count):
        with self.service.connect() as db:
            db.executemany("INSERT INTO video_jobs(id,owner,created,state,payload,channel,upstream_name,amount) VALUES(?,?,?,'pending','{}','synthetic','synthetic',5)",
                           [(f"seed-{i}", f"other-{i // 20}", time.time()-120) for i in range(count)])

    def test_twenty_active_jobs_unknown_occupies_slot_and_replay_does_not_charge(self):
        jobs = [self.create(i) for i in range(20)]
        self.service.update(jobs[0]["id"], state="unknown")
        with self.assertRaises(HTTPException) as rejected:
            self.create(20)
        self.assertEqual(rejected.exception.status_code, 429)
        self.assertIn("20", rejected.exception.detail)
        self.assertEqual(self.create(0)["id"], jobs[0]["id"])
        self.assertEqual(self.users.get_user(self.user.id).quota, 900)
        self.service.update(jobs[0]["id"], state="failed")
        self.tick(jobs[0]["id"])
        self.create(20)
        listing = self.service.list(self.user.id, limit=1)
        self.assertEqual(len(listing["items"]), 1)
        self.assertEqual(listing["active_count"], 20)
        self.assertEqual(listing["limits"], {"user_concurrency": 20, "requests_per_minute": 50, "global_concurrency": 500})
        self.assertEqual(self.service.list("other-owner")["active_count"], 0)

    def test_fifty_per_rolling_minute_includes_failed_jobs_and_replay_is_free(self):
        now = time.time()
        with patch("services.video_service.time.time", return_value=now):
            jobs = []
            for i in range(50):
                job = self.create(i)
                jobs.append(job)
                self.service.update(job["id"], state="failed")
                self.tick(job["id"])
            self.assertEqual(self.create(0)["id"], jobs[0]["id"])
            with self.assertRaises(HTTPException) as rejected:
                self.create(50)
            self.assertEqual(rejected.exception.status_code, 429)
            self.assertIn("50", rejected.exception.detail)
            self.assertEqual(self.users.get_user(self.user.id).quota, 1000)
        with patch("services.video_service.time.time", return_value=now+59.9):
            with self.assertRaises(HTTPException):
                self.create(50)
        with patch("services.video_service.time.time", return_value=now+60.1):
            self.create(50)
        self.assertEqual(self.users.get_user(self.user.id).quota, 995)
        with self.users._connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM user_quota_reservations").fetchone()[0], 51)

    def test_global_five_hundred_last_slot_is_atomic_across_users(self):
        self.seed_active(499)
        contenders = [self.users.create_user(f"race-{i}@example.test", "password123", quota=100) for i in range(6)]
        self.assert_race(contenders, expected_total=500)

    def test_user_twenty_last_slot_is_atomic(self):
        for i in range(19):
            self.create(i)
        self.assert_race([self.user] * 6, expected_total=20)
        self.assertEqual(self.users.get_user(self.user.id).quota, 900)

    def assert_race(self, users, expected_total):
        barrier = Barrier(len(users))
        original = self.service.prepare_payload

        def prepare(*args):
            payload = original(*args)
            barrier.wait(timeout=10)
            return payload

        def submit(pair):
            i, user = pair
            try:
                return self.service.create(user, VideoRequest(prompt="synthetic race", client_request_id=f"race-test-{i}"))
            except HTTPException as exc:
                return exc.status_code

        with patch.object(self.service, "prepare_payload", side_effect=prepare), ThreadPoolExecutor(max_workers=len(users)) as pool:
            outcomes = list(pool.map(submit, enumerate(users)))
        self.assertEqual(sum(isinstance(item, dict) for item in outcomes), 1)
        self.assertEqual(outcomes.count(429), len(users)-1)
        with self.service.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM video_jobs").fetchone()[0], expected_total)
        with self.users._connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM user_quota_reservations").fetchone()[0], 1 if expected_total == 500 else 20)

    def test_active_count_includes_old_jobs_outside_history_page(self):
        old = self.create(0)
        self.service.update(old["id"], created=time.time()-120, state="unknown")
        for i in range(1, 51):
            job = self.create(i)
            self.service.update(job["id"], state="failed")
            self.tick(job["id"])
        listing = self.service.list(self.user.id)
        self.assertEqual(len(listing["items"]), 50)
        self.assertNotIn(old["id"], [item["id"] for item in listing["items"]])
        self.assertEqual(listing["active_count"], 1)

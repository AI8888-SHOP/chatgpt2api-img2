import tempfile
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from services.user_service import UserService
from services.ui_trial_service import get_trial, update_trial, trial_stats


class UiTrialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = UserService(Path(self.temp.name) / 'users.db')
        with self.service._connect() as conn:
            for uid in ('one', 'two'):
                conn.execute("INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES (?,?,'',0,0)", (uid, uid + '@example.com'))

    def test_assignment_is_stable_and_does_not_count_unseen_user(self):
        first = get_trial(self.service, 'one')
        self.assertEqual(first, get_trial(UserService(self.service.db_file), 'one'))
        self.assertEqual(trial_stats(self.service)['participants'], 0)
        self.assertFalse(first['seen_a'])

    def test_switch_vote_replace_withdraw_and_user_isolation(self):
        with self.assertRaises(ValueError):
            update_trial(self.service, 'one', preference='a', update_preference=True)
        for variant in ('a', 'b', 'b'):
            update_trial(self.service, 'one', variant=variant)
        update_trial(self.service, 'two', variant='a')
        for preference in ('a', 'b', 'b'):
            update_trial(self.service, 'one', preference=preference, update_preference=True)
        stats = trial_stats(self.service)
        self.assertEqual(stats['participants'], 2)
        self.assertEqual(stats['tried_both'], 1)
        self.assertEqual(stats['votes'], {'a': 0, 'b': 1, 'equal': 0})
        self.assertEqual(get_trial(self.service, 'two')['variant'], 'a')
        self.assertIsNone(get_trial(self.service, 'two')['preference'])
        update_trial(self.service, 'one', preference=None, update_preference=True)
        self.assertEqual(trial_stats(self.service)['votes']['b'], 0)
        self.assertEqual(trial_stats(self.service)['not_voted'], 2)

    def test_repeated_and_concurrent_events_do_not_inflate_users_or_votes(self):
        update_trial(self.service, 'one', variant='a')
        update_trial(self.service, 'one', variant='b')
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: update_trial(self.service, 'one', preference='a', update_preference=True), range(30)))
        stats = trial_stats(self.service)
        self.assertEqual(stats['participants'], 1)
        self.assertEqual(stats['votes']['a'], 1)

    def test_invalid_values_rejected_and_foreign_key_cleanup(self):
        for variant in ('x', '', 'A'):
            with self.assertRaises(ValueError): update_trial(self.service, 'one', variant=variant)
        update_trial(self.service, 'one', variant='a')
        with self.service._connect() as conn:
            conn.execute("DELETE FROM users WHERE id='one'")
        self.assertEqual(trial_stats(self.service)['participants'], 0)

    def test_stats_exclude_inactive_from_recent_but_keep_votes(self):
        for variant in ('a', 'b'): update_trial(self.service, 'one', variant=variant)
        update_trial(self.service, 'one', preference='equal', update_preference=True)
        with self.service._connect() as conn: conn.execute('UPDATE user_ui_trial SET last_seen=1')
        stats = trial_stats(self.service)
        self.assertEqual(stats['active_users'], 0)
        self.assertEqual(stats['votes']['equal'], 1)
        self.assertEqual(stats['participants'], 1)


if __name__ == '__main__':
    unittest.main()

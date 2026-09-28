import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient

os.environ.setdefault('CHATGPT2API_AUTH_KEY', 'test-admin')
from services import api as api_module
from services.user_service import UserService


class UiTrialEndpointTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.service = UserService(Path(temp.name) / 'users.db')
        self.user = self.service.create_user('one@example.com', 'test-pass', quota=10)
        self.service.create_user('two@example.com', 'test-pass', quota=20)
        token, _ = self.service.login('one@example.com', 'test-pass')
        second, _ = self.service.login('two@example.com', 'test-pass')
        self.headers = {'Authorization': 'Bearer ' + token}
        self.second = {'Authorization': 'Bearer ' + second}
        for mock in (patch.object(api_module, 'user_service', self.service), patch.object(api_module, 'init_default_admin_key')):
            mock.start(); self.addCleanup(mock.stop)
        self.client = TestClient(api_module.create_app())
        self.addCleanup(self.client.close)

    def test_real_session_required_and_admin_stats_are_private(self):
        key, _ = self.service.create_api_key(self.user.id, 'test')
        for token, status in (('', 403), ('usr_invalid', 401), (key, 403), (api_module.config.auth_key, 403)):
            headers = {'Authorization': 'Bearer ' + token}
            self.assertEqual(self.client.get('/v1/user/ui-trial', headers=headers).status_code, status)
            self.assertEqual(self.client.post('/v1/user/ui-trial', headers=headers, json={'variant': 'a'}).status_code, status)
        self.assertEqual(self.client.get('/api/ui-trial/stats', headers=self.headers).status_code, 401)
        self.assertEqual(self.client.get('/api/ui-trial/stats').status_code, 401)

    def test_vote_overwrite_reload_rotation_and_isolation(self):
        initial = self.client.get('/v1/user/ui-trial', headers=self.headers).json()
        self.assertEqual(self.client.post('/v1/user/ui-trial', headers=self.headers, json={'preference': 'a'}).status_code, 400)
        for variant in ('a', 'b'):
            self.assertEqual(self.client.post('/v1/user/ui-trial', headers=self.headers, json={'variant': variant}).status_code, 200)
        for vote in ('a', 'b', 'b'):
            self.assertEqual(self.client.post('/v1/user/ui-trial', headers=self.headers, json={'preference': vote}).status_code, 200)
        token, _ = self.service.login('one@example.com', 'test-pass')
        restored = self.client.get('/v1/user/ui-trial', headers={'Authorization': 'Bearer ' + token}).json()
        self.assertEqual(restored['assigned_variant'], initial['assigned_variant'])
        self.assertEqual(restored['variant'], 'b')
        self.assertEqual(restored['preference'], 'b')
        other = self.client.get('/v1/user/ui-trial', headers=self.second).json()
        self.assertFalse(other['seen_a']); self.assertIsNone(other['preference'])
        stats = self.client.get('/api/ui-trial/stats', headers={'Authorization': 'Bearer ' + api_module.config.auth_key}).json()
        self.assertEqual(stats['votes'], {'a': 0, 'b': 1, 'equal': 0})
        self.assertNotIn('one@example.com', str(stats)); self.assertNotIn(self.user.id, str(stats))
        self.assertEqual(self.service.get_by_token(token).remaining(), 10)

    def test_payload_cannot_impersonate_user_or_write_unknown_fields(self):
        for body in ({'user_id': 'another', 'variant': 'a'}, {'variant': 'c'}, {'preference': 3}, {'prompt': 'private'}):
            self.assertEqual(self.client.post('/v1/user/ui-trial', headers=self.headers, json=body).status_code, 422)


if __name__ == '__main__': unittest.main()

import unittest

from github_sync_client import generate_remote_submission_id, generate_submission_fingerprint
from github_sync_common import stable_json_bytes
from github_sync_server import submission_fingerprint_from_payload


class GitHubSyncBridgeTest(unittest.TestCase):
    def test_submission_fingerprint_is_stable(self):
        first = generate_submission_fingerprint(
            username="alice",
            created_at="2026-04-09T20:00:00+00:00",
            date_key="2026-04-09",
            duration_minutes=45,
            note="函数专项",
            evidence_hash="abc123",
        )
        second = generate_submission_fingerprint(
            username="alice",
            created_at="2026-04-09T20:00:00+00:00",
            date_key="2026-04-09",
            duration_minutes=45,
            note="函数专项",
            evidence_hash="abc123",
        )
        changed = generate_submission_fingerprint(
            username="alice",
            created_at="2026-04-09T20:00:00+00:00",
            date_key="2026-04-09",
            duration_minutes=46,
            note="函数专项",
            evidence_hash="abc123",
        )
        self.assertEqual(first, second)
        self.assertNotEqual(first, changed)

    def test_remote_submission_id_is_deterministic(self):
        fingerprint = "abcdef1234567890"
        first = generate_remote_submission_id("alice", "2026-04-09T20:00:00+00:00", fingerprint)
        second = generate_remote_submission_id("alice", "2026-04-09T20:00:00+00:00", fingerprint)
        self.assertEqual(first, second)
        self.assertIn("alice-", first)
        self.assertTrue(first.endswith(fingerprint[:10]))

    def test_server_uses_payload_fingerprint_when_present(self):
        payload = {"submission_fingerprint": "hello123"}
        self.assertEqual(submission_fingerprint_from_payload(payload), "hello123")

    def test_stable_json_bytes_ignore_key_order(self):
        left = stable_json_bytes({"b": 2, "a": 1})
        right = stable_json_bytes({"a": 1, "b": 2})
        self.assertEqual(left, right)


if __name__ == "__main__":
    unittest.main()

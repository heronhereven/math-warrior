import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

from server import MathQuestApp


class HttpClient:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.cookie = None

    def request(self, method: str, path: str, payload=None):
        headers = {}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(body))
        if self.cookie:
            headers["Cookie"] = self.cookie

        conn = http.client.HTTPConnection(self.host, self.port, timeout=10)
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        set_cookie = response.getheader("Set-Cookie")
        if set_cookie:
            self.cookie = set_cookie.split(";", 1)[0]
        content_type = response.getheader("Content-Type") or ""
        data = json.loads(raw.decode("utf-8")) if "application/json" in content_type else raw.decode("utf-8")
        conn.close()
        return response.status, data


class MathQuestServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo_root = Path(__file__).resolve().parents[1]
        handle, temp_name = tempfile.mkstemp(prefix="test-runtime-", suffix=".db", dir=cls.repo_root)
        os.close(handle)
        Path(temp_name).unlink(missing_ok=True)
        cls.db_path = Path(temp_name)
        cls.app = MathQuestApp(
            db_path=cls.db_path,
            static_dir=cls.repo_root,
            admin_username="admin",
            admin_password="admin123456",
            host="127.0.0.1",
            port=0,
        )
        cls.server = cls.app.create_server()
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        for suffix in ("", "-shm", "-wal"):
            try:
                Path(f"{cls.db_path}{suffix}").unlink(missing_ok=True)
            except PermissionError:
                pass

    def test_register_login_and_save_state(self):
        client = HttpClient("127.0.0.1", self.port)
        status, page = client.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("/app-client.js", page)
        self.assertIn("/app-extra.css", page)

        status, data = client.request(
            "POST",
            "/api/auth/register",
            {"username": "alice01", "display_name": "Alice", "password": "secret123"},
        )
        self.assertEqual(status, 201)
        self.assertEqual(data["user"]["username"], "alice01")

        status, data = client.request("GET", "/api/me")
        self.assertEqual(status, 200)
        self.assertFalse(data["user"]["is_admin"])

        sample_state = {
            "history": {
                "2026-04-09": {
                    "segments": [{"s": 0, "e": 180}],
                    "tasks": {"correction": True, "difficulty": True, "review": True},
                    "journal": {"top": "函数题", "stuck": "导数", "feel": "还行", "difficulty": 3, "focus": 4, "effort": 5},
                    "mood": 4,
                    "energy": 3,
                    "xpEarned": 9999,
                    "rewardShown": False,
                }
            },
            "streak": 1,
            "lastDate": "2026-04-09",
        }

        status, data = client.request("PUT", "/api/state", {"state": sample_state})
        self.assertEqual(status, 200)
        self.assertEqual(data["state"]["totalXp"], 0)
        self.assertEqual(data["state"]["history"]["2026-04-09"]["status"]["approvedMinutes"], 0)

        status, data = client.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(data["state"]["history"]["2026-04-09"]["journal"]["top"], "函数题")
        self.assertEqual(data["state"]["totalXp"], 0)

        status, data = client.request(
            "POST",
            "/api/submissions",
            {
                "date_key": "2026-04-09",
                "duration_minutes": 120,
                "note": "今天先把目标时长送上去",
                "evidence_name": "proof.txt",
                "evidence_data": "data:text/plain;base64,SGVsbG8gTWF0aCBRdWVzdA==",
            },
        )
        self.assertEqual(status, 201)

        status, data = client.request("POST", "/api/checkin", {"date_key": "2026-04-09"})
        self.assertEqual(status, 200)
        self.assertTrue(data["checkin"]["stamped"])
        self.assertEqual(data["state"]["history"]["2026-04-09"]["checkin"]["rewardXp"], 0)
        self.assertEqual(data["state"]["history"]["2026-04-09"]["status"]["rewardState"], "pending")

        status, data = client.request(
            "PUT",
            "/api/me",
            {"display_name": "Alice Hero", "current_password": "secret123", "new_password": "secret456"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["user"]["display_name"], "Alice Hero")

        status, data = client.request("GET", "/api/admin/users")
        self.assertEqual(status, 403)
        self.assertEqual(data["error"], "需要管理员权限")

    def test_admin_can_view_all_users(self):
        user_client = HttpClient("127.0.0.1", self.port)
        status, _ = user_client.request(
            "POST",
            "/api/auth/register",
            {"username": "bob02", "display_name": "Bob", "password": "secret123"},
        )
        self.assertEqual(status, 201)

        status, _ = user_client.request(
            "PUT",
            "/api/state",
            {
                "state": {
                    "history": {
                        "2026-04-08": {
                            "segments": [{"s": 0, "e": 240}],
                            "tasks": {"correction": True, "difficulty": True, "review": True},
                            "journal": {"top": "几何", "stuck": "", "feel": "", "difficulty": 2, "focus": 3, "effort": 4},
                            "mood": 5,
                            "energy": 4,
                            "xpEarned": 6000,
                            "rewardShown": False,
                        }
                    },
                    "streak": 2,
                    "lastDate": "2026-04-08",
                }
            },
        )
        self.assertEqual(status, 200)

        admin = HttpClient("127.0.0.1", self.port)
        status, data = admin.request(
            "POST",
            "/api/auth/login",
            {"username": "admin", "password": "admin123456"},
        )
        self.assertEqual(status, 200)
        self.assertTrue(data["user"]["is_admin"])

        status, data = admin.request("GET", "/api/admin/users")
        self.assertEqual(status, 200)
        users = {item["user"]["username"]: item for item in data["users"]}
        self.assertIn("bob02", users)
        self.assertEqual(users["bob02"]["summary"]["totalXp"], 0)
        self.assertIsNone(users["bob02"]["summary"]["lastActiveDate"])

        bob_id = users["bob02"]["user"]["id"]
        status, data = admin.request("GET", f"/api/admin/users/{bob_id}")
        self.assertEqual(status, 200)
        self.assertEqual(data["user"]["username"], "bob02")
        self.assertEqual(data["summary"]["totalXp"], 0)
        self.assertEqual(data["state"]["history"]["2026-04-08"]["journal"]["top"], "几何")

        status, _ = user_client.request(
            "POST",
            "/api/submissions",
            {
                "date_key": "2026-04-08",
                "duration_minutes": 180,
                "note": "周末目标时长提交",
                "evidence_name": "proof.txt",
                "evidence_data": "data:text/plain;base64,SGVsbG8gTWF0aCBRdWVzdA==",
            },
        )
        self.assertEqual(status, 201)

        status, data = user_client.request("POST", "/api/checkin", {"date_key": "2026-04-08"})
        self.assertEqual(status, 200)
        self.assertTrue(data["checkin"]["stamped"])
        self.assertEqual(data["checkin"]["rewardXp"], 0)

        status, data = user_client.request(
            "POST",
            "/api/submissions",
            {
                "date_key": "2026-04-09",
                "duration_minutes": 75,
                "note": "函数专项练习",
                "evidence_name": "proof.txt",
                "evidence_data": "data:text/plain;base64,SGVsbG8gTWF0aCBRdWVzdA==",
            },
        )
        self.assertEqual(status, 201)
        submission_id = data["submission"]["id"]
        self.assertEqual(data["submission"]["status"], "pending")

        status, data = admin.request(
            "POST",
            f"/api/admin/submissions/{submission_id}/review",
            {"action": "approve", "admin_note": "做得不错"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["submission"]["status"], "approved")

        status, data = user_client.request("GET", "/api/submissions/mine")
        self.assertEqual(status, 200)
        self.assertEqual(data["submissions"][0]["status"], "approved")

        status, data = user_client.request("GET", "/api/state")
        self.assertEqual(status, 200)
        approved_segments = data["state"]["history"]["2026-04-09"]["segments"]
        total_minutes = sum(item["e"] - item["s"] for item in approved_segments)
        self.assertEqual(total_minutes, 75)
        self.assertGreater(data["state"]["totalXp"], 0)
        self.assertEqual(data["state"]["history"]["2026-04-08"]["checkin"]["rewardXp"], 0)


if __name__ == "__main__":
    unittest.main()

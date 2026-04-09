import argparse
import hashlib
import json
import mimetypes
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SESSION_COOKIE = "mq_session"
USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{3,24}$")
PASSWORD_MIN_LENGTH = 6
MAX_BODY_BYTES = 2 * 1024 * 1024
PBKDF2_ROUNDS = 120_000
LEVELS = [
    {"level": 1, "name": "新手学徒", "xp": 0},
    {"level": 2, "name": "初级探索者", "xp": 100},
    {"level": 3, "name": "数学战士", "xp": 250},
    {"level": 4, "name": "方程猎人", "xp": 450},
    {"level": 5, "name": "积分法师", "xp": 700},
    {"level": 6, "name": "极限骑士", "xp": 1000},
    {"level": 7, "name": "微积分大师", "xp": 1400},
    {"level": 8, "name": "数学传奇", "xp": 1900},
]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def default_state() -> dict[str, Any]:
    return {"totalXp": 0, "streak": 0, "lastDate": None, "history": {}}


def default_day() -> dict[str, Any]:
    return {
        "segments": [],
        "tasks": {"correction": False, "difficulty": False, "review": False},
        "journal": {"top": "", "stuck": "", "feel": "", "difficulty": 0, "focus": 0, "effort": 0},
        "mood": 0,
        "energy": 0,
        "xpEarned": 0,
        "rewardShown": False,
    }


def clamp_int(value: Any, minimum: int, maximum: int, fallback: int = 0) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


def normalize_segment(raw: Any) -> dict[str, int] | None:
    if not isinstance(raw, dict):
        return None
    start = clamp_int(raw.get("s"), 0, 180, 0)
    end = clamp_int(raw.get("e"), 0, 180, 0)
    if start >= end:
        return None
    return {"s": start, "e": end}


def normalize_day(raw: Any) -> dict[str, Any]:
    base = default_day()
    if not isinstance(raw, dict):
        return base

    segments = []
    for item in raw.get("segments", []):
        segment = normalize_segment(item)
        if segment:
            segments.append(segment)
    base["segments"] = segments

    tasks_raw = raw.get("tasks", {})
    if isinstance(tasks_raw, dict):
        for key in base["tasks"]:
            base["tasks"][key] = bool(tasks_raw.get(key))

    journal_raw = raw.get("journal", {})
    if isinstance(journal_raw, dict):
        for key in ("top", "stuck", "feel"):
            value = journal_raw.get(key, "")
            base["journal"][key] = value if isinstance(value, str) else ""
        for key in ("difficulty", "focus", "effort"):
            base["journal"][key] = clamp_int(journal_raw.get(key), 0, 5, 0)

    base["mood"] = clamp_int(raw.get("mood"), 0, 5, 0)
    base["energy"] = clamp_int(raw.get("energy"), 0, 5, 0)
    base["xpEarned"] = clamp_int(raw.get("xpEarned"), 0, 100000, 0)
    base["rewardShown"] = bool(raw.get("rewardShown"))
    return base


def normalize_state(raw: Any) -> dict[str, Any]:
    base = default_state()
    if not isinstance(raw, dict):
        return base

    base["totalXp"] = clamp_int(raw.get("totalXp"), 0, 10_000_000, 0)
    base["streak"] = clamp_int(raw.get("streak"), 0, 36500, 0)
    last_date = raw.get("lastDate")
    base["lastDate"] = last_date if isinstance(last_date, str) else None

    history_raw = raw.get("history", {})
    if isinstance(history_raw, dict):
        history = {}
        for key, value in history_raw.items():
            if isinstance(key, str) and len(key) <= 32:
                history[key] = normalize_day(value)
        base["history"] = history

    base["totalXp"] = sum(day.get("xpEarned", 0) for day in base["history"].values())
    return base


def compute_level(total_xp: int) -> dict[str, Any]:
    current = LEVELS[0]
    for level in LEVELS:
        if total_xp >= level["xp"]:
            current = level
    return current


def summarize_state(state: dict[str, Any]) -> dict[str, Any]:
    history = state.get("history", {})
    sorted_days = sorted(history.items(), key=lambda item: item[0], reverse=True)
    recent_days = []
    total_minutes = 0

    for date_key, day in sorted_days:
        segments = day.get("segments", [])
        study_minutes = sum(seg["e"] - seg["s"] for seg in segments)
        total_minutes += study_minutes
        task_count = sum(1 for value in day.get("tasks", {}).values() if value)
        recent_days.append(
            {
                "date": date_key,
                "xpEarned": clamp_int(day.get("xpEarned"), 0, 100000, 0),
                "studyMinutes": study_minutes,
                "taskCount": task_count,
                "mood": clamp_int(day.get("mood"), 0, 5, 0),
                "top": day.get("journal", {}).get("top", ""),
                "stuck": day.get("journal", {}).get("stuck", ""),
            }
        )
        if len(recent_days) >= 7:
            break

    total_xp = clamp_int(state.get("totalXp"), 0, 10_000_000, 0)
    return {
        "totalXp": total_xp,
        "streak": clamp_int(state.get("streak"), 0, 36500, 0),
        "level": compute_level(total_xp),
        "daysRecorded": len(history),
        "lastActiveDate": sorted_days[0][0] if sorted_days else None,
        "totalMinutes": total_minutes,
        "recentDays": recent_days,
    }


class MathQuestApp:
    def __init__(
        self,
        db_path: Path,
        static_dir: Path,
        admin_username: str = "admin",
        admin_password: str = "admin123456",
        host: str = "127.0.0.1",
        port: int = 8000,
    ) -> None:
        self.db_path = Path(db_path)
        self.static_dir = Path(static_dir)
        self.index_path = self.static_dir / "index.html"
        self.host = host
        self.port = port
        self.admin_username = admin_username
        self.admin_password = admin_password
        self._init_db()
        self._ensure_admin_user()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        return conn

    def _init_db(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL,
                    password_salt TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    is_admin INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    last_login_at TEXT
                );

                CREATE TABLE IF NOT EXISTS user_states (
                    user_id INTEGER PRIMARY KEY,
                    state_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                """
            )

    def _hash_password(self, password: str, salt_hex: str | None = None) -> tuple[str, str]:
        salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
        derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
        return salt.hex(), derived.hex()

    def _verify_password(self, password: str, salt_hex: str, expected_hash: str) -> bool:
        _, actual_hash = self._hash_password(password, salt_hex)
        return secrets.compare_digest(actual_hash, expected_hash)

    def _ensure_admin_user(self) -> None:
        with self._connect() as conn:
            row = conn.execute("SELECT id FROM users WHERE username = ?", (self.admin_username,)).fetchone()
            if row:
                return

            salt_hex, password_hash = self._hash_password(self.admin_password)
            now = utc_now_iso()
            cur = conn.execute(
                """
                INSERT INTO users (username, display_name, password_salt, password_hash, is_admin, created_at)
                VALUES (?, ?, ?, ?, 1, ?)
                """,
                (self.admin_username, "管理员", salt_hex, password_hash, now),
            )
            user_id = cur.lastrowid
            conn.execute(
                "INSERT INTO user_states (user_id, state_json, updated_at) VALUES (?, ?, ?)",
                (user_id, json.dumps(default_state(), ensure_ascii=False), now),
            )

    def _public_user(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "is_admin": bool(row["is_admin"]),
            "created_at": row["created_at"],
            "last_login_at": row["last_login_at"],
        }

    def _parse_cookie(self, handler: BaseHTTPRequestHandler) -> SimpleCookie[str]:
        cookie = SimpleCookie()
        raw = handler.headers.get("Cookie")
        if raw:
            cookie.load(raw)
        return cookie

    def _set_session_cookie(self, handler: BaseHTTPRequestHandler, token: str) -> None:
        cookie = SimpleCookie()
        cookie[SESSION_COOKIE] = token
        cookie[SESSION_COOKIE]["path"] = "/"
        cookie[SESSION_COOKIE]["httponly"] = True
        cookie[SESSION_COOKIE]["samesite"] = "Lax"
        handler.send_header("Set-Cookie", cookie.output(header="").strip())

    def _clear_session_cookie(self, handler: BaseHTTPRequestHandler) -> None:
        cookie = SimpleCookie()
        cookie[SESSION_COOKIE] = ""
        cookie[SESSION_COOKIE]["path"] = "/"
        cookie[SESSION_COOKIE]["expires"] = "Thu, 01 Jan 1970 00:00:00 GMT"
        cookie[SESSION_COOKIE]["httponly"] = True
        cookie[SESSION_COOKIE]["samesite"] = "Lax"
        handler.send_header("Set-Cookie", cookie.output(header="").strip())

    def _create_session(self, conn: sqlite3.Connection, user_id: int) -> str:
        token = secrets.token_hex(32)
        now = utc_now_iso()
        expires = (utc_now() + timedelta(days=7)).isoformat()
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, now, expires),
        )
        conn.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now, user_id))
        return token

    def _delete_session(self, conn: sqlite3.Connection, token: str) -> None:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))

    def _auth_user(self, handler: BaseHTTPRequestHandler) -> sqlite3.Row | None:
        cookie = self._parse_cookie(handler)
        morsel = cookie.get(SESSION_COOKIE)
        if not morsel:
            return None

        token = morsel.value
        now = utc_now_iso()
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT users.*
                FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token = ? AND sessions.expires_at > ?
                """,
                (token, now),
            ).fetchone()
            if row is None:
                conn.execute("DELETE FROM sessions WHERE token = ? OR expires_at <= ?", (token, now))
            return row

    def _read_json(self, handler: BaseHTTPRequestHandler) -> dict[str, Any]:
        try:
            length = int(handler.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("无效的请求体长度") from exc

        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("请求体过大")

        raw = handler.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("请求体不是合法 JSON") from exc
        if not isinstance(parsed, dict):
            raise ValueError("JSON 根对象必须是对象")
        return parsed

    def _load_user_state(self, conn: sqlite3.Connection, user_id: int) -> dict[str, Any]:
        row = conn.execute("SELECT state_json FROM user_states WHERE user_id = ?", (user_id,)).fetchone()
        if row is None:
            state = default_state()
            conn.execute(
                "INSERT INTO user_states (user_id, state_json, updated_at) VALUES (?, ?, ?)",
                (user_id, json.dumps(state, ensure_ascii=False), utc_now_iso()),
            )
            return state
        try:
            return normalize_state(json.loads(row["state_json"]))
        except json.JSONDecodeError:
            return default_state()

    def _save_user_state(self, conn: sqlite3.Connection, user_id: int, state: dict[str, Any]) -> dict[str, Any]:
        normalized = normalize_state(state)
        now = utc_now_iso()
        payload = json.dumps(normalized, ensure_ascii=False)
        conn.execute(
            """
            INSERT INTO user_states (user_id, state_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
            """,
            (user_id, payload, now),
        )
        return normalized

    def _validate_registration(self, body: dict[str, Any]) -> tuple[str, str, str]:
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        display_name = str(body.get("display_name", "")).strip()

        if not USERNAME_RE.fullmatch(username):
            raise ValueError("用户名需为 3-24 位字母、数字、下划线或减号")
        if len(password) < PASSWORD_MIN_LENGTH:
            raise ValueError(f"密码至少 {PASSWORD_MIN_LENGTH} 位")
        if not display_name:
            display_name = username
        if len(display_name) > 32:
            raise ValueError("昵称最长 32 个字符")
        return username, password, display_name

    def _serve_injected_index(self, handler: BaseHTTPRequestHandler) -> None:
        if not self.index_path.exists():
            self._send_json(handler, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "找不到前端页面"})
            return

        html = self.index_path.read_text(encoding="utf-8")
        if 'href="/app-extra.css"' not in html:
            html = html.replace("</head>", '\n<link rel="stylesheet" href="/app-extra.css">\n</head>', 1)
        if 'src="/app-client.js"' not in html:
            html = html.replace("</body>", '\n<script src="/app-client.js"></script>\n</body>', 1)

        data = html.encode("utf-8")
        handler.send_response(HTTPStatus.OK)
        handler.send_header("Content-Type", "text/html; charset=utf-8")
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    def _serve_static_file(self, handler: BaseHTTPRequestHandler, relative_path: str) -> None:
        candidate = (self.static_dir / relative_path.lstrip("/")).resolve()
        root = self.static_dir.resolve()
        if root not in candidate.parents and candidate != root:
            self._send_json(handler, HTTPStatus.NOT_FOUND, {"error": "文件不存在"})
            return
        if not candidate.exists() or not candidate.is_file():
            self._send_json(handler, HTTPStatus.NOT_FOUND, {"error": "文件不存在"})
            return

        content = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or candidate.suffix in {".js", ".css"}:
            content_type = f"{content_type}; charset=utf-8"
        handler.send_response(HTTPStatus.OK)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Content-Length", str(len(content)))
        handler.end_headers()
        handler.wfile.write(content)

    def _send_json(self, handler: BaseHTTPRequestHandler, status: HTTPStatus, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    def make_handler(self) -> type[BaseHTTPRequestHandler]:
        app = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "MathQuestHTTP/1.0"

            def log_message(self, fmt: str, *args: Any) -> None:
                return

            def do_GET(self) -> None:
                try:
                    path = urlparse(self.path).path
                    if path in {"/", "/index.html"}:
                        app._serve_injected_index(self)
                        return
                    if path in {"/app-client.js", "/app-extra.css"}:
                        app._serve_static_file(self, path)
                        return
                    if path == "/api/health":
                        app._send_json(self, HTTPStatus.OK, {"ok": True})
                        return
                    if path == "/api/me":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        app._send_json(self, HTTPStatus.OK, {"authenticated": True, "user": app._public_user(user)})
                        return
                    if path == "/api/state":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        with app._connect() as conn:
                            state = app._load_user_state(conn, user["id"])
                        app._send_json(self, HTTPStatus.OK, {"state": state})
                        return
                    if path == "/api/admin/users":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        if not user["is_admin"]:
                            app._send_json(self, HTTPStatus.FORBIDDEN, {"error": "需要管理员权限"})
                            return
                        with app._connect() as conn:
                            rows = conn.execute(
                                """
                                SELECT users.*, user_states.state_json
                                FROM users
                                LEFT JOIN user_states ON user_states.user_id = users.id
                                ORDER BY users.is_admin DESC, users.created_at ASC
                                """
                            ).fetchall()

                        users = []
                        for row in rows:
                            state = default_state()
                            if row["state_json"]:
                                try:
                                    state = normalize_state(json.loads(row["state_json"]))
                                except json.JSONDecodeError:
                                    state = default_state()
                            summary = summarize_state(state)
                            users.append(
                                {
                                    "user": app._public_user(row),
                                    "summary": {key: value for key, value in summary.items() if key != "recentDays"},
                                    "recent_days": summary["recentDays"],
                                }
                            )
                        app._send_json(self, HTTPStatus.OK, {"users": users})
                        return

                    app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
                except Exception as exc:
                    app._send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "服务器内部错误", "detail": str(exc)})

            def do_POST(self) -> None:
                try:
                    path = urlparse(self.path).path
                    if path == "/api/auth/register":
                        body = app._read_json(self)
                        username, password, display_name = app._validate_registration(body)
                        salt_hex, password_hash = app._hash_password(password)
                        now = utc_now_iso()

                        with app._connect() as conn:
                            exists = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
                            if exists:
                                app._send_json(self, HTTPStatus.CONFLICT, {"error": "用户名已存在"})
                                return
                            cur = conn.execute(
                                """
                                INSERT INTO users (username, display_name, password_salt, password_hash, is_admin, created_at)
                                VALUES (?, ?, ?, ?, 0, ?)
                                """,
                                (username, display_name, salt_hex, password_hash, now),
                            )
                            user_id = cur.lastrowid
                            conn.execute(
                                "INSERT INTO user_states (user_id, state_json, updated_at) VALUES (?, ?, ?)",
                                (user_id, json.dumps(default_state(), ensure_ascii=False), now),
                            )
                            token = app._create_session(conn, user_id)
                            user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

                        self.send_response(HTTPStatus.CREATED)
                        app._set_session_cookie(self, token)
                        payload = json.dumps(
                            {"message": "注册成功", "user": app._public_user(user)},
                            ensure_ascii=False,
                        ).encode("utf-8")
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                        return

                    if path == "/api/auth/login":
                        body = app._read_json(self)
                        username = str(body.get("username", "")).strip()
                        password = str(body.get("password", ""))
                        if not username or not password:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "请输入用户名和密码"})
                            return

                        with app._connect() as conn:
                            user = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
                            if user is None or not app._verify_password(password, user["password_salt"], user["password_hash"]):
                                app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "用户名或密码错误"})
                                return
                            token = app._create_session(conn, user["id"])

                        self.send_response(HTTPStatus.OK)
                        app._set_session_cookie(self, token)
                        payload = json.dumps(
                            {"message": "登录成功", "user": app._public_user(user)},
                            ensure_ascii=False,
                        ).encode("utf-8")
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                        return

                    if path == "/api/auth/logout":
                        cookie = app._parse_cookie(self)
                        morsel = cookie.get(SESSION_COOKIE)
                        if morsel:
                            with app._connect() as conn:
                                app._delete_session(conn, morsel.value)
                        self.send_response(HTTPStatus.OK)
                        app._clear_session_cookie(self)
                        payload = json.dumps({"message": "已退出登录"}, ensure_ascii=False).encode("utf-8")
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                        return

                    app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
                except ValueError as exc:
                    app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                except sqlite3.IntegrityError:
                    app._send_json(self, HTTPStatus.CONFLICT, {"error": "用户名已存在"})
                except Exception as exc:
                    app._send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "服务器内部错误", "detail": str(exc)})

            def do_PUT(self) -> None:
                try:
                    path = urlparse(self.path).path
                    if path == "/api/state":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        body = app._read_json(self)
                        if "state" not in body:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "缺少 state"})
                            return
                        with app._connect() as conn:
                            state = app._save_user_state(conn, user["id"], body["state"])
                        app._send_json(self, HTTPStatus.OK, {"message": "保存成功", "state": state})
                        return

                    app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
                except ValueError as exc:
                    app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                except Exception as exc:
                    app._send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "服务器内部错误", "detail": str(exc)})

        return Handler

    def create_server(self) -> ThreadingHTTPServer:
        return ThreadingHTTPServer((self.host, self.port), self.make_handler())


def main() -> None:
    parser = argparse.ArgumentParser(description="Math Quest 任务记录后端")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址")
    parser.add_argument("--port", type=int, default=8000, help="监听端口")
    parser.add_argument("--db", default="math-quest.db", help="SQLite 数据库文件路径")
    parser.add_argument("--admin-user", default="admin", help="默认管理员用户名")
    parser.add_argument("--admin-password", default="admin123456", help="默认管理员密码")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    app = MathQuestApp(
        db_path=root / args.db,
        static_dir=root,
        admin_username=args.admin_user,
        admin_password=args.admin_password,
        host=args.host,
        port=args.port,
    )
    server = app.create_server()
    print(f"Math Quest server running on http://{args.host}:{args.port}")
    print(f"默认管理员账号: {args.admin_user} / {args.admin_password}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

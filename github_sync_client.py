import argparse
import base64
import json
import mimetypes
import secrets
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from desktop_runtime import app_data_root
from server import MathQuestApp, default_state, normalize_state


API_VERSION = "2022-11-28"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def local_app_root() -> Path:
    return app_data_root("MathQuestDesktop")


def repo_root() -> Path:
    return Path(__file__).resolve().parent


class GitHubRepoClient:
    def __init__(self, owner: str, repo: str, token: str, branch: str = "main") -> None:
        self.owner = owner
        self.repo = repo
        self.token = token
        self.branch = branch

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        url = f"https://api.github.com{path}"
        data = None
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = Request(url, data=data, method=method)
        request.add_header("Accept", "application/vnd.github+json")
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("X-GitHub-Api-Version", API_VERSION)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urlopen(request, timeout=25) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except HTTPError as exc:
            if exc.code == 404:
                return None
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"GitHub API {exc.code}: {detail}") from exc

    def list_tree(self, prefix: str) -> dict[str, str]:
        path = f"/repos/{self.owner}/{self.repo}/git/trees/{quote(self.branch, safe='')}?recursive=1"
        payload = self._request("GET", path) or {}
        items: dict[str, str] = {}
        for item in payload.get("tree", []):
            if item.get("type") != "blob":
                continue
            item_path = item.get("path", "")
            if item_path.startswith(prefix):
                items[item_path] = item.get("sha", "")
        return items

    def get_file(self, remote_path: str) -> tuple[dict[str, Any], str] | tuple[None, None]:
        query = urlencode({"ref": self.branch})
        path = f"/repos/{self.owner}/{self.repo}/contents/{quote(remote_path, safe='/')}?{query}"
        payload = self._request("GET", path)
        if payload is None:
            return None, None
        if payload.get("encoding") != "base64":
            raise RuntimeError(f"GitHub 返回了无法识别的编码: {remote_path}")
        raw = base64.b64decode(payload["content"])
        return json.loads(raw.decode("utf-8")), payload.get("sha", "")

    def get_bytes(self, remote_path: str) -> tuple[bytes, str] | tuple[None, None]:
        query = urlencode({"ref": self.branch})
        path = f"/repos/{self.owner}/{self.repo}/contents/{quote(remote_path, safe='/')}?{query}"
        payload = self._request("GET", path)
        if payload is None:
            return None, None
        raw = base64.b64decode(payload["content"])
        return raw, payload.get("sha", "")

    def put_bytes(self, remote_path: str, content: bytes, message: str, sha: str | None = None) -> str:
        body = {
            "message": message,
            "branch": self.branch,
            "content": base64.b64encode(content).decode("ascii"),
        }
        if sha:
            body["sha"] = sha
        path = f"/repos/{self.owner}/{self.repo}/contents/{quote(remote_path, safe='/')}"
        payload = self._request("PUT", path, body) or {}
        return payload.get("content", {}).get("sha", "")

    def put_json(self, remote_path: str, data: dict[str, Any], message: str, sha: str | None = None) -> str:
        return self.put_bytes(remote_path, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"), message, sha)


def initialize_local_app(db_path: Path, upload_dir: Path) -> None:
    upload_dir.mkdir(parents=True, exist_ok=True)
    MathQuestApp(
        db_path=db_path,
        static_dir=repo_root(),
        upload_dir=upload_dir,
        host="127.0.0.1",
        port=0,
    )


def connect_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS github_sync_links (
            local_submission_id INTEGER PRIMARY KEY,
            remote_submission_id TEXT NOT NULL UNIQUE,
            review_sha TEXT,
            uploaded_at TEXT NOT NULL,
            FOREIGN KEY(local_submission_id) REFERENCES study_submissions(id) ON DELETE CASCADE
        )
        """
    )
    return conn


def choose_users(conn: sqlite3.Connection, username: str | None) -> list[sqlite3.Row]:
    if username:
        row = conn.execute("SELECT * FROM users WHERE is_admin = 0 AND username = ?", (username,)).fetchone()
        return [row] if row else []
    return conn.execute("SELECT * FROM users WHERE is_admin = 0 ORDER BY created_at ASC").fetchall()


def load_user_state(conn: sqlite3.Connection, user_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT state_json FROM user_states WHERE user_id = ?", (user_id,)).fetchone()
    if row is None:
        return default_state()
    try:
        return normalize_state(json.loads(row["state_json"]))
    except json.JSONDecodeError:
        return default_state()


def generate_remote_submission_id(username: str, created_at: str) -> str:
    compact = created_at.replace("-", "").replace(":", "").replace("+00:00", "Z").replace(".", "")
    return f"{username}-{compact}-{secrets.token_hex(4)}"


def upload_state_snapshots(conn: sqlite3.Connection, gh: GitHubRepoClient, users: list[sqlite3.Row]) -> int:
    count = 0
    for user in users:
        state = load_user_state(conn, user["id"])
        payload = {
            "schema": 1,
            "synced_at": utc_now_iso(),
            "user": {
                "username": user["username"],
                "display_name": user["display_name"],
                "created_at": user["created_at"],
            },
            "state": state,
        }
        remote_path = f"state-cache/{user['username']}.json"
        _, existing_sha = gh.get_file(remote_path)
        gh.put_json(remote_path, payload, f"client: update state for {user['username']}", existing_sha)
        count += 1
    return count


def upload_submissions(conn: sqlite3.Connection, gh: GitHubRepoClient, upload_dir: Path, users: list[sqlite3.Row]) -> int:
    user_by_id = {user["id"]: user for user in users}
    rows = conn.execute(
        """
        SELECT study_submissions.*, github_sync_links.remote_submission_id
        FROM study_submissions
        LEFT JOIN github_sync_links ON github_sync_links.local_submission_id = study_submissions.id
        ORDER BY study_submissions.created_at ASC, study_submissions.id ASC
        """
    ).fetchall()
    uploaded = 0
    for row in rows:
        user = user_by_id.get(row["user_id"])
        if user is None:
            continue
        if row["remote_submission_id"]:
          continue
        remote_id = generate_remote_submission_id(user["username"], row["created_at"])
        evidence_suffix = Path(row["evidence_name"]).suffix or mimetypes.guess_extension(row["evidence_mime"] or "") or ".bin"
        proof_remote_path = f"proofs/{user['username']}/{remote_id}{evidence_suffix}"
        evidence_local_path = upload_dir / row["evidence_path"]
        if not evidence_local_path.exists():
            raise FileNotFoundError(f"本地凭证不存在: {evidence_local_path}")
        gh.put_bytes(
            proof_remote_path,
            evidence_local_path.read_bytes(),
            f"client: upload proof {remote_id}",
        )

        state = load_user_state(conn, user["id"])
        day_snapshot = state.get("history", {}).get(row["date_key"], {})
        submission_payload = {
            "schema": 1,
            "submission_id": remote_id,
            "submitted_at": row["created_at"],
            "user": {
                "username": user["username"],
                "display_name": user["display_name"],
                "created_at": user["created_at"],
            },
            "date_key": row["date_key"],
            "duration_minutes": row["duration_minutes"],
            "note": row["note"],
            "evidence": {
                "name": row["evidence_name"],
                "mime": row["evidence_mime"],
                "path": proof_remote_path,
            },
            "day_snapshot": day_snapshot,
        }
        gh.put_json(
            f"submissions/{user['username']}/{remote_id}.json",
            submission_payload,
            f"client: upload submission {remote_id}",
        )
        conn.execute(
            """
            INSERT INTO github_sync_links (local_submission_id, remote_submission_id, review_sha, uploaded_at)
            VALUES (?, ?, NULL, ?)
            """,
            (row["id"], remote_id, utc_now_iso()),
        )
        uploaded += 1
    conn.commit()
    return uploaded


def apply_reviews(conn: sqlite3.Connection, gh: GitHubRepoClient, users: list[sqlite3.Row]) -> int:
    user_by_id = {user["id"]: user for user in users}
    admin_row = conn.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
    admin_id = admin_row["id"] if admin_row else None
    rows = conn.execute(
        """
        SELECT study_submissions.*, github_sync_links.remote_submission_id, github_sync_links.review_sha
        FROM study_submissions
        JOIN github_sync_links ON github_sync_links.local_submission_id = study_submissions.id
        ORDER BY study_submissions.created_at ASC
        """
    ).fetchall()
    updated = 0
    for row in rows:
        user = user_by_id.get(row["user_id"])
        if user is None:
            continue
        remote_path = f"reviews/{user['username']}/{row['remote_submission_id']}.json"
        review_payload, review_sha = gh.get_file(remote_path)
        if not review_payload or review_sha == row["review_sha"]:
            continue
        status = str(review_payload.get("status", "")).strip().lower()
        if status not in {"approved", "rejected"}:
            continue
        conn.execute(
            """
            UPDATE study_submissions
            SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ?
            WHERE id = ?
            """,
            (
                status,
                str(review_payload.get("admin_note", ""))[:500],
                admin_id,
                str(review_payload.get("reviewed_at", "")) or utc_now_iso(),
                row["id"],
            ),
        )
        conn.execute(
            "UPDATE github_sync_links SET review_sha = ? WHERE local_submission_id = ?",
            (review_sha, row["id"]),
        )
        updated += 1
    conn.commit()
    return updated


def run_once(args: argparse.Namespace) -> str:
    db_path = Path(args.db)
    upload_dir = Path(args.upload_dir)
    initialize_local_app(db_path, upload_dir)
    gh = GitHubRepoClient(args.owner, args.repo, args.token, args.branch)
    with connect_db(db_path) as conn:
        users = choose_users(conn, args.username)
        if not users:
            return "没有找到可同步的泡面侠账号"
        uploaded_states = upload_state_snapshots(conn, gh, users)
        uploaded_submissions = upload_submissions(conn, gh, upload_dir, users)
        updated_reviews = apply_reviews(conn, gh, users)
    return f"sync-client ok states={uploaded_states} submissions={uploaded_submissions} reviews={updated_reviews}"


def parse_args() -> argparse.Namespace:
    root = local_app_root()
    parser = argparse.ArgumentParser(description="Math Quest GitHub 同步客户端")
    parser.add_argument("--owner", default="", help="GitHub 仓库拥有者，建议填小和的账号")
    parser.add_argument("--repo", default="", help="GitHub 私有同步仓库名")
    parser.add_argument("--branch", default="main", help="同步分支")
    parser.add_argument("--token", default="", help="具备 contents 读写权限的 GitHub token")
    parser.add_argument("--db", default=str(root / "math-quest.db"), help="本地 SQLite 路径")
    parser.add_argument("--upload-dir", default=str(root / "uploads"), help="本地凭证目录")
    parser.add_argument("--username", default=None, help="只同步指定用户名")
    parser.add_argument("--interval", type=int, default=300, help="轮询间隔秒数，默认 300")
    parser.add_argument("--once", action="store_true", help="只同步一次")
    args = parser.parse_args()
    args.owner = args.owner or ""
    args.repo = args.repo or ""
    args.token = args.token or ""
    if not args.owner or not args.repo or not args.token:
        parser.error("必须提供 --owner、--repo、--token")
    return args


def main() -> int:
    args = parse_args()
    if args.once:
        print(run_once(args))
        return 0
    while True:
        try:
            print(run_once(args))
        except Exception as exc:
            print(f"sync-client error: {exc}")
        time.sleep(max(30, args.interval))


if __name__ == "__main__":
    raise SystemExit(main())

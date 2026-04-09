import argparse
import json
import mimetypes
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

from desktop_runtime import app_data_root
from github_sync_common import GitHubRepoClient, append_sync_log, sha256_hex, utc_now_iso
from server import MathQuestApp, default_state, normalize_state


def local_admin_root() -> Path:
    return app_data_root("MathQuestXiaohe")


def repo_root() -> Path:
    return Path(__file__).resolve().parent


def initialize_admin_app(db_path: Path, upload_dir: Path) -> None:
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
        CREATE TABLE IF NOT EXISTS github_server_links (
            remote_submission_id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            local_submission_id INTEGER,
            submission_sha TEXT,
            review_sha TEXT,
            state_sha TEXT,
            submission_fingerprint TEXT,
            imported_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS github_state_links (
            username TEXT PRIMARY KEY,
            state_sha TEXT NOT NULL,
            synced_at TEXT NOT NULL
        )
        """
    )
    ensure_columns(
        conn,
        "github_server_links",
        {
            "submission_fingerprint": "TEXT",
        },
    )
    return conn


def ensure_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, sql_type in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}")


def log_path_for(db_path: Path) -> Path:
    return db_path.parent / "github-sync-server.log"


def ensure_remote_user(conn: sqlite3.Connection, payload: dict[str, Any]) -> int:
    username = payload["username"]
    row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if row is not None:
        conn.execute("UPDATE users SET display_name = ? WHERE username = ?", (payload["display_name"], username))
        return row["id"]
    now = payload.get("created_at") or utc_now_iso()
    conn.execute(
        """
        INSERT INTO users (username, display_name, password_salt, password_hash, is_admin, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
        """,
        (username, payload["display_name"], secrets.token_hex(16), secrets.token_hex(32), now),
    )
    return conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()["id"]


def load_state(conn: sqlite3.Connection, user_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT state_json FROM user_states WHERE user_id = ?", (user_id,)).fetchone()
    if row is None:
        return default_state()
    try:
        return normalize_state(json.loads(row["state_json"]))
    except json.JSONDecodeError:
        return default_state()


def save_state(conn: sqlite3.Connection, user_id: int, state: dict[str, Any]) -> None:
    payload = json.dumps(normalize_state(state), ensure_ascii=False)
    conn.execute(
        """
        INSERT INTO user_states (user_id, state_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
        """,
        (user_id, payload, utc_now_iso()),
    )


def submission_fingerprint_from_payload(payload: dict[str, Any], evidence_hash: str | None = None) -> str:
    fingerprint = str(payload.get("submission_fingerprint", "")).strip()
    if fingerprint:
        return fingerprint
    evidence_ref = payload.get("evidence", {}).get("path", "")
    return sha256_hex(
        json.dumps(
            {
                "username": payload.get("user", {}).get("username", ""),
                "created_at": payload.get("submitted_at", ""),
                "date_key": payload.get("date_key", ""),
                "duration_minutes": payload.get("duration_minutes", 0),
                "note": payload.get("note", ""),
                "evidence": evidence_hash or evidence_ref,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )


def import_state_snapshots(conn: sqlite3.Connection, gh: GitHubRepoClient, *, log_path: Path) -> int:
    tree = gh.list_tree("state-cache/")
    imported = 0
    for remote_path, state_sha in tree.items():
        username = Path(remote_path).stem
        existing = conn.execute("SELECT state_sha FROM github_state_links WHERE username = ?", (username,)).fetchone()
        if existing and existing["state_sha"] == state_sha:
            continue
        payload, _ = gh.get_file(remote_path)
        if not payload:
            continue
        user_payload = payload.get("user") or {}
        user_id = ensure_remote_user(conn, user_payload)
        save_state(conn, user_id, payload.get("state") or default_state())
        conn.execute(
            """
            INSERT INTO github_state_links (username, state_sha, synced_at)
            VALUES (?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET state_sha = excluded.state_sha, synced_at = excluded.synced_at
            """,
            (username, state_sha, utc_now_iso()),
        )
        append_sync_log(log_path, "info", "state-import", "已导入泡面侠状态快照", username=username)
        imported += 1
    conn.commit()
    return imported


def merge_day_snapshot(conn: sqlite3.Connection, user_id: int, date_key: str, snapshot: dict[str, Any]) -> None:
    state = load_state(conn, user_id)
    history = state.setdefault("history", {})
    day = history.get(date_key, {})
    if not isinstance(day, dict):
        day = {}
    if isinstance(snapshot, dict):
        for key in ("tasks", "journal", "mood", "energy", "rewardShown", "checkin"):
            if key in snapshot:
                day[key] = snapshot[key]
    history[date_key] = day
    save_state(conn, user_id, state)


def import_submissions(conn: sqlite3.Connection, gh: GitHubRepoClient, upload_dir: Path, *, log_path: Path) -> int:
    tree = gh.list_tree("submissions/")
    imported = 0
    for remote_path, submission_sha in tree.items():
        if not remote_path.endswith(".json"):
            continue
        payload, _ = gh.get_file(remote_path)
        if not payload:
            continue
        remote_submission_id = payload["submission_id"]
        existing = conn.execute(
            "SELECT local_submission_id, submission_sha, submission_fingerprint FROM github_server_links WHERE remote_submission_id = ?",
            (remote_submission_id,),
        ).fetchone()
        if existing and existing["submission_sha"] == submission_sha:
            append_sync_log(log_path, "info", "submission-skip", "远端提交没有变化，跳过导入", submission_id=remote_submission_id)
            continue

        user_payload = payload["user"]
        user_id = ensure_remote_user(conn, user_payload)
        merge_day_snapshot(conn, user_id, payload["date_key"], payload.get("day_snapshot") or {})

        if existing and existing["local_submission_id"]:
            conn.execute(
                """
                UPDATE github_server_links
                SET submission_sha = ?, submission_fingerprint = ?
                WHERE remote_submission_id = ?
                """,
                (
                    submission_sha,
                    existing["submission_fingerprint"] or "",
                    remote_submission_id,
                ),
            )
            append_sync_log(log_path, "info", "submission-update", "远端提交映射已更新", submission_id=remote_submission_id)
            imported += 1
            continue

        proof_path = payload["evidence"]["path"]
        proof_bytes, _ = gh.get_bytes(proof_path)
        if proof_bytes is None:
            raise FileNotFoundError(f"GitHub 中缺少凭证文件: {proof_path}")
        fingerprint = submission_fingerprint_from_payload(payload, sha256_hex(proof_bytes))
        duplicate = conn.execute(
            """
            SELECT local_submission_id, remote_submission_id
            FROM github_server_links
            WHERE username = ? AND submission_fingerprint = ?
            """,
            (user_payload["username"], fingerprint),
        ).fetchone()
        if duplicate and duplicate["local_submission_id"]:
            conn.execute(
                """
                INSERT INTO github_server_links (
                    remote_submission_id, username, local_submission_id, submission_sha, review_sha, state_sha, submission_fingerprint, imported_at
                )
                VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
                ON CONFLICT(remote_submission_id) DO UPDATE SET
                    username = excluded.username,
                    local_submission_id = excluded.local_submission_id,
                    submission_sha = excluded.submission_sha,
                    submission_fingerprint = excluded.submission_fingerprint
                """,
                (
                    remote_submission_id,
                    user_payload["username"],
                    duplicate["local_submission_id"],
                    submission_sha,
                    fingerprint,
                    utc_now_iso(),
                ),
            )
            append_sync_log(
                log_path,
                "warning",
                "submission-dedupe",
                "检测到重复提交，已复用已有本地记录",
                submission_id=remote_submission_id,
                duplicate_of=duplicate["remote_submission_id"],
            )
            imported += 1
            continue
        suffix = Path(payload["evidence"]["name"]).suffix or mimetypes.guess_extension(payload["evidence"]["mime"] or "") or ".bin"
        local_proof_name = f"github-{remote_submission_id}{suffix}"
        (upload_dir / local_proof_name).write_bytes(proof_bytes)
        conn.execute(
            """
            INSERT INTO study_submissions (
                user_id, date_key, duration_minutes, note, evidence_name, evidence_mime, evidence_path, status, admin_note, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', ?)
            """,
            (
                user_id,
                payload["date_key"],
                int(payload["duration_minutes"]),
                str(payload.get("note", ""))[:500],
                payload["evidence"]["name"],
                payload["evidence"]["mime"],
                local_proof_name,
                payload.get("submitted_at") or utc_now_iso(),
            ),
        )
        local_submission_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO github_server_links (
                remote_submission_id, username, local_submission_id, submission_sha, review_sha, state_sha, submission_fingerprint, imported_at
            )
            VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
            ON CONFLICT(remote_submission_id) DO UPDATE SET
                username = excluded.username,
                local_submission_id = excluded.local_submission_id,
                submission_sha = excluded.submission_sha,
                submission_fingerprint = excluded.submission_fingerprint
            """,
            (remote_submission_id, user_payload["username"], local_submission_id, submission_sha, fingerprint, utc_now_iso()),
        )
        append_sync_log(log_path, "info", "submission-import", "已导入新的学习提交", submission_id=remote_submission_id)
        imported += 1
    conn.commit()
    return imported


def export_reviews(conn: sqlite3.Connection, gh: GitHubRepoClient, *, log_path: Path) -> int:
    rows = conn.execute(
        """
        SELECT
            study_submissions.*,
            github_server_links.remote_submission_id,
            github_server_links.review_sha,
            github_server_links.username,
            reviewer.username AS reviewer_username,
            reviewer.display_name AS reviewer_display_name
        FROM github_server_links
        JOIN study_submissions ON study_submissions.id = github_server_links.local_submission_id
        LEFT JOIN users AS reviewer ON reviewer.id = study_submissions.reviewed_by
        WHERE study_submissions.status IN ('approved', 'rejected')
          AND study_submissions.reviewed_at IS NOT NULL
        ORDER BY study_submissions.reviewed_at ASC
        """
    ).fetchall()
    exported = 0
    for row in rows:
        remote_path = f"reviews/{row['username']}/{row['remote_submission_id']}.json"
        payload = {
            "schema": 1,
            "submission_id": row["remote_submission_id"],
            "username": row["username"],
            "status": row["status"],
            "admin_note": row["admin_note"],
            "reviewed_at": row["reviewed_at"],
            "reviewer": {
                "username": row["reviewer_username"] or "admin",
                "display_name": row["reviewer_display_name"] or "小和",
            },
        }
        action, sha = gh.put_json_if_changed(
            remote_path,
            payload,
            f"server: review {row['remote_submission_id']}",
        )
        conn.execute(
            "UPDATE github_server_links SET review_sha = ? WHERE remote_submission_id = ?",
            (sha, row["remote_submission_id"]),
        )
        if action == "unchanged":
            append_sync_log(log_path, "info", "review-dedupe", "审核结果没有变化，跳过重复回写", submission_id=row["remote_submission_id"])
        else:
            append_sync_log(log_path, "info", "review-export", "审核结果已回写到 GitHub", submission_id=row["remote_submission_id"], action=action)
        exported += 1
    conn.commit()
    return exported


def run_once(args: argparse.Namespace) -> str:
    db_path = Path(args.db)
    upload_dir = Path(args.upload_dir)
    log_path = Path(getattr(args, "log_path", log_path_for(db_path)))
    initialize_admin_app(db_path, upload_dir)
    gh = GitHubRepoClient(args.owner, args.repo, args.token, args.branch)
    with connect_db(db_path) as conn:
        states = import_state_snapshots(conn, gh, log_path=log_path)
        submissions = import_submissions(conn, gh, upload_dir, log_path=log_path)
        reviews = export_reviews(conn, gh, log_path=log_path)
    summary = f"sync-server ok states={states} submissions={submissions} reviews={reviews}"
    append_sync_log(log_path, "info", "sync-round", summary)
    return summary


def parse_args() -> argparse.Namespace:
    root = local_admin_root()
    parser = argparse.ArgumentParser(description="Math Quest GitHub 同步服务端")
    parser.add_argument("--owner", default="", help="GitHub 仓库拥有者，建议填小和的账号")
    parser.add_argument("--repo", default="", help="GitHub 私有同步仓库名")
    parser.add_argument("--branch", default="main", help="同步分支")
    parser.add_argument("--token", default="", help="具备 contents 读写权限的 GitHub token")
    parser.add_argument("--db", default=str(root / "math-quest.db"), help="小和本地 SQLite 路径")
    parser.add_argument("--upload-dir", default=str(root / "uploads"), help="小和本地凭证目录")
    parser.add_argument("--log-path", default=str(root / "github-sync-server.log"), help="同步日志路径")
    parser.add_argument("--interval", type=int, default=300, help="轮询间隔秒数，默认 300")
    parser.add_argument("--once", action="store_true", help="只同步一次")
    args = parser.parse_args()
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
            print(f"sync-server error: {exc}")
        time.sleep(max(30, args.interval))


if __name__ == "__main__":
    raise SystemExit(main())

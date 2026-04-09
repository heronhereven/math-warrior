import argparse
import json
import mimetypes
import sqlite3
import time
from pathlib import Path
from typing import Any

from desktop_runtime import app_data_root
from github_sync_common import (
    GitHubRepoClient,
    append_sync_log,
    compact_timestamp,
    sha256_hex,
    utc_now_iso,
)
from server import MathQuestApp, default_state, normalize_state


def local_app_root() -> Path:
    return app_data_root("MathQuestDesktop")


def repo_root() -> Path:
    return Path(__file__).resolve().parent


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
            proof_sha TEXT,
            submission_sha TEXT,
            submission_fingerprint TEXT,
            uploaded_at TEXT NOT NULL,
            FOREIGN KEY(local_submission_id) REFERENCES study_submissions(id) ON DELETE CASCADE
        )
        """
    )
    ensure_columns(
        conn,
        "github_sync_links",
        {
            "proof_sha": "TEXT",
            "submission_sha": "TEXT",
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
    return db_path.parent / "github-sync-client.log"


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


def generate_submission_fingerprint(
    *,
    username: str,
    created_at: str,
    date_key: str,
    duration_minutes: int,
    note: str,
    evidence_hash: str,
) -> str:
    return sha256_hex(
        json.dumps(
            {
                "username": username,
                "created_at": created_at,
                "date_key": date_key,
                "duration_minutes": duration_minutes,
                "note": note,
                "evidence_hash": evidence_hash,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )


def generate_remote_submission_id(username: str, created_at: str, fingerprint: str) -> str:
    return f"{username}-{compact_timestamp(created_at)}-{fingerprint[:10]}"


def upload_state_snapshots(
    conn: sqlite3.Connection,
    gh: GitHubRepoClient,
    users: list[sqlite3.Row],
    *,
    log_path: Path,
) -> int:
    count = 0
    for user in users:
        state = load_user_state(conn, user["id"])
        payload = {
            "schema": 1,
            "user": {
                "username": user["username"],
                "display_name": user["display_name"],
                "created_at": user["created_at"],
            },
            "state": state,
        }
        remote_path = f"state-cache/{user['username']}.json"
        action, _ = gh.put_json_if_changed(remote_path, payload, f"client: update state for {user['username']}")
        if action == "unchanged":
            append_sync_log(log_path, "info", "state-skip", "状态快照没有变化，跳过上传", username=user["username"])
        else:
            append_sync_log(log_path, "info", "state-sync", "状态快照已同步", username=user["username"], action=action)
        count += 1
    return count


def upload_submissions(
    conn: sqlite3.Connection,
    gh: GitHubRepoClient,
    upload_dir: Path,
    users: list[sqlite3.Row],
    *,
    log_path: Path,
) -> int:
    user_by_id = {user["id"]: user for user in users}
    rows = conn.execute(
        """
        SELECT
            study_submissions.*,
            github_sync_links.remote_submission_id,
            github_sync_links.proof_sha,
            github_sync_links.submission_sha,
            github_sync_links.submission_fingerprint
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
        evidence_suffix = Path(row["evidence_name"]).suffix or mimetypes.guess_extension(row["evidence_mime"] or "") or ".bin"
        evidence_local_path = upload_dir / row["evidence_path"]
        if not evidence_local_path.exists():
            raise FileNotFoundError(f"本地凭证不存在: {evidence_local_path}")
        evidence_bytes = evidence_local_path.read_bytes()
        evidence_hash = sha256_hex(evidence_bytes)
        fingerprint = generate_submission_fingerprint(
            username=user["username"],
            created_at=row["created_at"],
            date_key=row["date_key"],
            duration_minutes=int(row["duration_minutes"]),
            note=str(row["note"] or ""),
            evidence_hash=evidence_hash,
        )
        remote_id = row["remote_submission_id"] or generate_remote_submission_id(user["username"], row["created_at"], fingerprint)
        proof_remote_path = f"proofs/{user['username']}/{remote_id}{evidence_suffix}"
        proof_action, proof_sha = gh.put_bytes_if_changed(
            proof_remote_path,
            evidence_bytes,
            f"client: upload proof {remote_id}",
        )
        if proof_action == "unchanged":
            append_sync_log(log_path, "info", "proof-dedupe", "凭证文件已存在，跳过重复上传", submission_id=remote_id)
        else:
            append_sync_log(log_path, "info", "proof-sync", "凭证文件已同步", submission_id=remote_id, action=proof_action)

        state = load_user_state(conn, user["id"])
        day_snapshot = state.get("history", {}).get(row["date_key"], {})
        submission_payload = {
            "schema": 1,
            "submission_id": remote_id,
            "submission_fingerprint": fingerprint,
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
        submission_action, submission_sha = gh.put_json_if_changed(
            f"submissions/{user['username']}/{remote_id}.json",
            submission_payload,
            f"client: upload submission {remote_id}",
        )
        if submission_action == "unchanged":
            append_sync_log(log_path, "info", "submission-dedupe", "提交记录已存在，跳过重复上传", submission_id=remote_id)
        else:
            append_sync_log(log_path, "info", "submission-sync", "提交记录已同步", submission_id=remote_id, action=submission_action)
        conn.execute(
            """
            INSERT INTO github_sync_links (
                local_submission_id, remote_submission_id, review_sha, proof_sha, submission_sha, submission_fingerprint, uploaded_at
            )
            VALUES (?, ?, NULL, ?, ?, ?, ?)
            ON CONFLICT(local_submission_id) DO UPDATE SET
                remote_submission_id = excluded.remote_submission_id,
                proof_sha = excluded.proof_sha,
                submission_sha = excluded.submission_sha,
                submission_fingerprint = excluded.submission_fingerprint,
                uploaded_at = excluded.uploaded_at
            """,
            (row["id"], remote_id, proof_sha, submission_sha, fingerprint, utc_now_iso()),
        )
        uploaded += 1
    conn.commit()
    return uploaded


def apply_reviews(
    conn: sqlite3.Connection,
    gh: GitHubRepoClient,
    users: list[sqlite3.Row],
    *,
    log_path: Path,
) -> int:
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
            append_sync_log(log_path, "warning", "review-invalid", "审核回执状态无效，已跳过", submission_id=row["remote_submission_id"])
            continue
        local_status = str(row["status"] or "").strip().lower()
        local_note = str(row["admin_note"] or "")
        local_reviewed_at = str(row["reviewed_at"] or "")
        remote_note = str(review_payload.get("admin_note", ""))[:500]
        remote_reviewed_at = str(review_payload.get("reviewed_at", "")) or utc_now_iso()
        if local_status == status and local_note == remote_note and local_reviewed_at == remote_reviewed_at:
            append_sync_log(log_path, "info", "review-dedupe", "审核回执与本地一致，只更新游标", submission_id=row["remote_submission_id"])
            conn.execute(
                "UPDATE github_sync_links SET review_sha = ? WHERE local_submission_id = ?",
                (review_sha, row["id"]),
            )
            continue
        if local_status in {"approved", "rejected"} and local_status != status:
            append_sync_log(
                log_path,
                "warning",
                "review-conflict",
                "远端审核与本地不同，按小和回执覆盖本地状态",
                submission_id=row["remote_submission_id"],
                local_status=local_status,
                remote_status=status,
            )
        conn.execute(
            """
            UPDATE study_submissions
            SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ?
            WHERE id = ?
            """,
            (
                status,
                remote_note,
                admin_id,
                remote_reviewed_at,
                row["id"],
            ),
        )
        conn.execute(
            "UPDATE github_sync_links SET review_sha = ? WHERE local_submission_id = ?",
            (review_sha, row["id"]),
        )
        append_sync_log(log_path, "info", "review-apply", "已应用远端审核回执", submission_id=row["remote_submission_id"], status=status)
        updated += 1
    conn.commit()
    return updated


def run_once(args: argparse.Namespace) -> str:
    db_path = Path(args.db)
    upload_dir = Path(args.upload_dir)
    log_path = Path(getattr(args, "log_path", log_path_for(db_path)))
    initialize_local_app(db_path, upload_dir)
    gh = GitHubRepoClient(args.owner, args.repo, args.token, args.branch)
    with connect_db(db_path) as conn:
        users = choose_users(conn, args.username)
        if not users:
            return "没有找到可同步的泡面侠账号"
        uploaded_states = upload_state_snapshots(conn, gh, users, log_path=log_path)
        uploaded_submissions = upload_submissions(conn, gh, upload_dir, users, log_path=log_path)
        updated_reviews = apply_reviews(conn, gh, users, log_path=log_path)
    summary = f"sync-client ok states={uploaded_states} submissions={uploaded_submissions} reviews={updated_reviews}"
    append_sync_log(log_path, "info", "sync-round", summary)
    return summary


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
    parser.add_argument("--log-path", default=str(root / "github-sync-client.log"), help="同步日志路径")
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

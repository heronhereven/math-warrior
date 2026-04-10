import argparse
import base64
import binascii
import hashlib
import json
import math
import mimetypes
import random
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse


SESSION_COOKIE = "mq_session"
USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{3,24}$")
PASSWORD_MIN_LENGTH = 6
MAX_BODY_BYTES = 72 * 1024 * 1024
MAX_EVIDENCE_BYTES = 5 * 1024 * 1024
MAX_EVIDENCE_FILES = 9
PBKDF2_ROUNDS = 120_000
DAILY_GOAL_MINUTES = 120
WEEKEND_GOAL_MINUTES = 180
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
STAMP_POOL = [
    {"emoji": "🐹", "rarity": 1, "weight": 20, "label": "仓鼠"},
    {"emoji": "🐰", "rarity": 2, "weight": 18, "label": "兔兔"},
    {"emoji": "🐱", "rarity": 3, "weight": 15, "label": "小猫"},
    {"emoji": "🐶", "rarity": 4, "weight": 12, "label": "小狗"},
    {"emoji": "🦊", "rarity": 5, "weight": 9, "label": "狐狸"},
    {"emoji": "🐼", "rarity": 6, "weight": 7, "label": "熊猫"},
    {"emoji": "🦁", "rarity": 7, "weight": 5, "label": "狮子"},
    {"emoji": "🦄", "rarity": 8, "weight": 3, "label": "独角兽"},
    {"emoji": "🐥", "rarity": 9, "weight": 1, "label": "小鸭子"},
]
TASK_XP = {"correction": 24, "difficulty": 22, "review": 18}
JOURNAL_XP = 22
GOAL_BONUS_XP = 46
OVERACHIEVE_BONUS_XP = 36
STAMP_REWARD_BASE = 14
BONUS_TASK_BASE_REWARD = 80
DATE_KEY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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
        "checkin": {
            "stamped": False,
            "emoji": "",
            "rarity": 0,
            "label": "",
            "stampedAt": None,
            "moodNote": "",
            "progressNote": "",
            "comboBonusXp": 0,
            "comboDays": 0,
            "rewardXp": 0,
        },
        "status": {
            "goalMinutes": DAILY_GOAL_MINUTES,
            "approvedMinutes": 0,
            "pendingMinutes": 0,
            "rejectedMinutes": 0,
            "approvedCount": 0,
            "pendingCount": 0,
            "rejectedCount": 0,
            "progressState": "locked",
            "rewardState": "idle",
        },
    }


def clamp_int(value: Any, minimum: int, maximum: int, fallback: int = 0) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


def parse_date_key(value: str) -> date | None:
    if not isinstance(value, str) or not DATE_KEY_RE.fullmatch(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def normalize_date_key(value: Any, *, default_to_today: bool = True) -> str:
    if isinstance(value, str):
        text = value.strip()
    else:
        text = ""
    if not text and default_to_today:
        text = datetime.now().strftime("%Y-%m-%d")
    if not parse_date_key(text):
        raise ValueError("日期格式必须是 YYYY-MM-DD")
    return text


def goal_minutes_for_date_key(date_key: str) -> int:
    parsed = parse_date_key(date_key)
    if parsed is None:
        return DAILY_GOAL_MINUTES
    return WEEKEND_GOAL_MINUTES if parsed.weekday() >= 5 else DAILY_GOAL_MINUTES


def default_checkin() -> dict[str, Any]:
    return default_day()["checkin"].copy()


def normalize_checkin(raw: Any) -> dict[str, Any]:
    base = default_checkin()
    if not isinstance(raw, dict):
        return base
    base["stamped"] = bool(raw.get("stamped"))
    emoji = raw.get("emoji", "")
    base["emoji"] = emoji if isinstance(emoji, str) else ""
    label = raw.get("label", "")
    base["label"] = label if isinstance(label, str) else ""
    mood_note = raw.get("moodNote", "")
    base["moodNote"] = mood_note if isinstance(mood_note, str) else ""
    progress_note = raw.get("progressNote", "")
    base["progressNote"] = progress_note if isinstance(progress_note, str) else ""
    base["rarity"] = clamp_int(raw.get("rarity"), 0, 10, 0)
    stamped_at = raw.get("stampedAt")
    base["stampedAt"] = stamped_at if isinstance(stamped_at, str) else None
    base["comboBonusXp"] = clamp_int(raw.get("comboBonusXp"), 0, 200000, 0)
    base["comboDays"] = clamp_int(raw.get("comboDays"), 0, 365, 0)
    base["rewardXp"] = clamp_int(raw.get("rewardXp"), 0, 200000, 0)
    return base


def normalize_segment(raw: Any) -> dict[str, int] | None:
    if not isinstance(raw, dict):
        return None
    start = clamp_int(raw.get("s"), 0, 720, 0)
    end = clamp_int(raw.get("e"), 0, 720, 0)
    if start >= end:
        return None
    return {"s": start, "e": end}


def normalize_day(raw: Any) -> dict[str, Any]:
    base = default_day()
    if not isinstance(raw, dict):
        return base

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
    base["rewardShown"] = bool(raw.get("rewardShown"))
    base["checkin"] = normalize_checkin(raw.get("checkin"))
    return base


def collapse_minutes_to_segments(total_minutes: int) -> list[dict[str, int]]:
    minutes = clamp_int(total_minutes, 0, 720, 0)
    return [{"s": 0, "e": minutes}] if minutes > 0 else []


def normalize_state(raw: Any) -> dict[str, Any]:
    base = default_state()
    if not isinstance(raw, dict):
        return base

    last_date = raw.get("lastDate")
    base["lastDate"] = last_date if isinstance(last_date, str) else None

    history_raw = raw.get("history", {})
    if isinstance(history_raw, dict):
        history = {}
        for key, value in history_raw.items():
            if isinstance(key, str) and len(key) <= 32:
                history[key] = normalize_day(value)
        base["history"] = history

    return base


def compute_level(total_xp: int) -> dict[str, Any]:
    current = LEVELS[0]
    for level in LEVELS:
        if total_xp >= level["xp"]:
            current = level
    return current


def compute_study_xp(minutes: int) -> int:
    if minutes <= 0:
        return 0
    return int(round(14 * (math.exp(minutes / 95) - 1)))


def build_submission_rollup(rows: list[sqlite3.Row]) -> dict[str, dict[str, int]]:
    rollup: dict[str, dict[str, int]] = {}
    for row in rows:
        date_key = row["date_key"]
        bucket = rollup.setdefault(
            date_key,
            {
                "approved_minutes": 0,
                "pending_minutes": 0,
                "rejected_minutes": 0,
                "approved_count": 0,
                "pending_count": 0,
                "rejected_count": 0,
            },
        )
        status = row["status"]
        minutes = clamp_int(row["minutes"], 0, 720, 0)
        count = clamp_int(row["count"], 0, 10_000, 0)
        if status == "approved":
            bucket["approved_minutes"] += minutes
            bucket["approved_count"] += count
        elif status == "pending":
            bucket["pending_minutes"] += minutes
            bucket["pending_count"] += count
        elif status == "rejected":
            bucket["rejected_minutes"] += minutes
            bucket["rejected_count"] += count
    return rollup


def build_bonus_rollup(rows: list[sqlite3.Row]) -> dict[str, dict[str, Any]]:
    rollup: dict[str, dict[str, Any]] = {}
    for row in rows:
        date_key = row["date_key"]
        bucket = rollup.setdefault(
            date_key,
            {
                "reward_total": 0,
                "approved_count": 0,
                "pending_count": 0,
                "latest_title": "",
            },
        )
        status = row["status"]
        if status == "approved":
            bucket["reward_total"] += clamp_int(row["reward_total"], 0, 1_000_000, 0)
            bucket["approved_count"] += 1
            bucket["latest_title"] = row["title"] or bucket["latest_title"]
        elif status == "pending":
            bucket["pending_count"] += 1
    return rollup


def compute_bonus_reward(difficulty: int, target_days: int, created_at: str, submitted_at: str) -> tuple[int, str, float]:
    try:
        created = datetime.fromisoformat(created_at)
        submitted = datetime.fromisoformat(submitted_at)
        elapsed_days = max(0.0, (submitted - created).total_seconds() / 86400.0)
    except ValueError:
        elapsed_days = float(target_days)
    if elapsed_days <= max(0.5, target_days * 0.5):
        tier = "闪电完成"
        multiplier = 1.8
    elif elapsed_days <= target_days:
        tier = "稳稳拿下"
        multiplier = 1.35
    else:
        tier = "坚持完成"
        multiplier = 1.0
    reward = int(round((BONUS_TASK_BASE_REWARD + difficulty * 35) * multiplier))
    return reward, tier, multiplier


def checkin_combo_days(history: dict[str, Any], date_key: str) -> int:
    day = history.get(date_key, {})
    current = normalize_checkin(day.get("checkin"))
    if not current["stamped"] or not current["emoji"]:
        return 0
    cursor = parse_date_key(date_key)
    if not cursor:
        return 1
    combo = 1
    prev_date = cursor - timedelta(days=1)
    while True:
        prev_key = prev_date.isoformat()
        previous = normalize_checkin(history.get(prev_key, {}).get("checkin"))
        if not previous["stamped"] or previous["emoji"] != current["emoji"]:
            break
        combo += 1
        prev_date -= timedelta(days=1)
    return combo


def repeated_stamp_bias(history: dict[str, Any], date_key: str) -> tuple[str, int]:
    cursor = parse_date_key(date_key)
    if not cursor:
        return "", 0
    previous_date = cursor - timedelta(days=1)
    emoji = ""
    combo = 0
    while True:
        previous = normalize_checkin(history.get(previous_date.isoformat(), {}).get("checkin"))
        if not previous["stamped"] or not previous["emoji"]:
            break
        if not emoji:
            emoji = previous["emoji"]
        elif previous["emoji"] != emoji:
            break
        combo += 1
        previous_date -= timedelta(days=1)
    return emoji, combo


def pick_stamp(history: dict[str, Any], date_key: str) -> dict[str, Any]:
    biased_emoji, combo_days = repeated_stamp_bias(history, date_key)
    weighted_pool: list[tuple[dict[str, Any], float]] = []
    total_weight = 0.0
    for item in STAMP_POOL:
        weight = float(item["weight"])
        if biased_emoji and item["emoji"] == biased_emoji:
            weight *= 1.9 + min(4, combo_days) * 0.35
        weighted_pool.append((item, weight))
        total_weight += weight

    roll = random.uniform(0, total_weight)
    picked = STAMP_POOL[-1]
    for item, weight in weighted_pool:
        roll -= weight
        if roll <= 0:
            picked = item
            break
    return picked


def compute_stamp_reward(rarity: int, combo_days: int, approved_minutes: int, goal_minutes: int) -> tuple[int, int]:
    if rarity <= 0 or approved_minutes < goal_minutes:
        return 0, combo_days
    base_reward = STAMP_REWARD_BASE * rarity
    combo_bonus = 0
    if combo_days > 1:
        combo_bonus = base_reward * (2 ** (combo_days - 1))
    if approved_minutes > goal_minutes:
        base_reward = int(round(base_reward * 1.4))
        combo_bonus = int(round(combo_bonus * 1.25))
    return base_reward + combo_bonus, combo_bonus


def compute_progress_state(approved_minutes: int, goal_minutes: int) -> str:
    if approved_minutes <= 0:
        return "locked"
    if approved_minutes > goal_minutes:
        return "over"
    if approved_minutes >= goal_minutes:
        return "goal"
    return "growing"


def compute_reward_state(day: dict[str, Any], approved_minutes: int, pending_minutes: int, goal_minutes: int) -> str:
    checkin = normalize_checkin(day.get("checkin"))
    if not checkin["stamped"]:
        return "idle"
    if approved_minutes > goal_minutes:
        return "over"
    if approved_minutes >= goal_minutes:
        return "earned"
    if pending_minutes > 0:
        return "pending"
    return "muted"


def finalize_state(
    state: dict[str, Any],
    submission_rollup: dict[str, dict[str, int]],
    bonus_rollup: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    merged = normalize_state(state)
    bonus_rollup = bonus_rollup or {}
    for date_key in submission_rollup:
        if date_key not in merged["history"]:
            merged["history"][date_key] = default_day()
    for date_key in bonus_rollup:
        if date_key not in merged["history"]:
            merged["history"][date_key] = default_day()

    sorted_keys = sorted(merged["history"], key=lambda item: parse_date_key(item) or date.min)
    total_xp = 0
    last_activity: str | None = None
    stamped_dates: set[str] = set()

    for date_key in sorted_keys:
        day = normalize_day(merged["history"][date_key])
        goal_minutes = goal_minutes_for_date_key(date_key)
        submission = submission_rollup.get(
            date_key,
            {
                "approved_minutes": 0,
                "pending_minutes": 0,
                "rejected_minutes": 0,
                "approved_count": 0,
                "pending_count": 0,
                "rejected_count": 0,
            },
        )
        approved_minutes = clamp_int(submission["approved_minutes"], 0, 720, 0)
        pending_minutes = clamp_int(submission["pending_minutes"], 0, 720, 0)
        rejected_minutes = clamp_int(submission["rejected_minutes"], 0, 720, 0)
        bonus_info = bonus_rollup.get(date_key, {"reward_total": 0, "approved_count": 0, "pending_count": 0, "latest_title": ""})
        checkin = normalize_checkin(day.get("checkin"))
        combo_days = checkin_combo_days(merged["history"], date_key) if checkin["stamped"] else 0
        reward_xp, combo_bonus_xp = compute_stamp_reward(checkin["rarity"], combo_days, approved_minutes, goal_minutes)
        checkin["comboDays"] = combo_days
        checkin["comboBonusXp"] = combo_bonus_xp
        checkin["rewardXp"] = reward_xp
        day["checkin"] = checkin
        day["segments"] = collapse_minutes_to_segments(approved_minutes)
        day["status"] = {
            "goalMinutes": goal_minutes,
            "approvedMinutes": approved_minutes,
            "pendingMinutes": pending_minutes,
            "rejectedMinutes": rejected_minutes,
            "approvedCount": clamp_int(submission["approved_count"], 0, 10_000, 0),
            "pendingCount": clamp_int(submission["pending_count"], 0, 10_000, 0),
            "rejectedCount": clamp_int(submission["rejected_count"], 0, 10_000, 0),
            "progressState": compute_progress_state(approved_minutes, goal_minutes),
            "rewardState": compute_reward_state(day, approved_minutes, pending_minutes, goal_minutes),
            "bonusReward": clamp_int(bonus_info.get("reward_total"), 0, 1_000_000, 0),
            "bonusApprovedCount": clamp_int(bonus_info.get("approved_count"), 0, 1_000, 0),
            "bonusPendingCount": clamp_int(bonus_info.get("pending_count"), 0, 1_000, 0),
            "bonusLatestTitle": bonus_info.get("latest_title", ""),
        }

        xp = 0
        if approved_minutes > 0:
            xp = compute_study_xp(approved_minutes)
            if any((checkin.get(key, "").strip() for key in ("moodNote", "progressNote"))):
                xp += JOURNAL_XP
            if approved_minutes >= goal_minutes:
                xp += GOAL_BONUS_XP
            if approved_minutes > goal_minutes:
                xp += OVERACHIEVE_BONUS_XP
            xp += reward_xp
        xp += clamp_int(bonus_info.get("reward_total"), 0, 1_000_000, 0)
        day["xpEarned"] = xp
        merged["history"][date_key] = day
        total_xp += xp
        if approved_minutes > 0 or pending_minutes > 0 or checkin["stamped"]:
            last_activity = date_key
        if checkin["stamped"]:
            stamped_dates.add(date_key)

    streak = 0
    if stamped_dates:
        latest = max(stamped_dates, key=lambda item: parse_date_key(item) or date.min)
        cursor = parse_date_key(latest)
        while cursor and cursor.isoformat() in stamped_dates:
            streak += 1
            cursor -= timedelta(days=1)

    merged["totalXp"] = total_xp
    merged["streak"] = streak
    merged["lastDate"] = last_activity
    return merged


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
                "progressState": day.get("status", {}).get("progressState", "locked"),
                "rewardState": day.get("status", {}).get("rewardState", "idle"),
                "bonusReward": clamp_int(day.get("status", {}).get("bonusReward"), 0, 1_000_000, 0),
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
        "lastActiveDate": state.get("lastDate"),
        "totalMinutes": total_minutes,
        "recentDays": recent_days,
    }


class MathQuestApp:
    def __init__(
        self,
        db_path: Path,
        static_dir: Path,
        upload_dir: Path | None = None,
        sync_signal_path: Path | None = None,
        admin_username: str = "admin",
        admin_password: str = "admin123456",
        host: str = "127.0.0.1",
        port: int = 8000,
    ) -> None:
        self.db_path = Path(db_path)
        self.static_dir = Path(static_dir)
        self.index_path = self.static_dir / "index.html"
        self.upload_dir = Path(upload_dir) if upload_dir is not None else self.static_dir / "uploads"
        self.sync_signal_path = Path(sync_signal_path) if sync_signal_path is not None else None
        self.host = host
        self.port = port
        self.admin_username = admin_username
        self.admin_password = admin_password
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        if self.sync_signal_path is not None:
            self.sync_signal_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self._ensure_admin_user()

    def _touch_sync_signal(self) -> None:
        if self.sync_signal_path is None:
            return
        self.sync_signal_path.parent.mkdir(parents=True, exist_ok=True)
        self.sync_signal_path.write_text(utc_now_iso(), encoding="utf-8")

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

                CREATE TABLE IF NOT EXISTS study_submissions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    date_key TEXT NOT NULL,
                    duration_minutes INTEGER NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    evidence_name TEXT NOT NULL,
                    evidence_mime TEXT NOT NULL,
                    evidence_path TEXT NOT NULL,
                    evidence_files_json TEXT NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL DEFAULT 'pending',
                    admin_note TEXT NOT NULL DEFAULT '',
                    reviewed_by INTEGER,
                    reviewed_at TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(reviewed_by) REFERENCES users(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS bonus_tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    difficulty INTEGER NOT NULL DEFAULT 1,
                    target_days INTEGER NOT NULL DEFAULT 3,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_by INTEGER,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS bonus_task_submissions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    completed_date_key TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    evidence_name TEXT NOT NULL,
                    evidence_mime TEXT NOT NULL,
                    evidence_path TEXT NOT NULL,
                    evidence_files_json TEXT NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL DEFAULT 'pending',
                    admin_note TEXT NOT NULL DEFAULT '',
                    reviewed_by INTEGER,
                    reviewed_at TEXT,
                    created_at TEXT NOT NULL,
                    reward_total INTEGER NOT NULL DEFAULT 0,
                    speed_tier TEXT NOT NULL DEFAULT '',
                    speed_multiplier REAL NOT NULL DEFAULT 1.0,
                    FOREIGN KEY(task_id) REFERENCES bonus_tasks(id) ON DELETE CASCADE,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(reviewed_by) REFERENCES users(id) ON DELETE SET NULL
                );
                """
            )
            self._ensure_columns(
                conn,
                "study_submissions",
                {
                    "evidence_files_json": "TEXT NOT NULL DEFAULT '[]'",
                },
            )
            self._ensure_columns(
                conn,
                "bonus_task_submissions",
                {
                    "evidence_files_json": "TEXT NOT NULL DEFAULT '[]'",
                },
            )

    def _ensure_columns(self, conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for name, sql_type in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}")

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
                (self.admin_username, "小和", salt_hex, password_hash, now),
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

    def _load_raw_user_state(self, conn: sqlite3.Connection, user_id: int) -> dict[str, Any]:
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

    def _save_raw_user_state(self, conn: sqlite3.Connection, user_id: int, state: dict[str, Any]) -> dict[str, Any]:
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
        self._touch_sync_signal()
        return normalized

    def _submission_rollup(self, conn: sqlite3.Connection, user_id: int) -> dict[str, dict[str, int]]:
        rows = conn.execute(
            """
            SELECT date_key, status, COALESCE(SUM(duration_minutes), 0) AS minutes, COUNT(*) AS count
            FROM study_submissions
            WHERE user_id = ?
            GROUP BY date_key, status
            """,
            (user_id,),
        ).fetchall()
        return build_submission_rollup(rows)

    def _bonus_reward_rollup(self, conn: sqlite3.Connection, user_id: int) -> dict[str, dict[str, Any]]:
        rows = conn.execute(
            """
            SELECT
                bonus_task_submissions.completed_date_key AS date_key,
                bonus_task_submissions.status,
                bonus_task_submissions.reward_total,
                bonus_tasks.title
            FROM bonus_task_submissions
            JOIN bonus_tasks ON bonus_tasks.id = bonus_task_submissions.task_id
            WHERE bonus_task_submissions.user_id = ?
            """,
            (user_id,),
        ).fetchall()
        return build_bonus_rollup(rows)

    def _hydrate_user_state(self, conn: sqlite3.Connection, user_id: int, state: dict[str, Any]) -> dict[str, Any]:
        return finalize_state(state, self._submission_rollup(conn, user_id), self._bonus_reward_rollup(conn, user_id))

    def _load_user_state(self, conn: sqlite3.Connection, user_id: int) -> dict[str, Any]:
        return self._hydrate_user_state(conn, user_id, self._load_raw_user_state(conn, user_id))

    def _merge_client_state(self, current: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
        merged = normalize_state(current)
        candidate = normalize_state(incoming)
        for date_key, incoming_day in candidate["history"].items():
            existing_day = normalize_day(merged["history"].get(date_key))
            existing_day["tasks"] = incoming_day["tasks"]
            existing_day["journal"] = incoming_day["journal"]
            existing_day["mood"] = incoming_day["mood"]
            existing_day["energy"] = incoming_day["energy"]
            existing_day["rewardShown"] = incoming_day["rewardShown"]
            merged["history"][date_key] = existing_day
        return merged

    def _upsert_checkin(
        self,
        conn: sqlite3.Connection,
        user_id: int,
        date_key: str,
        *,
        mood_note: str = "",
        progress_note: str = "",
    ) -> dict[str, Any]:
        raw_state = self._load_raw_user_state(conn, user_id)
        history = raw_state.setdefault("history", {})
        day = normalize_day(history.get(date_key))
        submission_rollup = self._submission_rollup(conn, user_id)
        today_rollup = submission_rollup.get(date_key, {})
        goal_minutes = goal_minutes_for_date_key(date_key)
        eligible_minutes = clamp_int(today_rollup.get("approved_minutes"), 0, 720, 0) + clamp_int(
            today_rollup.get("pending_minutes"), 0, 720, 0
        )
        if eligible_minutes < goal_minutes:
            raise ValueError("完成当日目标时长对应的学习提交后，才可以盖章")
        if day["checkin"]["stamped"]:
            self._save_raw_user_state(conn, user_id, raw_state)
            return self._hydrate_user_state(conn, user_id, raw_state)

        picked = pick_stamp(history, date_key)

        day["checkin"] = {
            "stamped": True,
            "emoji": picked["emoji"],
            "rarity": picked["rarity"],
            "label": picked["label"],
            "stampedAt": utc_now_iso(),
            "moodNote": mood_note[:120],
            "progressNote": progress_note[:120],
            "comboBonusXp": 0,
            "comboDays": 1,
            "rewardXp": 0,
        }
        day["journal"]["feel"] = mood_note[:200]
        day["journal"]["top"] = progress_note[:200]
        history[date_key] = day
        saved = self._save_raw_user_state(conn, user_id, raw_state)
        return self._hydrate_user_state(conn, user_id, saved)

    def _decode_evidence_payloads(self, body: dict[str, Any]) -> list[dict[str, Any]]:
        raw_items = body.get("evidence_files")
        items = raw_items if isinstance(raw_items, list) and raw_items else None
        if items is None:
            items = [
                {
                    "name": body.get("evidence_name"),
                    "data": body.get("evidence_data"),
                }
            ]
        if not items:
            raise ValueError("每次上传都需要附上凭证")
        if len(items) > MAX_EVIDENCE_FILES:
            raise ValueError(f"一次最多上传 {MAX_EVIDENCE_FILES} 个凭证文件")

        attachments: list[dict[str, Any]] = []
        for index, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                raise ValueError(f"第 {index} 个凭证格式不对")
            evidence_data = item.get("data")
            evidence_name = str(item.get("name", "")).strip() or f"evidence-{index}"
            if not isinstance(evidence_data, str) or not evidence_data.startswith("data:") or ";base64," not in evidence_data:
                raise ValueError(f"第 {index} 个凭证必须以 base64 data URL 上传")
            header, encoded = evidence_data.split(",", 1)
            mime = header[5:].split(";")[0].strip() or "application/octet-stream"
            try:
                payload = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ValueError(f"第 {index} 个凭证文件编码无效") from exc
            if not payload:
                raise ValueError(f"第 {index} 个凭证不能为空")
            if len(payload) > MAX_EVIDENCE_BYTES:
                raise ValueError(f"第 {index} 个凭证大小不能超过 5MB")
            attachments.append(
                {
                    "name": evidence_name[:120],
                    "mime": mime[:120],
                    "payload": payload,
                }
            )
        return attachments

    def _decode_evidence_payload(self, body: dict[str, Any]) -> tuple[bytes, str, str]:
        item = self._decode_evidence_payloads(body)[0]
        return item["payload"], item["name"], item["mime"]

    def _store_evidence_file(self, payload: bytes, evidence_name: str, mime: str) -> str:
        suffix = Path(evidence_name).suffix
        if not suffix:
            suffix = mimetypes.guess_extension(mime) or ".bin"
        filename = f"{secrets.token_hex(16)}{suffix}"
        path = self.upload_dir / filename
        path.write_bytes(payload)
        return filename

    def _store_evidence_files(self, attachments: list[dict[str, Any]]) -> list[dict[str, str]]:
        stored: list[dict[str, str]] = []
        for item in attachments:
            stored.append(
                {
                    "name": item["name"],
                    "mime": item["mime"],
                    "path": self._store_evidence_file(item["payload"], item["name"], item["mime"]),
                }
            )
        return stored

    def _evidence_files_from_row(self, row: sqlite3.Row, kind: str) -> list[dict[str, str]]:
        raw = row["evidence_files_json"] if "evidence_files_json" in row.keys() else "[]"
        try:
            parsed = json.loads(raw or "[]")
        except json.JSONDecodeError:
            parsed = []
        files: list[dict[str, str]] = []
        if isinstance(parsed, list):
            for index, item in enumerate(parsed):
                if not isinstance(item, dict):
                    continue
                name = item.get("name")
                mime = item.get("mime")
                path = item.get("path")
                if not isinstance(name, str) or not isinstance(mime, str) or not isinstance(path, str):
                    continue
                files.append(
                    {
                        "name": name,
                        "mime": mime,
                        "url": f"/api/{kind}/{row['id']}/evidence/{index}",
                    }
                )
        if not files:
            files.append(
                {
                    "name": row["evidence_name"],
                    "mime": row["evidence_mime"],
                    "url": f"/api/{kind}/{row['id']}/evidence/0",
                }
            )
        return files

    def _evidence_file_payload_from_row(self, row: sqlite3.Row, index: int) -> tuple[Path, str, str]:
        raw = row["evidence_files_json"] if "evidence_files_json" in row.keys() else "[]"
        try:
            parsed = json.loads(raw or "[]")
        except json.JSONDecodeError:
            parsed = []
        if isinstance(parsed, list) and parsed:
            valid = [item for item in parsed if isinstance(item, dict)]
            if 0 <= index < len(valid):
                item = valid[index]
                return self.upload_dir / str(item.get("path", "")), str(item.get("mime", "")), str(item.get("name", "proof"))
        if index != 0:
            raise IndexError("凭证文件不存在")
        return self.upload_dir / row["evidence_path"], row["evidence_mime"], row["evidence_name"]

    def _format_submission(self, row: sqlite3.Row, include_user: bool = False) -> dict[str, Any]:
        evidence_files = self._evidence_files_from_row(row, "submissions")
        item = {
            "id": row["id"],
            "user_id": row["user_id"],
            "date_key": row["date_key"],
            "duration_minutes": row["duration_minutes"],
            "note": row["note"],
            "status": row["status"],
            "admin_note": row["admin_note"],
            "created_at": row["created_at"],
            "reviewed_at": row["reviewed_at"],
            "evidence_name": row["evidence_name"],
            "evidence_mime": row["evidence_mime"],
            "evidence_url": evidence_files[0]["url"],
            "evidence_files": evidence_files,
        }
        if include_user:
            item["user"] = {
                "id": row["user_id"],
                "username": row["username"],
                "display_name": row["display_name"],
                "is_admin": bool(row["is_admin"]),
            }
        return item

    def _format_bonus_task(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "title": row["title"],
            "description": row["description"],
            "difficulty": row["difficulty"],
            "target_days": row["target_days"],
            "active": bool(row["active"]),
            "created_at": row["created_at"],
        }

    def _format_bonus_submission(self, row: sqlite3.Row, include_user: bool = False) -> dict[str, Any]:
        evidence_files = self._evidence_files_from_row(row, "bonus-task-submissions")
        item = {
            "id": row["id"],
            "task_id": row["task_id"],
            "user_id": row["user_id"],
            "completed_date_key": row["completed_date_key"],
            "note": row["note"],
            "status": row["status"],
            "admin_note": row["admin_note"],
            "created_at": row["created_at"],
            "reviewed_at": row["reviewed_at"],
            "reward_total": row["reward_total"],
            "speed_tier": row["speed_tier"],
            "speed_multiplier": row["speed_multiplier"],
            "evidence_name": row["evidence_name"],
            "evidence_mime": row["evidence_mime"],
            "evidence_url": evidence_files[0]["url"],
            "evidence_files": evidence_files,
            "task": {
                "id": row["task_id"],
                "title": row["title"],
                "description": row["description"],
                "difficulty": row["difficulty"],
                "target_days": row["target_days"],
                "active": bool(row["active"]),
            },
        }
        if include_user:
            item["user"] = {
                "id": row["user_id"],
                "username": row["username"],
                "display_name": row["display_name"],
                "is_admin": bool(row["is_admin"]),
            }
        return item

    def _list_submissions(
        self,
        conn: sqlite3.Connection,
        *,
        user_id: int | None = None,
        status: str | None = None,
        include_user: bool = False,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        sql = [
            """
            SELECT study_submissions.*,
                   users.username,
                   users.display_name,
                   users.is_admin
            FROM study_submissions
            JOIN users ON users.id = study_submissions.user_id
            WHERE 1 = 1
            """
        ]
        params: list[Any] = []
        if user_id is not None:
            sql.append("AND study_submissions.user_id = ?")
            params.append(user_id)
        if status is not None:
            sql.append("AND study_submissions.status = ?")
            params.append(status)
        sql.append("ORDER BY study_submissions.created_at DESC, study_submissions.id DESC LIMIT ?")
        params.append(limit)
        rows = conn.execute("\n".join(sql), params).fetchall()
        return [self._format_submission(row, include_user=include_user) for row in rows]

    def _list_bonus_tasks(self, conn: sqlite3.Connection, *, active_only: bool = False) -> list[dict[str, Any]]:
        sql = ["SELECT * FROM bonus_tasks WHERE 1 = 1"]
        params: list[Any] = []
        if active_only:
            sql.append("AND active = 1")
        sql.append("ORDER BY active DESC, created_at DESC, id DESC")
        rows = conn.execute("\n".join(sql), params).fetchall()
        return [self._format_bonus_task(row) for row in rows]

    def _list_bonus_submissions(
        self,
        conn: sqlite3.Connection,
        *,
        user_id: int | None = None,
        status: str | None = None,
        include_user: bool = False,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        sql = [
            """
            SELECT
                bonus_task_submissions.*,
                bonus_tasks.title,
                bonus_tasks.description,
                bonus_tasks.difficulty,
                bonus_tasks.target_days,
                bonus_tasks.active,
                users.username,
                users.display_name,
                users.is_admin
            FROM bonus_task_submissions
            JOIN bonus_tasks ON bonus_tasks.id = bonus_task_submissions.task_id
            JOIN users ON users.id = bonus_task_submissions.user_id
            WHERE 1 = 1
            """
        ]
        params: list[Any] = []
        if user_id is not None:
            sql.append("AND bonus_task_submissions.user_id = ?")
            params.append(user_id)
        if status is not None:
            sql.append("AND bonus_task_submissions.status = ?")
            params.append(status)
        sql.append("ORDER BY bonus_task_submissions.created_at DESC, bonus_task_submissions.id DESC LIMIT ?")
        params.append(limit)
        rows = conn.execute("\n".join(sql), params).fetchall()
        return [self._format_bonus_submission(row, include_user=include_user) for row in rows]

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

    def _serve_index(self, handler: BaseHTTPRequestHandler) -> None:
        if not self.index_path.exists():
            self._send_json(handler, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "找不到前端页面"})
            return
        self._serve_static_file(handler, "/index.html")

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
                        app._serve_index(self)
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
                    if path == "/api/submissions/mine":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        with app._connect() as conn:
                            submissions = app._list_submissions(conn, user_id=user["id"], limit=100)
                        app._send_json(self, HTTPStatus.OK, {"submissions": submissions})
                        return
                    if path == "/api/bonus-tasks":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        with app._connect() as conn:
                            tasks = app._list_bonus_tasks(conn, active_only=not bool(user["is_admin"]))
                            submissions = app._list_bonus_submissions(conn, user_id=None if user["is_admin"] else user["id"], include_user=bool(user["is_admin"]), limit=100)
                            state = app._load_user_state(conn, user["id"])
                        app._send_json(self, HTTPStatus.OK, {"tasks": tasks, "submissions": submissions, "state": state})
                        return
                    if path.startswith("/api/submissions/") and "/evidence" in path:
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        parts = path.strip("/").split("/")
                        if len(parts) not in {4, 5} or parts[3] != "evidence":
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
                            return
                        try:
                            submission_id = int(parts[2])
                        except ValueError:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "提交 ID 无效"})
                            return
                        attachment_index = 0
                        if len(parts) == 5:
                            try:
                                attachment_index = int(parts[4])
                            except ValueError:
                                app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "凭证编号无效"})
                                return

                        with app._connect() as conn:
                            row = conn.execute(
                                "SELECT * FROM study_submissions WHERE id = ?",
                                (submission_id,),
                            ).fetchone()
                        if row is None:
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "提交不存在"})
                            return
                        if row["user_id"] != user["id"] and not user["is_admin"]:
                            app._send_json(self, HTTPStatus.FORBIDDEN, {"error": "无权查看该凭证"})
                            return

                        try:
                            evidence_path, evidence_mime, evidence_name = app._evidence_file_payload_from_row(row, attachment_index)
                        except IndexError:
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "凭证文件不存在"})
                            return
                        if not evidence_path.exists():
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "凭证文件不存在"})
                            return

                        payload = evidence_path.read_bytes()
                        self.send_response(HTTPStatus.OK)
                        self.send_header("Content-Type", evidence_mime or "application/octet-stream")
                        self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{quote(evidence_name)}")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                        return
                    if path.startswith("/api/bonus-task-submissions/") and "/evidence" in path:
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        parts = path.strip("/").split("/")
                        if len(parts) not in {4, 5} or parts[3] != "evidence":
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
                            return
                        try:
                            submission_id = int(parts[2])
                        except ValueError:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "提交 ID 无效"})
                            return
                        attachment_index = 0
                        if len(parts) == 5:
                            try:
                                attachment_index = int(parts[4])
                            except ValueError:
                                app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "凭证编号无效"})
                                return
                        with app._connect() as conn:
                            row = conn.execute("SELECT * FROM bonus_task_submissions WHERE id = ?", (submission_id,)).fetchone()
                        if row is None:
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "提交不存在"})
                            return
                        if row["user_id"] != user["id"] and not user["is_admin"]:
                            app._send_json(self, HTTPStatus.FORBIDDEN, {"error": "无权查看该凭证"})
                            return
                        try:
                            evidence_path, evidence_mime, evidence_name = app._evidence_file_payload_from_row(row, attachment_index)
                        except IndexError:
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "凭证文件不存在"})
                            return
                        if not evidence_path.exists():
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "凭证文件不存在"})
                            return
                        payload = evidence_path.read_bytes()
                        self.send_response(HTTPStatus.OK)
                        self.send_header("Content-Type", evidence_mime or "application/octet-stream")
                        self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{quote(evidence_name)}")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
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
                            pending_rows = conn.execute(
                                "SELECT user_id, COUNT(*) AS count FROM study_submissions WHERE status = 'pending' GROUP BY user_id"
                            ).fetchall()
                            pending_counts = {row["user_id"]: row["count"] for row in pending_rows}
                            rows = conn.execute(
                                """
                                SELECT users.*, user_states.state_json
                                FROM users
                                LEFT JOIN user_states ON user_states.user_id = users.id
                                WHERE users.is_admin = 0
                                ORDER BY users.created_at ASC
                                """
                            ).fetchall()

                        users = []
                        for row in rows:
                            with app._connect() as detail_conn:
                                state = app._load_user_state(detail_conn, row["id"])
                            summary = summarize_state(state)
                            users.append(
                                {
                                    "user": app._public_user(row),
                                    "summary": {key: value for key, value in summary.items() if key != "recentDays"},
                                    "recent_days": summary["recentDays"],
                                    "pending_count": pending_counts.get(row["id"], 0),
                                }
                            )
                        app._send_json(self, HTTPStatus.OK, {"users": users})
                        return
                    if path.startswith("/api/admin/users/"):
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        if not user["is_admin"]:
                            app._send_json(self, HTTPStatus.FORBIDDEN, {"error": "需要管理员权限"})
                            return
                        try:
                            target_id = int(path.rsplit("/", 1)[-1])
                        except ValueError:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "用户 ID 无效"})
                            return

                        with app._connect() as conn:
                            row = conn.execute(
                                """
                                SELECT users.*, user_states.state_json
                                FROM users
                                LEFT JOIN user_states ON user_states.user_id = users.id
                                WHERE users.id = ?
                                """,
                                (target_id,),
                            ).fetchone()

                        if row is None:
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "用户不存在"})
                            return

                        with app._connect() as conn:
                            state = app._load_user_state(conn, row["id"])
                            submissions = app._list_submissions(conn, user_id=row["id"], limit=30)
                            bonus_submissions = app._list_bonus_submissions(conn, user_id=row["id"], include_user=True, limit=30)
                        app._send_json(
                            self,
                            HTTPStatus.OK,
                            {
                                "user": app._public_user(row),
                                "summary": summarize_state(state),
                                "state": state,
                                "submissions": submissions,
                                "bonus_submissions": bonus_submissions,
                            },
                        )
                        return

                    if path == "/api/admin/bonus-tasks":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        if not user["is_admin"]:
                            app._send_json(self, HTTPStatus.FORBIDDEN, {"error": "需要管理员权限"})
                            return
                        with app._connect() as conn:
                            tasks = app._list_bonus_tasks(conn, active_only=False)
                            submissions = app._list_bonus_submissions(conn, include_user=True, limit=100)
                        app._send_json(self, HTTPStatus.OK, {"tasks": tasks, "submissions": submissions})
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
                            app._touch_sync_signal()
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

                    if path == "/api/submissions":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        body = app._read_json(self)
                        date_key = normalize_date_key(body.get("date_key"))
                        duration_minutes = clamp_int(body.get("duration_minutes"), 1, 720, 0)
                        note = str(body.get("note", "")).strip()[:500]
                        if duration_minutes <= 0:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "学习时长至少 1 分钟"})
                            return
                        evidence_files = app._store_evidence_files(app._decode_evidence_payloads(body))
                        primary_file = evidence_files[0]
                        now = utc_now_iso()
                        with app._connect() as conn:
                            cur = conn.execute(
                                """
                                INSERT INTO study_submissions (
                                    user_id, date_key, duration_minutes, note, evidence_name, evidence_mime, evidence_path, evidence_files_json, status, created_at
                                )
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                                """,
                                (
                                    user["id"],
                                    date_key,
                                    duration_minutes,
                                    note,
                                    primary_file["name"],
                                    primary_file["mime"],
                                    primary_file["path"],
                                    json.dumps(evidence_files, ensure_ascii=False),
                                    now,
                                ),
                            )
                            app._touch_sync_signal()
                            row = conn.execute(
                                """
                                SELECT study_submissions.*, users.username, users.display_name, users.is_admin
                                FROM study_submissions
                                JOIN users ON users.id = study_submissions.user_id
                                WHERE study_submissions.id = ?
                                """,
                                (cur.lastrowid,),
                            ).fetchone()
                        app._send_json(self, HTTPStatus.CREATED, {"submission": app._format_submission(row)})
                        return

                    if path == "/api/checkin":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        if user["is_admin"]:
                            app._send_json(self, HTTPStatus.FORBIDDEN, {"error": "小和不会在这里签到"})
                            return
                        body = app._read_json(self)
                        date_key = normalize_date_key(body.get("date_key"))
                        with app._connect() as conn:
                            state = app._upsert_checkin(
                                conn,
                                user["id"],
                                date_key,
                                mood_note=str(body.get("mood_note", "")).strip()[:120],
                                progress_note=str(body.get("progress_note", "")).strip()[:120],
                            )
                        day = state["history"].get(date_key, default_day())
                        app._send_json(
                            self,
                            HTTPStatus.OK,
                            {
                                "message": "签到成功",
                                "date_key": date_key,
                                "checkin": day["checkin"],
                                "state": state,
                            },
                        )
                        return

                    if path == "/api/bonus-task-submissions":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        if user["is_admin"]:
                            app._send_json(self, HTTPStatus.FORBIDDEN, {"error": "小和不会在这里提交附加任务"})
                            return
                        body = app._read_json(self)
                        task_id = clamp_int(body.get("task_id"), 1, 10_000_000, 0)
                        note = str(body.get("note", "")).strip()[:500]
                        completed_date_key = normalize_date_key(body.get("completed_date_key"))
                        evidence_files = app._store_evidence_files(app._decode_evidence_payloads(body))
                        primary_file = evidence_files[0]
                        now = utc_now_iso()
                        with app._connect() as conn:
                            state = app._load_user_state(conn, user["id"])
                            day = normalize_day(state["history"].get(completed_date_key))
                            if not day["checkin"]["stamped"]:
                                app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "盖章之后才会解锁附加任务"})
                                return
                            task = conn.execute("SELECT * FROM bonus_tasks WHERE id = ? AND active = 1", (task_id,)).fetchone()
                            if task is None:
                                app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "附加任务不存在"})
                                return
                            cur = conn.execute(
                                """
                                INSERT INTO bonus_task_submissions (
                                    task_id, user_id, completed_date_key, note, evidence_name, evidence_mime, evidence_path, evidence_files_json, status, created_at
                                )
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                                """,
                                (
                                    task_id,
                                    user["id"],
                                    completed_date_key,
                                    note,
                                    primary_file["name"],
                                    primary_file["mime"],
                                    primary_file["path"],
                                    json.dumps(evidence_files, ensure_ascii=False),
                                    now,
                                ),
                            )
                            app._touch_sync_signal()
                            row = conn.execute(
                                """
                                SELECT
                                    bonus_task_submissions.*,
                                    bonus_tasks.title,
                                    bonus_tasks.description,
                                    bonus_tasks.difficulty,
                                    bonus_tasks.target_days,
                                    bonus_tasks.active,
                                    users.username,
                                    users.display_name,
                                    users.is_admin
                                FROM bonus_task_submissions
                                JOIN bonus_tasks ON bonus_tasks.id = bonus_task_submissions.task_id
                                JOIN users ON users.id = bonus_task_submissions.user_id
                                WHERE bonus_task_submissions.id = ?
                                """,
                                (cur.lastrowid,),
                            ).fetchone()
                        app._send_json(self, HTTPStatus.CREATED, {"submission": app._format_bonus_submission(row)})
                        return

                    if path == "/api/admin/bonus-tasks":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        if not user["is_admin"]:
                            app._send_json(self, HTTPStatus.FORBIDDEN, {"error": "需要管理员权限"})
                            return
                        body = app._read_json(self)
                        title = str(body.get("title", "")).strip()[:80]
                        description = str(body.get("description", "")).strip()[:500]
                        difficulty = clamp_int(body.get("difficulty"), 1, 5, 1)
                        target_days = clamp_int(body.get("target_days"), 1, 30, 3)
                        if not title:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "附加任务要有标题"})
                            return
                        now = utc_now_iso()
                        with app._connect() as conn:
                            cur = conn.execute(
                                """
                                INSERT INTO bonus_tasks (title, description, difficulty, target_days, active, created_by, created_at)
                                VALUES (?, ?, ?, ?, 1, ?, ?)
                                """,
                                (title, description, difficulty, target_days, user["id"], now),
                            )
                            app._touch_sync_signal()
                            row = conn.execute("SELECT * FROM bonus_tasks WHERE id = ?", (cur.lastrowid,)).fetchone()
                        app._send_json(self, HTTPStatus.CREATED, {"task": app._format_bonus_task(row)})
                        return

                    if path.startswith("/api/admin/submissions/") and path.endswith("/review"):
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        if not user["is_admin"]:
                            app._send_json(self, HTTPStatus.FORBIDDEN, {"error": "需要管理员权限"})
                            return
                        parts = path.strip("/").split("/")
                        if len(parts) != 5:
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
                            return
                        try:
                            submission_id = int(parts[3])
                        except ValueError:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "提交 ID 无效"})
                            return
                        body = app._read_json(self)
                        action = str(body.get("action", "")).strip().lower()
                        if action not in {"approve", "reject"}:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "action 只能是 approve 或 reject"})
                            return
                        status_value = "approved" if action == "approve" else "rejected"
                        admin_note = str(body.get("admin_note", "")).strip()[:500]
                        reviewed_at = utc_now_iso()
                        with app._connect() as conn:
                            exists = conn.execute("SELECT id FROM study_submissions WHERE id = ?", (submission_id,)).fetchone()
                            if not exists:
                                app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "提交不存在"})
                                return
                            conn.execute(
                                """
                                UPDATE study_submissions
                                SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ?
                                WHERE id = ?
                                """,
                                (status_value, admin_note, user["id"], reviewed_at, submission_id),
                            )
                            app._touch_sync_signal()
                            row = conn.execute(
                                """
                                SELECT study_submissions.*, users.username, users.display_name, users.is_admin
                                FROM study_submissions
                                JOIN users ON users.id = study_submissions.user_id
                                WHERE study_submissions.id = ?
                                """,
                                (submission_id,),
                            ).fetchone()
                        app._send_json(self, HTTPStatus.OK, {"submission": app._format_submission(row, include_user=True)})
                        return

                    if path.startswith("/api/admin/bonus-task-submissions/") and path.endswith("/review"):
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        if not user["is_admin"]:
                            app._send_json(self, HTTPStatus.FORBIDDEN, {"error": "需要管理员权限"})
                            return
                        parts = path.strip("/").split("/")
                        if len(parts) != 5:
                            app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
                            return
                        try:
                            submission_id = int(parts[3])
                        except ValueError:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "提交 ID 无效"})
                            return
                        body = app._read_json(self)
                        action = str(body.get("action", "")).strip().lower()
                        if action not in {"approve", "reject"}:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "action 只能是 approve 或 reject"})
                            return
                        admin_note = str(body.get("admin_note", "")).strip()[:500]
                        reviewed_at = utc_now_iso()
                        with app._connect() as conn:
                            row = conn.execute(
                                """
                                SELECT bonus_task_submissions.*, bonus_tasks.difficulty, bonus_tasks.target_days, bonus_tasks.created_at AS task_created_at
                                FROM bonus_task_submissions
                                JOIN bonus_tasks ON bonus_tasks.id = bonus_task_submissions.task_id
                                WHERE bonus_task_submissions.id = ?
                                """,
                                (submission_id,),
                            ).fetchone()
                            if row is None:
                                app._send_json(self, HTTPStatus.NOT_FOUND, {"error": "提交不存在"})
                                return
                            reward_total = 0
                            speed_tier = ""
                            speed_multiplier = 1.0
                            status_value = "approved" if action == "approve" else "rejected"
                            if status_value == "approved":
                                reward_total, speed_tier, speed_multiplier = compute_bonus_reward(
                                    row["difficulty"],
                                    row["target_days"],
                                    row["task_created_at"],
                                    row["created_at"],
                                )
                            conn.execute(
                                """
                                UPDATE bonus_task_submissions
                                SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ?, reward_total = ?, speed_tier = ?, speed_multiplier = ?
                                WHERE id = ?
                                """,
                                (
                                    status_value,
                                    admin_note,
                                    user["id"],
                                    reviewed_at,
                                    reward_total,
                                    speed_tier,
                                    speed_multiplier,
                                    submission_id,
                                ),
                            )
                            app._touch_sync_signal()
                            refreshed = conn.execute(
                                """
                                SELECT
                                    bonus_task_submissions.*,
                                    bonus_tasks.title,
                                    bonus_tasks.description,
                                    bonus_tasks.difficulty,
                                    bonus_tasks.target_days,
                                    bonus_tasks.active,
                                    users.username,
                                    users.display_name,
                                    users.is_admin
                                FROM bonus_task_submissions
                                JOIN bonus_tasks ON bonus_tasks.id = bonus_task_submissions.task_id
                                JOIN users ON users.id = bonus_task_submissions.user_id
                                WHERE bonus_task_submissions.id = ?
                                """,
                                (submission_id,),
                            ).fetchone()
                        app._send_json(self, HTTPStatus.OK, {"submission": app._format_bonus_submission(refreshed, include_user=True)})
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
                    if path == "/api/me":
                        user = app._auth_user(self)
                        if not user:
                            app._send_json(self, HTTPStatus.UNAUTHORIZED, {"error": "未登录"})
                            return
                        body = app._read_json(self)
                        display_name = str(body.get("display_name", "")).strip()
                        current_password = str(body.get("current_password", ""))
                        new_password = str(body.get("new_password", ""))
                        updates: list[tuple[str, Any]] = []
                        params: list[Any] = []

                        if display_name:
                            if len(display_name) > 32:
                                app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "昵称最长 32 个字符"})
                                return
                            updates.append(("display_name = ?", display_name))
                            params.append(display_name)

                        if new_password:
                            if len(new_password) < PASSWORD_MIN_LENGTH:
                                app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": f"新密码至少 {PASSWORD_MIN_LENGTH} 位"})
                                return
                            if not current_password:
                                app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "修改密码需要输入当前密码"})
                                return
                            if not app._verify_password(current_password, user["password_salt"], user["password_hash"]):
                                app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "当前密码不正确"})
                                return
                            salt_hex, password_hash = app._hash_password(new_password)
                            updates.append(("password_salt = ?", salt_hex))
                            params.append(salt_hex)
                            updates.append(("password_hash = ?", password_hash))
                            params.append(password_hash)

                        if not updates:
                            app._send_json(self, HTTPStatus.BAD_REQUEST, {"error": "没有可更新的内容"})
                            return

                        with app._connect() as conn:
                            sql = f"UPDATE users SET {', '.join(part for part, _ in updates)} WHERE id = ?"
                            conn.execute(sql, [*params, user["id"]])
                            app._touch_sync_signal()
                            updated = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
                        app._send_json(self, HTTPStatus.OK, {"message": "账号信息已更新", "user": app._public_user(updated)})
                        return

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
                            current = app._load_raw_user_state(conn, user["id"])
                            merged = app._merge_client_state(current, body["state"])
                            app._save_raw_user_state(conn, user["id"], merged)
                            state = app._hydrate_user_state(conn, user["id"], merged)
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
        upload_dir=root / "uploads",
        admin_username=args.admin_user,
        admin_password=args.admin_password,
        host=args.host,
        port=args.port,
    )
    server = app.create_server()
    print(f"Math Quest server running on http://{args.host}:{args.port}")
    print(f"管理员账号已初始化: {args.admin_user}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

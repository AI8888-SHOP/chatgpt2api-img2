from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_FILE = DATA_DIR / "users.db"
LEGACY_JSON_FILE = DATA_DIR / "users.json"
TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
MAX_IMAGE_CONVERSATION_PAYLOAD_BYTES = 128 * 1024
MAX_IMAGE_CONVERSATION_PROMPT_CHARS = 8000
MAX_IMAGE_CONVERSATION_IMAGES = 12
MAX_IMAGE_CONVERSATION_REFERENCE_IMAGES = 8
QUOTA_RESERVATION_TTL_SECONDS = 15 * 60


def _now() -> int:
    return int(time.time())


def _hash_value(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _hash_password(password: str, salt: str | None = None) -> str:
    password = str(password or "")
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"pbkdf2_sha256${salt}${digest.hex()}"


def _verify_password(password: str, password_hash: str) -> bool:
    try:
        algorithm, salt, expected = str(password_hash or "").split("$", 2)
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    candidate = _hash_password(password, salt)
    return hmac.compare_digest(candidate, f"{algorithm}${salt}${expected}")


def _row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


@dataclass
class User:
    id: str
    email: str
    password_hash: str = ""
    quota: int = 0
    total_usage: int = 0
    total_redeemed: int = 0
    created_at: int = 0
    updated_at: int = 0
    enabled: bool = True

    @property
    def key(self) -> str:
        return self.id

    @property
    def name(self) -> str:
        return self.email

    def remaining(self) -> int:
        return max(0, int(self.quota or 0))

    def to_public_dict(self) -> dict:
        return {
            "id": self.id,
            "email": self.email,
            "quota": self.remaining(),
            "total_usage": self.total_usage,
            "total_redeemed": self.total_redeemed,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "enabled": bool(self.enabled),
        }


class UserService:
    def __init__(self, db_file: Path = DB_FILE):
        self.db_file = db_file
        self._lock = RLock()
        self._init_db()
        self._migrate_legacy_json()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_file, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_db(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    quota INTEGER NOT NULL DEFAULT 0,
                    total_usage INTEGER NOT NULL DEFAULT 0,
                    total_redeemed INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS user_sessions (
                    session_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS user_api_keys (
                    key TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL DEFAULT '',
                    secret_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_used_at INTEGER NOT NULL DEFAULT 0,
                    enabled INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS user_quota_ledger (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    amount INTEGER NOT NULL,
                    balance_after INTEGER NOT NULL,
                    reason TEXT NOT NULL DEFAULT '',
                    reference TEXT NOT NULL DEFAULT '',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS user_image_conversations (
                    id TEXT NOT NULL,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    payload TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (id, user_id)
                );

                CREATE TABLE IF NOT EXISTS redeemed_codes (
                    code TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    amount INTEGER NOT NULL,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    redeemed_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS user_quota_reservations (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    amount INTEGER NOT NULL,
                    action TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS email_verification_codes (
                    email TEXT PRIMARY KEY,
                    code_hash TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    sent_at INTEGER NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS user_invite_codes (
                    code TEXT PRIMARY KEY,
                    inviter_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS user_invite_rewards (
                    id TEXT PRIMARY KEY,
                    inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    invited_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                    code TEXT NOT NULL,
                    inviter_amount INTEGER NOT NULL,
                    invited_amount INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
                CREATE INDEX IF NOT EXISTS idx_user_api_keys_user_id ON user_api_keys(user_id);
                CREATE INDEX IF NOT EXISTS idx_user_quota_ledger_user_id ON user_quota_ledger(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_user_image_conversations_user_id ON user_image_conversations(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_redeemed_codes_user_id ON redeemed_codes(user_id, redeemed_at DESC);
                CREATE INDEX IF NOT EXISTS idx_user_quota_reservations_status ON user_quota_reservations(status, created_at);
                CREATE INDEX IF NOT EXISTS idx_email_verification_codes_expires_at ON email_verification_codes(expires_at);
                CREATE INDEX IF NOT EXISTS idx_user_invite_rewards_inviter_id ON user_invite_rewards(inviter_id, created_at DESC);
                """
            )

    def _migrate_legacy_json(self) -> None:
        if not LEGACY_JSON_FILE.exists():
            return
        try:
            with self._connect() as conn:
                existing = int(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0])
                if existing > 0:
                    return
                with open(LEGACY_JSON_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                items = data.values() if isinstance(data, dict) else data
                now = _now()
                for values in items:
                    if not isinstance(values, dict):
                        continue
                    user_id = str(values.get("id") or uuid.uuid4().hex)
                    email = str(values.get("email") or "").strip().lower()
                    password_hash = str(values.get("password_hash") or "")
                    if not email or not password_hash:
                        continue
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO users
                            (id, email, password_hash, quota, total_usage, total_redeemed, created_at, updated_at, enabled)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            user_id,
                            email,
                            password_hash,
                            int(values.get("quota") or 0),
                            int(values.get("total_usage") or 0),
                            int(values.get("total_redeemed") or 0),
                            int(values.get("created_at") or now),
                            int(values.get("updated_at") or now),
                            1 if values.get("enabled", True) else 0,
                        ),
                    )
                    session_hash = str(values.get("session_hash") or "")
                    if session_hash:
                        conn.execute(
                            "INSERT OR IGNORE INTO user_sessions (session_hash, user_id, created_at) VALUES (?, ?, ?)",
                            (session_hash, user_id, int(values.get("session_created_at") or now)),
                        )
        except Exception as exc:
            print(f"[user_service] failed to migrate legacy users: {exc}")

    def _user_from_row(self, row: sqlite3.Row | None) -> User | None:
        data = _row_to_dict(row)
        if not data:
            return None
        data["enabled"] = bool(data.get("enabled"))
        return User(**data)

    def _insert_quota_ledger(
        self,
        conn: sqlite3.Connection,
        *,
        user_id: str,
        amount: int,
        balance_after: int,
        reason: str,
        reference: str = "",
        metadata: dict[str, Any] | None = None,
        created_at: int | None = None,
    ) -> None:
        if int(amount or 0) == 0:
            return
        conn.execute(
            """
            INSERT INTO user_quota_ledger
                (id, user_id, amount, balance_after, reason, reference, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                uuid.uuid4().hex,
                user_id,
                int(amount),
                max(0, int(balance_after or 0)),
                str(reason or ""),
                str(reference or ""),
                json.dumps(metadata or {}, ensure_ascii=False, separators=(",", ":")),
                int(created_at or _now()),
            ),
        )

    def register(self, email: str, password: str, default_quota: int = 0, *, quota_reason: str = "register_bonus") -> User:
        normalized_email = str(email or "").strip().lower()
        password = str(password or "")
        if "@" not in normalized_email or "." not in normalized_email.rsplit("@", 1)[-1]:
            raise ValueError("请输入有效邮箱")
        if len(password) < 6:
            raise ValueError("密码至少 6 位")
        with self._lock, self._connect() as conn:
            if conn.execute("SELECT 1 FROM users WHERE email = ?", (normalized_email,)).fetchone():
                raise ValueError("邮箱已注册")
            now = _now()
            user = User(
                id=uuid.uuid4().hex,
                email=normalized_email,
                password_hash=_hash_password(password),
                quota=max(0, int(default_quota or 0)),
                total_redeemed=max(0, int(default_quota or 0)),
                created_at=now,
                updated_at=now,
                enabled=True,
            )
            conn.execute(
                """
                INSERT INTO users (id, email, password_hash, quota, total_usage, total_redeemed, created_at, updated_at, enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user.id,
                    user.email,
                    user.password_hash,
                    user.quota,
                    user.total_usage,
                    user.total_redeemed,
                    user.created_at,
                    user.updated_at,
                    1,
                ),
            )
            self._insert_quota_ledger(
                conn,
                user_id=user.id,
                amount=user.quota,
                balance_after=user.quota,
                reason=quota_reason,
                metadata={"email": user.email},
                created_at=now,
            )
            return user

    def create_email_verification_code(self, email: str, code: str, ttl_seconds: int = 600) -> None:
        normalized_email = str(email or "").strip().lower()
        if "@" not in normalized_email or "." not in normalized_email.rsplit("@", 1)[-1]:
            raise ValueError("请输入有效邮箱")
        now = _now()
        with self._lock, self._connect() as conn:
            current = conn.execute("SELECT sent_at FROM email_verification_codes WHERE email = ?", (normalized_email,)).fetchone()
            if current and now - int(current["sent_at"] or 0) < 60:
                raise ValueError("验证码发送过于频繁，请稍后再试")
            conn.execute("DELETE FROM email_verification_codes WHERE expires_at < ?", (now,))
            conn.execute(
                """
                INSERT INTO email_verification_codes (email, code_hash, expires_at, sent_at, attempts)
                VALUES (?, ?, ?, ?, 0)
                ON CONFLICT(email) DO UPDATE SET
                    code_hash = excluded.code_hash,
                    expires_at = excluded.expires_at,
                    sent_at = excluded.sent_at,
                    attempts = 0
                """,
                (normalized_email, _hash_value(str(code or "")), now + max(60, int(ttl_seconds or 600)), now),
            )

    def verify_email_code(self, email: str, code: str) -> None:
        normalized_email = str(email or "").strip().lower()
        candidate = str(code or "").strip()
        if not candidate:
            raise ValueError("请输入邮箱验证码")
        now = _now()
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM email_verification_codes WHERE email = ?", (normalized_email,)).fetchone()
            if not row:
                raise ValueError("请先获取邮箱验证码")
            if int(row["expires_at"] or 0) < now:
                conn.execute("DELETE FROM email_verification_codes WHERE email = ?", (normalized_email,))
                raise ValueError("邮箱验证码已过期")
            attempts = int(row["attempts"] or 0)
            if attempts >= 5:
                conn.execute("DELETE FROM email_verification_codes WHERE email = ?", (normalized_email,))
                raise ValueError("验证码错误次数过多，请重新获取")
            if not hmac.compare_digest(str(row["code_hash"] or ""), _hash_value(candidate)):
                conn.execute(
                    "UPDATE email_verification_codes SET attempts = attempts + 1 WHERE email = ?",
                    (normalized_email,),
                )
                raise ValueError("邮箱验证码错误")
            conn.execute("DELETE FROM email_verification_codes WHERE email = ?", (normalized_email,))

    def _generate_invite_code(self, conn: sqlite3.Connection) -> str:
        for _ in range(20):
            code = "iv_" + "".join(secrets.choice(TOKEN_CHARS) for _ in range(10))
            if not conn.execute("SELECT 1 FROM user_invite_codes WHERE code = ?", (code,)).fetchone():
                return code
        return "iv_" + uuid.uuid4().hex[:16]

    def get_or_create_invite_code(self, user_id: str) -> str | None:
        with self._lock, self._connect() as conn:
            if not conn.execute("SELECT 1 FROM users WHERE id = ? AND enabled = 1", (user_id,)).fetchone():
                return None
            row = conn.execute("SELECT code FROM user_invite_codes WHERE inviter_id = ?", (user_id,)).fetchone()
            if row:
                return str(row["code"])
            code = self._generate_invite_code(conn)
            conn.execute(
                "INSERT INTO user_invite_codes (code, inviter_id, created_at) VALUES (?, ?, ?)",
                (code, user_id, _now()),
            )
            return code

    def get_invite_summary(self, user_id: str) -> dict | None:
        with self._lock, self._connect() as conn:
            if not conn.execute("SELECT 1 FROM users WHERE id = ? AND enabled = 1", (user_id,)).fetchone():
                return None
            row = conn.execute("SELECT code FROM user_invite_codes WHERE inviter_id = ?", (user_id,)).fetchone()
            if row:
                code = str(row["code"])
            else:
                code = self._generate_invite_code(conn)
                conn.execute(
                    "INSERT INTO user_invite_codes (code, inviter_id, created_at) VALUES (?, ?, ?)",
                    (code, user_id, _now()),
                )
            total = int(
                conn.execute(
                    "SELECT COUNT(*) FROM user_invite_rewards WHERE inviter_id = ?",
                    (user_id,),
                ).fetchone()[0]
            )
            rows = conn.execute(
                """
                SELECT user_invite_rewards.*, users.email AS invited_email
                FROM user_invite_rewards
                LEFT JOIN users ON users.id = user_invite_rewards.invited_user_id
                WHERE user_invite_rewards.inviter_id = ?
                ORDER BY user_invite_rewards.created_at DESC
                LIMIT 20
                """,
                (user_id,),
            ).fetchall()
        return {"code": code, "total_invites": total, "recent": [dict(row) for row in rows]}

    def invite_code_exists(self, invite_code: str) -> bool:
        code = str(invite_code or "").strip()
        if not code:
            return False
        with self._lock, self._connect() as conn:
            return bool(
                conn.execute(
                    """
                    SELECT 1
                    FROM user_invite_codes
                    JOIN users ON users.id = user_invite_codes.inviter_id
                    WHERE user_invite_codes.code = ? AND users.enabled = 1
                    """,
                    (code,),
                ).fetchone()
            )

    def apply_invite_reward(
        self,
        *,
        invite_code: str,
        invited_user_id: str,
        inviter_amount: int,
        invited_amount: int,
    ) -> dict | None:
        code = str(invite_code or "").strip()
        inviter_amount = max(0, int(inviter_amount or 0))
        invited_amount = max(0, int(invited_amount or 0))
        if not code or not invited_user_id or (inviter_amount <= 0 and invited_amount <= 0):
            return None
        now = _now()
        with self._lock, self._connect() as conn:
            row = conn.execute(
                """
                SELECT user_invite_codes.code, user_invite_codes.inviter_id, users.email AS inviter_email
                FROM user_invite_codes
                JOIN users ON users.id = user_invite_codes.inviter_id
                WHERE user_invite_codes.code = ? AND users.enabled = 1
                """,
                (code,),
            ).fetchone()
            if not row:
                raise ValueError("邀请链接无效")
            inviter_id = str(row["inviter_id"])
            if inviter_id == invited_user_id:
                raise ValueError("不能使用自己的邀请链接")
            invited_row = conn.execute("SELECT email, quota FROM users WHERE id = ?", (invited_user_id,)).fetchone()
            inviter_row = conn.execute("SELECT quota FROM users WHERE id = ?", (inviter_id,)).fetchone()
            if not invited_row or not inviter_row:
                return None
            try:
                conn.execute(
                    """
                    INSERT INTO user_invite_rewards
                        (id, inviter_id, invited_user_id, code, inviter_amount, invited_amount, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (uuid.uuid4().hex, inviter_id, invited_user_id, code, inviter_amount, invited_amount, now),
                )
            except sqlite3.IntegrityError:
                return None

            if inviter_amount > 0:
                inviter_next_quota = max(0, int(inviter_row["quota"] or 0) + inviter_amount)
                conn.execute(
                    "UPDATE users SET quota = ?, total_redeemed = total_redeemed + ?, updated_at = ? WHERE id = ?",
                    (inviter_next_quota, inviter_amount, now, inviter_id),
                )
                self._insert_quota_ledger(
                    conn,
                    user_id=inviter_id,
                    amount=inviter_amount,
                    balance_after=inviter_next_quota,
                    reason="invite_reward",
                    reference=code,
                    metadata={"invited_user_id": invited_user_id, "invited_email": str(invited_row["email"] or "")},
                    created_at=now,
                )
            if invited_amount > 0:
                invited_next_quota = max(0, int(invited_row["quota"] or 0) + invited_amount)
                conn.execute(
                    "UPDATE users SET quota = ?, total_redeemed = total_redeemed + ?, updated_at = ? WHERE id = ?",
                    (invited_next_quota, invited_amount, now, invited_user_id),
                )
                self._insert_quota_ledger(
                    conn,
                    user_id=invited_user_id,
                    amount=invited_amount,
                    balance_after=invited_next_quota,
                    reason="invite_register_bonus",
                    reference=code,
                    metadata={"inviter_id": inviter_id, "inviter_email": str(row["inviter_email"] or "")},
                    created_at=now,
                )
        return {
            "code": code,
            "inviter_id": inviter_id,
            "invited_user_id": invited_user_id,
            "inviter_amount": inviter_amount,
            "invited_amount": invited_amount,
        }

    def login(self, email: str, password: str) -> tuple[str, User]:
        normalized_email = str(email or "").strip().lower()
        with self._lock, self._connect() as conn:
            user = self._user_from_row(conn.execute("SELECT * FROM users WHERE email = ?", (normalized_email,)).fetchone())
            if not user or not user.enabled or not _verify_password(password, user.password_hash):
                raise ValueError("邮箱或密码错误")
            token = "usr_" + "".join(secrets.choice(TOKEN_CHARS) for _ in range(64))
            conn.execute("DELETE FROM user_sessions WHERE user_id = ?", (user.id,))
            conn.execute(
                "INSERT INTO user_sessions (session_hash, user_id, created_at) VALUES (?, ?, ?)",
                (_hash_value(token), user.id, _now()),
            )
            conn.execute("UPDATE users SET updated_at = ? WHERE id = ?", (_now(), user.id))
            return token, user

    def get_by_token(self, token: str) -> User | None:
        token = str(token or "").strip()
        if not token:
            return None
        with self._lock, self._connect() as conn:
            if token.startswith("uak_"):
                user = self._get_user_by_api_key(conn, token)
            else:
                user = self._user_from_row(
                    conn.execute(
                        """
                        SELECT users.* FROM users
                        JOIN user_sessions ON user_sessions.user_id = users.id
                        WHERE user_sessions.session_hash = ?
                        """,
                        (_hash_value(token),),
                    ).fetchone()
                )
            if not user or not user.enabled:
                return None
            return user

    def _get_user_by_api_key(self, conn: sqlite3.Connection, full_key: str) -> User | None:
        parts = full_key.split(".", 1)
        if len(parts) != 2:
            return None
        key, secret = parts
        row = conn.execute(
            """
            SELECT user_api_keys.*, users.enabled AS user_enabled
            FROM user_api_keys
            JOIN users ON users.id = user_api_keys.user_id
            WHERE user_api_keys.key = ?
            """,
            (key,),
        ).fetchone()
        if not row or not row["enabled"] or not row["user_enabled"]:
            return None
        if not hmac.compare_digest(_hash_value(secret), str(row["secret_hash"] or "")):
            return None
        conn.execute("UPDATE user_api_keys SET last_used_at = ? WHERE key = ?", (_now(), key))
        return self.get_user(str(row["user_id"]))

    def get_user(self, user_id: str) -> User | None:
        with self._lock, self._connect() as conn:
            return self._user_from_row(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())

    def list_users(self, query: str = "", limit: int = 100, offset: int = 0) -> dict:
        limit = max(1, min(500, int(limit or 100)))
        offset = max(0, int(offset or 0))
        q = f"%{str(query or '').strip().lower()}%"
        where = "WHERE lower(email) LIKE ?" if str(query or "").strip() else ""
        params: tuple = (q,) if where else ()
        with self._lock, self._connect() as conn:
            total = int(conn.execute(f"SELECT COUNT(*) FROM users {where}", params).fetchone()[0])
            rows = conn.execute(
                f"SELECT * FROM users {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
        users = [self._user_from_row(row).to_public_dict() for row in rows if self._user_from_row(row)]
        return {"users": users, "total": total, "limit": limit, "offset": offset, "has_more": offset + len(users) < total}

    def create_user(self, email: str, password: str, quota: int = 0, enabled: bool = True) -> User:
        user = self.register(email, password, quota, quota_reason="admin_create")
        if enabled is False:
            updated = self.update_user(user.id, enabled=False)
            return updated or user
        return user

    def update_user(
        self,
        user_id: str,
        *,
        email: str | None = None,
        password: str | None = None,
        quota: int | None = None,
        enabled: bool | None = None,
    ) -> User | None:
        updates: list[str] = []
        params: list[object] = []
        if email is not None:
            normalized_email = str(email or "").strip().lower()
            if "@" not in normalized_email or "." not in normalized_email.rsplit("@", 1)[-1]:
                raise ValueError("请输入有效邮箱")
            updates.append("email = ?")
            params.append(normalized_email)
        if password is not None and password != "":
            if len(password) < 6:
                raise ValueError("密码至少 6 位")
            updates.append("password_hash = ?")
            params.append(_hash_password(password))
        current_quota: int | None = None
        if quota is not None:
            current_user = self.get_user(user_id)
            if current_user is None:
                return None
            current_quota = int(current_user.quota or 0)
            updates.append("quota = ?")
            params.append(max(0, int(quota)))
        if enabled is not None:
            updates.append("enabled = ?")
            params.append(1 if enabled else 0)
        if not updates:
            return self.get_user(user_id)
        updates.append("updated_at = ?")
        params.append(_now())
        params.append(user_id)
        with self._lock, self._connect() as conn:
            try:
                cursor = conn.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", tuple(params))
            except sqlite3.IntegrityError as exc:
                raise ValueError("邮箱已存在") from exc
            if cursor.rowcount <= 0:
                return None
            if quota is not None and current_quota is not None:
                next_quota = max(0, int(quota))
                self._insert_quota_ledger(
                    conn,
                    user_id=user_id,
                    amount=next_quota - current_quota,
                    balance_after=next_quota,
                    reason="admin_set",
                    metadata={"previous_quota": current_quota},
                )
        return self.get_user(user_id)

    def delete_user(self, user_id: str) -> bool:
        with self._lock, self._connect() as conn:
            cursor = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            return cursor.rowcount > 0

    def add_quota(
        self,
        user_id: str,
        amount: int,
        *,
        reason: str = "admin_adjust",
        reference: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> User | None:
        amount = int(amount or 0)
        if amount == 0:
            return self.get_user(user_id)
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT quota FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                return None
            next_quota = max(0, int(row["quota"] or 0) + amount)
            redeemed_delta = max(0, amount)
            conn.execute(
                "UPDATE users SET quota = ?, total_redeemed = total_redeemed + ?, updated_at = ? WHERE id = ?",
                (next_quota, redeemed_delta, _now(), user_id),
            )
            self._insert_quota_ledger(
                conn,
                user_id=user_id,
                amount=next_quota - int(row["quota"] or 0),
                balance_after=next_quota,
                reason=reason,
                reference=reference,
                metadata=metadata,
            )
        return self.get_user(user_id)

    def redeem_code_quota(
        self,
        user_id: str,
        code: str,
        amount: int,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> User | None:
        amount = int(amount or 0)
        code = str(code or "").strip()
        if not code or amount <= 0:
            return None
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT quota FROM users WHERE id = ? AND enabled = 1", (user_id,)).fetchone()
            if not row:
                return None
            now = _now()
            try:
                conn.execute(
                    """
                    INSERT INTO redeemed_codes (code, user_id, amount, metadata, redeemed_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (code, user_id, amount, json.dumps(metadata or {}, ensure_ascii=False, separators=(",", ":")), now),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError("兑换码已被使用") from exc
            next_quota = max(0, int(row["quota"] or 0) + amount)
            conn.execute(
                "UPDATE users SET quota = ?, total_redeemed = total_redeemed + ?, updated_at = ? WHERE id = ?",
                (next_quota, amount, now, user_id),
            )
            self._insert_quota_ledger(
                conn,
                user_id=user_id,
                amount=amount,
                balance_after=next_quota,
                reason="redeem",
                reference=code,
                metadata=metadata,
                created_at=now,
            )
        return self.get_user(user_id)

    def reset_redeemed_code(self, code: str) -> bool:
        code = str(code or "").strip()
        if not code:
            return False
        with self._lock, self._connect() as conn:
            cursor = conn.execute("DELETE FROM redeemed_codes WHERE code = ?", (code,))
            return cursor.rowcount > 0

    def get_redeemed_code(self, code: str) -> dict[str, Any] | None:
        code = str(code or "").strip()
        if not code:
            return None
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT code, user_id, amount, metadata, redeemed_at FROM redeemed_codes WHERE code = ?",
                (code,),
            ).fetchone()
        item = _row_to_dict(row)
        if item:
            try:
                item["metadata"] = json.loads(str(item.get("metadata") or "{}"))
            except json.JSONDecodeError:
                item["metadata"] = {}
        return item

    def list_redeemed_codes(self, codes: list[str]) -> dict[str, dict[str, Any]]:
        normalized_codes = [str(code or "").strip() for code in codes if str(code or "").strip()]
        if not normalized_codes:
            return {}
        placeholders = ",".join("?" for _ in normalized_codes)
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                f"SELECT code, user_id, amount, metadata, redeemed_at FROM redeemed_codes WHERE code IN ({placeholders})",
                tuple(normalized_codes),
            ).fetchall()
        items: dict[str, dict[str, Any]] = {}
        for row in rows:
            item = dict(row)
            try:
                item["metadata"] = json.loads(str(item.get("metadata") or "{}"))
            except json.JSONDecodeError:
                item["metadata"] = {}
            items[str(item["code"])] = item
        return items

    def reserve_quota(
        self,
        user_id: str,
        amount: int,
        *,
        action: str = "",
        model: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        amount = int(amount or 0)
        if amount <= 0:
            return {"id": "", "amount": 0}
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT quota FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                return None
            now = _now()
            reservation_id = uuid.uuid4().hex
            cursor = conn.execute(
                """
                UPDATE users
                SET quota = quota - ?, total_usage = total_usage + ?, updated_at = ?
                WHERE id = ? AND enabled = 1 AND quota >= ?
                """,
                (amount, amount, now, user_id, amount),
            )
            if cursor.rowcount <= 0:
                return None
            next_quota = max(0, int(row["quota"] or 0) - amount)
            conn.execute(
                """
                INSERT INTO user_quota_reservations
                    (id, user_id, amount, action, model, status, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                """,
                (
                    reservation_id,
                    user_id,
                    amount,
                    str(action or ""),
                    str(model or ""),
                    json.dumps(metadata or {}, ensure_ascii=False, separators=(",", ":")),
                    now,
                    now,
                ),
            )
            self._insert_quota_ledger(
                conn,
                user_id=user_id,
                amount=-amount,
                balance_after=next_quota,
                reason="reserve",
                reference=action,
                metadata=metadata,
                created_at=now,
            )
            return {"id": reservation_id, "amount": amount}

    def settle_quota_reservation(
        self,
        reservation_id: str,
        actual_amount: int,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        reservation_id = str(reservation_id or "").strip()
        if not reservation_id:
            return 0
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM user_quota_reservations WHERE id = ? AND status = 'pending'",
                (reservation_id,),
            ).fetchone()
            if not row:
                return 0
            reserved_amount = max(0, int(row["amount"] or 0))
            actual_amount = max(0, min(reserved_amount, int(actual_amount or 0)))
            refund_amount = reserved_amount - actual_amount
            now = _now()
            if refund_amount > 0:
                user_row = conn.execute("SELECT quota, total_usage FROM users WHERE id = ?", (row["user_id"],)).fetchone()
                if user_row:
                    next_quota = max(0, int(user_row["quota"] or 0) + refund_amount)
                    usage_delta = min(refund_amount, max(0, int(user_row["total_usage"] or 0)))
                    conn.execute(
                        "UPDATE users SET quota = quota + ?, total_usage = MAX(0, total_usage - ?), updated_at = ? WHERE id = ?",
                        (refund_amount, usage_delta, now, row["user_id"]),
                    )
                    self._insert_quota_ledger(
                        conn,
                        user_id=str(row["user_id"]),
                        amount=refund_amount,
                        balance_after=next_quota,
                        reason="refund_unused",
                        reference=str(row["action"] or ""),
                        metadata=metadata,
                        created_at=now,
                    )
            conn.execute(
                "UPDATE user_quota_reservations SET status = 'settled', metadata = ?, updated_at = ? WHERE id = ?",
                (json.dumps(metadata or {}, ensure_ascii=False, separators=(",", ":")), now, reservation_id),
            )
            return actual_amount

    def refund_quota_reservation(
        self,
        reservation_id: str,
        *,
        reason: str = "refund_failed",
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        reservation_id = str(reservation_id or "").strip()
        if not reservation_id:
            return True
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM user_quota_reservations WHERE id = ? AND status = 'pending'",
                (reservation_id,),
            ).fetchone()
            if not row:
                return False
            amount = max(0, int(row["amount"] or 0))
            now = _now()
            user_row = conn.execute("SELECT quota, total_usage FROM users WHERE id = ?", (row["user_id"],)).fetchone()
            if user_row and amount > 0:
                next_quota = max(0, int(user_row["quota"] or 0) + amount)
                usage_delta = min(amount, max(0, int(user_row["total_usage"] or 0)))
                conn.execute(
                    "UPDATE users SET quota = quota + ?, total_usage = MAX(0, total_usage - ?), updated_at = ? WHERE id = ?",
                    (amount, usage_delta, now, row["user_id"]),
                )
                self._insert_quota_ledger(
                    conn,
                    user_id=str(row["user_id"]),
                    amount=amount,
                    balance_after=next_quota,
                    reason=reason,
                    reference=str(row["action"] or ""),
                    metadata=metadata,
                    created_at=now,
                )
            conn.execute(
                "UPDATE user_quota_reservations SET status = 'refunded', metadata = ?, updated_at = ? WHERE id = ?",
                (json.dumps(metadata or {}, ensure_ascii=False, separators=(",", ":")), now, reservation_id),
            )
            return True

    def refund_pending_quota_reservations(self, *, reason: str = "startup_refund") -> int:
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT id FROM user_quota_reservations WHERE status = 'pending'").fetchall()
        refunded = 0
        for row in rows:
            if self.refund_quota_reservation(str(row["id"]), reason=reason, metadata={"reason": reason}):
                refunded += 1
        return refunded

    def refund_expired_quota_reservations(
        self,
        *,
        ttl_seconds: int = QUOTA_RESERVATION_TTL_SECONDS,
        reason: str = "timeout_refund",
    ) -> int:
        cutoff = _now() - max(60, int(ttl_seconds or QUOTA_RESERVATION_TTL_SECONDS))
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT id FROM user_quota_reservations WHERE status = 'pending' AND updated_at < ?",
                (cutoff,),
            ).fetchall()
        refunded = 0
        for row in rows:
            if self.refund_quota_reservation(str(row["id"]), reason=reason, metadata={"reason": reason, "cutoff": cutoff}):
                refunded += 1
        return refunded

    def consume_quota(
        self,
        user_id: str,
        amount: int,
        *,
        reason: str = "consume",
        reference: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        amount = int(amount or 0)
        if amount <= 0:
            return True
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT quota FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                return False
            cursor = conn.execute(
                """
                UPDATE users
                SET quota = quota - ?, total_usage = total_usage + ?, updated_at = ?
                WHERE id = ? AND enabled = 1 AND quota >= ?
                """,
                (amount, amount, _now(), user_id, amount),
            )
            if cursor.rowcount <= 0:
                return False
            next_quota = max(0, int(row["quota"] or 0) - amount)
            self._insert_quota_ledger(
                conn,
                user_id=user_id,
                amount=-amount,
                balance_after=next_quota,
                reason=reason,
                reference=reference,
                metadata=metadata,
            )
            return True

    def refund_quota(
        self,
        user_id: str,
        amount: int,
        *,
        reason: str = "refund",
        reference: str = "",
        metadata: dict[str, Any] | None = None,
        decrement_usage: bool = True,
    ) -> bool:
        amount = int(amount or 0)
        if amount <= 0:
            return True
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT quota, total_usage FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                return False
            usage_delta = min(amount, max(0, int(row["total_usage"] or 0))) if decrement_usage else 0
            next_quota = max(0, int(row["quota"] or 0) + amount)
            conn.execute(
                """
                UPDATE users
                SET quota = quota + ?, total_usage = MAX(0, total_usage - ?), updated_at = ?
                WHERE id = ?
                """,
                (amount, usage_delta, _now(), user_id),
            )
            self._insert_quota_ledger(
                conn,
                user_id=user_id,
                amount=amount,
                balance_after=next_quota,
                reason=reason,
                reference=reference,
                metadata=metadata,
            )
            return True

    def list_quota_ledger(self, user_id: str, limit: int = 50, offset: int = 0) -> dict:
        limit = max(1, min(200, int(limit or 50)))
        offset = max(0, int(offset or 0))
        with self._lock, self._connect() as conn:
            total = int(
                conn.execute(
                    "SELECT COUNT(*) FROM user_quota_ledger WHERE user_id = ?",
                    (user_id,),
                ).fetchone()[0]
            )
            rows = conn.execute(
                """
                SELECT id, user_id, amount, balance_after, reason, reference, metadata, created_at
                FROM user_quota_ledger
                WHERE user_id = ?
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                (user_id, limit, offset),
            ).fetchall()
        records = []
        for row in rows:
            item = dict(row)
            try:
                item["metadata"] = json.loads(str(item.get("metadata") or "{}"))
            except json.JSONDecodeError:
                item["metadata"] = {}
            records.append(item)
        return {"records": records, "total": total, "limit": limit, "offset": offset, "has_more": offset + len(records) < total}

    def create_api_key(self, user_id: str, name: str = "") -> tuple[str, dict] | None:
        if not self.get_user(user_id):
            return None
        raw_key = "uak_" + "".join(secrets.choice(TOKEN_CHARS) for _ in range(32))
        secret = "".join(secrets.choice(TOKEN_CHARS) for _ in range(48))
        now = _now()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO user_api_keys (key, user_id, name, secret_hash, created_at, last_used_at, enabled)
                VALUES (?, ?, ?, ?, ?, 0, 1)
                """,
                (raw_key, user_id, str(name or "").strip(), _hash_value(secret), now),
            )
        item = self.get_api_key(raw_key)
        return f"{raw_key}.{secret}", item

    def get_api_key(self, key: str) -> dict | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                """
                SELECT key, user_id, name, created_at, last_used_at, enabled
                FROM user_api_keys WHERE key = ?
                """,
                (key,),
            ).fetchone()
        item = _row_to_dict(row)
        if item:
            item["enabled"] = bool(item.get("enabled"))
        return item

    def list_api_keys(self, user_id: str) -> list[dict]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT key, user_id, name, created_at, last_used_at, enabled
                FROM user_api_keys WHERE user_id = ? ORDER BY created_at DESC
                """,
                (user_id,),
            ).fetchall()
        items = []
        for row in rows:
            item = dict(row)
            item["enabled"] = bool(item.get("enabled"))
            items.append(item)
        return items

    def update_api_key(self, user_id: str, key: str, *, name: str | None = None, enabled: bool | None = None) -> dict | None:
        updates: list[str] = []
        params: list[object] = []
        if name is not None:
            updates.append("name = ?")
            params.append(str(name or "").strip())
        if enabled is not None:
            updates.append("enabled = ?")
            params.append(1 if enabled else 0)
        if not updates:
            return self.get_api_key(key)
        params.extend([key, user_id])
        with self._lock, self._connect() as conn:
            cursor = conn.execute(
                f"UPDATE user_api_keys SET {', '.join(updates)} WHERE key = ? AND user_id = ?",
                tuple(params),
            )
            if cursor.rowcount <= 0:
                return None
        return self.get_api_key(key)

    def delete_api_key(self, user_id: str, key: str) -> bool:
        with self._lock, self._connect() as conn:
            cursor = conn.execute("DELETE FROM user_api_keys WHERE key = ? AND user_id = ?", (key, user_id))
            return cursor.rowcount > 0

    def list_image_conversations(self, user_id: str, limit: int = 200, offset: int = 0) -> dict:
        limit = max(1, min(500, int(limit or 200)))
        offset = max(0, int(offset or 0))
        with self._lock, self._connect() as conn:
            total = int(
                conn.execute(
                    "SELECT COUNT(*) FROM user_image_conversations WHERE user_id = ?",
                    (user_id,),
                ).fetchone()[0]
            )
            rows = conn.execute(
                """
                SELECT payload FROM user_image_conversations
                WHERE user_id = ?
                ORDER BY created_at DESC, updated_at DESC
                LIMIT ? OFFSET ?
                """,
                (user_id, limit, offset),
            ).fetchall()
        items = []
        for row in rows:
            try:
                item = json.loads(str(row["payload"] or "{}"))
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                items.append(item)
        return {"items": items, "total": total, "limit": limit, "offset": offset, "has_more": offset + len(items) < total}

    def _sanitize_image_conversation(self, conversation: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(conversation, dict):
            raise ValueError("conversation must be an object")
        conversation_id = str(conversation.get("id") or "").strip()
        if not conversation_id or len(conversation_id) > 128:
            raise ValueError("conversation id is required")

        sanitized: dict[str, Any] = {
            "id": conversation_id,
            "title": str(conversation.get("title") or "")[:200],
            "prompt": str(conversation.get("prompt") or "")[:MAX_IMAGE_CONVERSATION_PROMPT_CHARS],
            "model": str(conversation.get("model") or "gpt-image-2")[:80],
            "mode": "edit" if conversation.get("mode") == "edit" else "generate",
            "count": max(1, min(4, int(conversation.get("count") or 1))),
            "createdAt": str(conversation.get("createdAt") or ""),
            "status": str(conversation.get("status") or "success")[:32],
        }
        if conversation.get("error"):
            sanitized["error"] = str(conversation.get("error") or "")[:1000]

        settings = conversation.get("generationSettings")
        if isinstance(settings, dict):
            sanitized["generationSettings"] = {
                "quality": str(settings.get("quality") or "")[:32],
                "size": str(settings.get("size") or "")[:32],
                "outputFormat": str(settings.get("outputFormat") or "")[:32],
                "outputCompression": max(0, min(100, int(settings.get("outputCompression") or 0))),
                "moderation": str(settings.get("moderation") or "")[:32],
            }

        images = conversation.get("images")
        sanitized_images: list[dict[str, Any]] = []
        if isinstance(images, list):
            for image in images[:MAX_IMAGE_CONVERSATION_IMAGES]:
                if not isinstance(image, dict):
                    continue
                item = {
                    "id": str(image.get("id") or "")[:128],
                    "status": str(image.get("status") or "")[:32],
                }
                if image.get("url"):
                    item["url"] = str(image.get("url") or "")[:2048]
                if image.get("error"):
                    item["error"] = str(image.get("error") or "")[:1000]
                sanitized_images.append(item)
        sanitized["images"] = sanitized_images

        references = conversation.get("referenceImages")
        sanitized_references: list[dict[str, Any]] = []
        if isinstance(references, list):
            for reference in references[:MAX_IMAGE_CONVERSATION_REFERENCE_IMAGES]:
                if not isinstance(reference, dict):
                    continue
                sanitized_references.append({
                    "name": str(reference.get("name") or "")[:240],
                    "type": str(reference.get("type") or "")[:120],
                })
        if sanitized_references:
            sanitized["referenceImages"] = sanitized_references

        payload = json.dumps(sanitized, ensure_ascii=False, separators=(",", ":"))
        if len(payload.encode("utf-8")) > MAX_IMAGE_CONVERSATION_PAYLOAD_BYTES:
            raise ValueError("conversation payload is too large")
        return sanitized

    def save_image_conversation(self, user_id: str, conversation: dict[str, Any]) -> dict[str, Any]:
        conversation = self._sanitize_image_conversation(conversation)
        conversation_id = str(conversation.get("id") or "").strip()
        now = _now()
        created_at_value = str(conversation.get("createdAt") or "")
        try:
            created_at = int(time.mktime(time.strptime(created_at_value[:19], "%Y-%m-%dT%H:%M:%S"))) if created_at_value else now
        except Exception:
            created_at = now
        payload = json.dumps(conversation, ensure_ascii=False, separators=(",", ":"))
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO user_image_conversations (id, user_id, payload, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id, user_id) DO UPDATE SET
                    payload = excluded.payload,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at
                """,
                (conversation_id, user_id, payload, created_at, now),
            )
        return conversation

    def delete_image_conversation(self, user_id: str, conversation_id: str) -> bool:
        with self._lock, self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM user_image_conversations WHERE id = ? AND user_id = ?",
                (conversation_id, user_id),
            )
            return cursor.rowcount > 0

    def clear_image_conversations(self, user_id: str) -> int:
        with self._lock, self._connect() as conn:
            cursor = conn.execute("DELETE FROM user_image_conversations WHERE user_id = ?", (user_id,))
            return cursor.rowcount


user_service = UserService()

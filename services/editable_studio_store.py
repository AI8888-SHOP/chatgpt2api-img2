"""SQLite admission and billing: jobs, credits and refunds share one transaction."""
from contextlib import contextmanager
import json
import time
import uuid

from fastapi import HTTPException


def failure(code, message):
    raise HTTPException(code, detail={"error": message}, headers={"Retry-After": "60"} if code == 429 else None)


class StudioStore:
    def __init__(self, users):
        self.users = users
        with self.connect() as c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS studio_plans (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    root_id TEXT NOT NULL, revision INTEGER NOT NULL, created REAL NOT NULL,
                    payload TEXT NOT NULL, request TEXT NOT NULL, images TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS studio_jobs (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    client_id TEXT NOT NULL, fingerprint TEXT NOT NULL, plan_id TEXT NOT NULL,
                    kind TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
                    created REAL NOT NULL, updated REAL NOT NULL, started REAL NOT NULL DEFAULT 0,
                    deadline REAL NOT NULL DEFAULT 0, worker TEXT NOT NULL DEFAULT '',
                    price INTEGER NOT NULL, budget INTEGER NOT NULL, actual_tokens INTEGER,
                    output_tokens INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
                    result TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '',
                    UNIQUE(user_id, client_id)
                );
                CREATE INDEX IF NOT EXISTS studio_jobs_owner ON studio_jobs(user_id, created);
                CREATE INDEX IF NOT EXISTS studio_jobs_status ON studio_jobs(status, created);
                CREATE TABLE IF NOT EXISTS studio_calls (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    root_id TEXT NOT NULL, created REAL NOT NULL, lease REAL NOT NULL,
                    budget INTEGER NOT NULL, actual_tokens INTEGER, status TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS studio_calls_owner ON studio_calls(user_id, created);
                CREATE TABLE IF NOT EXISTS studio_workers (id TEXT PRIMARY KEY, heartbeat REAL NOT NULL);
            """)
            if "settings" not in {r[1] for r in c.execute("PRAGMA table_info(studio_jobs)")}:
                c.execute("ALTER TABLE studio_jobs ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'")

    @contextmanager
    def connect(self, write=False):
        c = self.users._connect()
        try:
            if write:
                c.execute("BEGIN IMMEDIATE")
            with c:
                yield c
        finally:
            c.close()

    def _eligible(self, c, owner, s):
        row = c.execute("SELECT * FROM users WHERE id=? AND enabled=1", (owner,)).fetchone()
        if not row:
            failure(401, "请重新登录")
        if row["quota"] < s.min_quota:
            failure(403, "积分余额不足，暂不能使用文档工作室")
        if time.time() - row["created_at"] < s.min_account_age_seconds:
            failure(403, "新账号暂不能使用文档工作室，请稍后再试")
        return row

    def _budget(self, c, owner, reserve, s):
        day = int(time.time() // 86400) * 86400
        for who, cap, label in ((owner, s.user_daily_tokens, "您的"), (None, s.global_daily_tokens, "全站")):
            suffix = " AND user_id=?" if who else ""
            args = (day, who) if who else (day,)
            total = 0
            for table in ("studio_calls", "studio_jobs"):
                total += c.execute(f"SELECT COALESCE(SUM(COALESCE(actual_tokens,budget)),0) FROM {table} WHERE created>=?" + suffix, args).fetchone()[0]
            if total + reserve > cap:
                failure(429, label + "今日文档 Token 预算不足")

    def reserve_plan(self, owner, root_id, budget, s):
        now = time.time()
        with self.connect(True) as c:
            self._eligible(c, owner, s)
            row = c.execute("SELECT SUM(created>?),SUM(created>=?),SUM(status='running' AND lease>?) FROM studio_calls WHERE user_id=? AND created>?", (now-60, int(now//86400)*86400, now, owner, now-86400)).fetchone()
            if (row[0] or 0) >= s.plan_user_rpm or (row[1] or 0) >= s.plan_daily_requests:
                failure(429, "需求整理次数已达上限，请稍后再试")
            if row[2]:
                failure(429, "已有需求整理正在执行")
            busy = c.execute("SELECT COUNT(*) FROM studio_calls WHERE status='running' AND lease>?", (now,)).fetchone()[0]
            busy += c.execute("SELECT COUNT(*) FROM studio_jobs WHERE status='running'").fetchone()[0]
            if busy >= s.global_concurrency:
                failure(429, "全站需求整理繁忙，请稍后再试")
            if c.execute("SELECT COUNT(*) FROM studio_calls WHERE root_id=? AND user_id=?", (root_id, owner)).fetchone()[0] >= s.plan_revisions:
                failure(429, "此草稿的 AI 修改次数已用完，可手动调整方案")
            self._budget(c, owner, budget, s)
            call_id = uuid.uuid4().hex
            c.execute("INSERT INTO studio_calls VALUES(?,?,?,?,?,?,NULL,'running')", (call_id, owner, root_id, now, now+s.request_timeout_seconds+30, budget))
            return call_id

    def finish_plan_call(self, call_id, status, usage=None):
        with self.connect(True) as c:
            c.execute("UPDATE studio_calls SET status=?,lease=0,actual_tokens=? WHERE id=?", (status, usage, call_id))

    def save_plan(self, plan_id, owner, root, revision, payload, request, images):
        with self.connect(True) as c:
            c.execute("INSERT INTO studio_plans VALUES(?,?,?,?,?,?,?,?)", (plan_id, owner, root, revision, time.time(), json.dumps(payload, ensure_ascii=False), json.dumps(request, ensure_ascii=False), json.dumps(images)))

    def get_plan(self, owner, plan_id):
        with self.connect() as c:
            row = c.execute("SELECT * FROM studio_plans WHERE id=? AND user_id=?", (plan_id, owner)).fetchone()
        if not row or row["created"] < time.time()-86400:
            failure(404, "制作方案不存在或已过期，请重新整理需求")
        return dict(row)

    def _ledger(self, c, owner, amount, job_id, reason):
        now = int(time.time())
        if amount < 0:
            cur = c.execute("UPDATE users SET quota=quota+?,total_usage=total_usage-?,updated_at=? WHERE id=? AND enabled=1 AND quota>=?", (amount, amount, now, owner, -amount))
            if not cur.rowcount:
                failure(402, "积分不足，请先充值")
        else:
            c.execute("UPDATE users SET quota=quota+?,total_usage=MAX(0,total_usage-?),updated_at=? WHERE id=?", (amount, amount, now, owner))
        balance = c.execute("SELECT quota FROM users WHERE id=?", (owner,)).fetchone()
        if balance and amount:
            self.users._insert_quota_ledger(c, user_id=owner, amount=amount, balance_after=balance[0], reason=reason, reference=job_id, metadata={"action":"editable_studio", "task_id":job_id}, created_at=now)

    def admit_job(self, owner, body, fingerprint, price, budget, s):
        now = time.time()
        with self.connect(True) as c:
            existing = c.execute("SELECT * FROM studio_jobs WHERE user_id=? AND client_id=?", (owner, body.client_task_id)).fetchone()
            if existing:
                if existing["fingerprint"] != fingerprint:
                    failure(409, "此提交编号已用于不同的任务")
                return dict(existing)
            self._eligible(c, owner, s)
            counts = c.execute("SELECT SUM(created>?),SUM(created>=?),SUM(status IN ('queued','running')) FROM studio_jobs WHERE user_id=? AND created>?", (now-60, int(now//86400)*86400, owner, now-86400)).fetchone()
            if (counts[0] or 0) >= s.generation_user_rpm or (counts[1] or 0) >= s.user_daily_jobs:
                failure(429, "今日或每分钟生成次数已达上限")
            if (counts[2] or 0) >= s.user_queue_size+1:
                failure(429, "您的任务队列已满，请等待当前任务完成")
            if c.execute("SELECT COUNT(*) FROM studio_jobs WHERE status IN ('queued','running')").fetchone()[0] >= s.global_concurrency+s.global_queue_size:
                failure(429, "全站任务队列已满，请稍后再试")
            self._budget(c, owner, budget, s)
            job_id = uuid.uuid4().hex
            self._ledger(c, owner, -price, job_id, "editable_studio_submit")
            c.execute("""INSERT INTO studio_jobs (id,user_id,client_id,fingerprint,plan_id,kind,status,phase,created,updated,price,budget,payload)
                VALUES(?,?,?,?,?,?,'queued','等待执行',?,?,?,?,?)""", (job_id, owner, body.client_task_id, fingerprint, body.plan_id, body.plan.kind, now, now, price, budget, body.plan.model_dump_json()))
            snapshot = s.model_dump(exclude={"base_url","api_key","model","enabled","reuse_optimizer_connection"})
            c.execute("UPDATE studio_jobs SET settings=? WHERE id=?",(json.dumps(snapshot),job_id))
            return dict(c.execute("SELECT * FROM studio_jobs WHERE id=?", (job_id,)).fetchone())

    def heartbeat(self, worker):
        with self.connect(True) as c:
            c.execute("INSERT INTO studio_workers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat", (worker, time.time()))

    def claim(self, worker, s):
        now = time.time()
        with self.connect(True) as c:
            busy = c.execute("SELECT COUNT(*) FROM studio_jobs WHERE status='running'").fetchone()[0]
            busy += c.execute("SELECT COUNT(*) FROM studio_calls WHERE status='running' AND lease>?", (now,)).fetchone()[0]
            if busy >= s.global_concurrency:
                return None
            row = c.execute("""SELECT * FROM studio_jobs q WHERE q.status='queued' AND NOT EXISTS
                (SELECT 1 FROM studio_jobs r WHERE r.user_id=q.user_id AND r.status='running') ORDER BY q.created LIMIT 1""").fetchone()
            if not row:
                return None
            c.execute("UPDATE studio_jobs SET status='running',phase='AI 正在制作',started=?,updated=?,deadline=?,worker=? WHERE id=?", (now, now, now+s.task_timeout_seconds, worker, row["id"]))
            return dict(c.execute("SELECT * FROM studio_jobs WHERE id=?", (row["id"],)).fetchone())

    def phase(self, job_id, phase):
        with self.connect(True) as c:
            c.execute("UPDATE studio_jobs SET phase=?,updated=? WHERE id=? AND status='running'", (phase, time.time(), job_id))

    def finish(self, job_id, result=None, error="", usage=None, output_tokens=0):
        with self.connect(True) as c:
            row = c.execute("SELECT * FROM studio_jobs WHERE id=? AND status IN ('running','queued')", (job_id,)).fetchone()
            if not row:
                return False
            if error:
                self._ledger(c, row["user_id"], row["price"], job_id, "editable_studio_refund")
            c.execute("UPDATE studio_jobs SET status=?,phase=?,result=?,error=?,actual_tokens=?,output_tokens=?,updated=? WHERE id=?", ("error" if error else "success", "失败，积分已退回" if error else "文件已验收", json.dumps(result or {}, ensure_ascii=False), error, usage, output_tokens, time.time(), job_id))
            return True

    def reap(self):
        now = time.time()
        with self.connect() as c:
            rows = c.execute("""SELECT j.id FROM studio_jobs j LEFT JOIN studio_workers w ON w.id=j.worker
                WHERE (j.status='running' AND (j.deadline<? OR COALESCE(w.heartbeat,0)<?))
                OR (j.status='queued' AND j.created<?)""", (now, now-60, now-86400)).fetchall()
        for row in rows:
            self.finish(row["id"], error="任务超时或服务中断，积分已退回，请重新提交")

    def get_job(self, owner, job_id):
        with self.connect() as c:
            row = c.execute("SELECT * FROM studio_jobs WHERE id=? AND user_id=?", (job_id, owner)).fetchone()
        if not row:
            failure(404, "任务不存在")
        return dict(row)

    def find_submission(self, owner, client_id):
        with self.connect() as c:
            row = c.execute("SELECT * FROM studio_jobs WHERE user_id=? AND client_id=?", (owner, client_id)).fetchone()
        return dict(row) if row else None

    def list_jobs(self, owner):
        with self.connect() as c:
            return [dict(r) for r in c.execute("SELECT * FROM studio_jobs WHERE user_id=? ORDER BY created DESC LIMIT 100", (owner,))]

    def stats(self):
        day = int(time.time()//86400)*86400
        with self.connect() as c:
            return {"jobs": [dict(r) for r in c.execute("SELECT status,COUNT(*) AS count FROM studio_jobs GROUP BY status")],
                    "daily_tokens": sum(c.execute(f"SELECT COALESCE(SUM(COALESCE(actual_tokens,budget)),0) FROM {t} WHERE created>=?", (day,)).fetchone()[0] for t in ("studio_calls","studio_jobs")),
                    "recent": [dict(r) for r in c.execute("SELECT id,kind,status,phase,price,error,created,actual_tokens FROM studio_jobs ORDER BY created DESC LIMIT 20")]}

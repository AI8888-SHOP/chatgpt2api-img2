"""Durable, owner-scoped sub2api video jobs. Never retry a creation request."""
from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from threading import Event, RLock, Thread
from typing import Literal
from urllib.parse import quote, urlsplit

import requests
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from services.video_assets import VideoAssets


class VideoImage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class VideoAudio(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    voice_id: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{1,64}$")

    @model_validator(mode="after")
    def one_source(self):
        if bool(self.asset_id) == bool(self.voice_id):
            raise ValueError("音频必须提供素材 ID 或预设音色（二选一）")
        return self


class VideoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(default="grok-imagine-video", min_length=1, max_length=100)
    prompt: str = Field(min_length=1, max_length=8000)
    duration: int = Field(default=5, ge=1, le=15, strict=True)
    aspect_ratio: Literal["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"] = "16:9"
    resolution: Literal["480p", "720p"] = "480p"
    mode: Literal["text", "image", "reference"] = "text"
    reference_images: list[VideoImage] = Field(default_factory=list, max_length=14)
    reference_audios: list[VideoAudio] = Field(default_factory=list, max_length=3)
    generate_audio: bool = True
    client_request_id: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{16,80}$")


class VideoReconcileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    remote_id: str | None = Field(default=None, min_length=1, max_length=512)
    confirmed_failed: bool = False


def channel_key(channel):
    # Do not persist API keys in the task database.
    value = str(channel.get("base_url")) + "|" + str(channel.get("api_key"))
    return hashlib.sha256(value.encode()).hexdigest()


def endpoint(channel, suffix="", protocol="grok"):
    base = str(channel["base_url"]).rstrip("/")
    if protocol == "seedance":
        if not base.endswith(("/api/v3", "/v3", "/v1")):
            base += "/api/v3"
        return base + "/contents/generations/tasks" + suffix
    if not base.endswith("/v1"):
        base += "/v1"
    return base + "/videos/generations" + suffix


class VideoService:
    def __init__(self, config, users, path: Path, log_usage):
        self.config, self.users, self.log_usage = config, users, log_usage
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = RLock()
        self.stop_event = Event()
        self.thread = None
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS video_jobs (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, created REAL NOT NULL,
                state TEXT NOT NULL, payload TEXT NOT NULL, channel TEXT NOT NULL,
                upstream_name TEXT NOT NULL, remote_id TEXT, reservation TEXT,
                amount INTEGER NOT NULL, result TEXT, error TEXT NOT NULL DEFAULT '',
                accounted INTEGER NOT NULL DEFAULT 0)""")
            columns = {row[1] for row in db.execute("PRAGMA table_info(video_jobs)")}
            if "client_request_id" not in columns:
                db.execute("ALTER TABLE video_jobs ADD COLUMN client_request_id TEXT")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS video_client_requests ON video_jobs(owner,client_request_id)")
        self.assets = VideoAssets(self)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def start(self):
        # A crash between quota reservation and updating the separate task DB is
        # safe: preparation never submits an upstream request.
        for reservation in self.users.pending_video_reservations():
            job_id = json.loads(reservation["metadata"]).get("video_job_id")
            with self.connect() as db:
                row = db.execute("SELECT state FROM video_jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row["state"] == "preparing":
                self.users.refund_quota_reservation(reservation["id"], reason="video_setup_interrupted")
        with self.connect() as db:
            db.execute("UPDATE video_jobs SET state='failed', error='任务准备被中断，已退回积分' WHERE state='preparing'")
            db.execute("UPDATE video_jobs SET state='unknown', error='提交结果未知，请联系管理员核对；不会自动重试' WHERE state='submitting'")
        self.stop_event.clear()
        self.thread = Thread(target=self.run, daemon=True, name="video-jobs")
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=1)

    def channels(self, model):
        return [c for c in self.config.get_video_upstreams()
                if c.get("enabled") and model in c.get("models", [])
                and c.get("api_key") and urlsplit(str(c.get("base_url"))).scheme in {"http", "https"}]

    def prepare_payload(self, user, body, model):
        protocol = model["protocol"]
        has_references = body.mode == "reference" or bool(body.reference_audios)
        maximum = model["reference_max_duration"] if has_references else model["max_duration"]
        if not model["min_duration"] <= body.duration <= maximum or body.resolution not in model["resolutions"]:
            raise HTTPException(400, "视频时长或分辨率不在所选模型支持范围内")
        if len(body.reference_images) > model["max_reference_images"]:
            raise HTTPException(400, "参考图数量超出所选模型上限")
        if body.mode == "text" and body.reference_images:
            raise HTTPException(400, "请切换为图片或参考素材生成模式")
        if body.mode == "image" and len(body.reference_images) != 1:
            raise HTTPException(400, "图生视频需要一张首帧图")
        if body.mode == "reference" and not (body.reference_images or body.reference_audios):
            raise HTTPException(400, "请添加参考图或音频")
        if body.mode == "image" and body.reference_audios:
            raise HTTPException(400, "组合图片与音频请使用参考素材模式")
        if body.reference_audios and not body.generate_audio:
            raise HTTPException(400, "添加音频参考时请开启生成声音")
        images = [self.assets.resolve(user.id, image.asset_id, "image", protocol) for image in body.reference_images]
        if sum(len(url) for url in images) > 24 * 1024 * 1024:
            raise HTTPException(413, "参考图片总大小过大，请压缩后重试")
        voices, audio_urls = [], []
        for audio in body.reference_audios:
            if audio.voice_id:
                if not model["supports_voice"] or protocol != "grok":
                    raise HTTPException(400, "所选模型不支持预设音色")
                voices.append({"voice_id": audio.voice_id})
            else:
                if not model["supports_audio_upload"] or protocol != "seedance":
                    raise HTTPException(400, "所选模型不支持参考音频上传")
                audio_urls.append(self.assets.resolve(user.id, audio.asset_id, "audio", protocol))
        if len(audio_urls) > 1 or (audio_urls and not images):
            raise HTTPException(400, "参考音频最多一个，并需搭配至少一张参考图")
        payload = {"model": body.model, "duration": body.duration, "resolution": body.resolution, "generate_audio": body.generate_audio}
        if protocol == "seedance":
            content = [{"type": "text", "text": body.prompt}]
            content.extend({"type": "image_url", "image_url": {"url": url}, "role": "first_frame" if body.mode == "image" else "reference_image"} for url in images)
            content.extend({"type": "audio_url", "audio_url": {"url": url}, "role": "reference_audio"} for url in audio_urls)
            payload.update(content=content, ratio=body.aspect_ratio)
        else:
            payload.update(prompt=body.prompt, aspect_ratio=body.aspect_ratio)
            if images:
                if body.mode == "image":
                    payload["image"] = {"url": images[0]}
                else:
                    payload["reference_images"] = [{"url": url} for url in images]
            if voices:
                payload["reference_audios"] = voices
        return payload

    def create(self, user, body):
        with self.lock, self.connect() as db:
            if body.client_request_id:
                previous = db.execute("SELECT id FROM video_jobs WHERE owner=? AND client_request_id=?", (user.id, body.client_request_id)).fetchone()
                if previous:
                    return self.get(user.id, previous["id"])
        if self.config.get().get("video_enabled") is not True:
            raise HTTPException(503, "视频生成未启用")
        if not body.prompt.strip():
            raise HTTPException(400, "请输入视频提示词")
        channels = self.channels(body.model)
        model = next((m for m in self.config.get_video_models() if m["id"] == body.model and m["enabled"]), None)
        if not channels or not model:
            raise HTTPException(400, "该视频模型没有启用的上游")
        upstream_payload = self.prepare_payload(user, body, model)
        price = max(1, min(1000, int(self.config.get().get("video_credits_per_second") or 1)))
        if body.resolution == "720p":
            price = int(self.config.get().get("video_720p_credits_per_second", price * 2))
        amount = body.duration * price
        with self.lock, self.connect() as db:
            if body.client_request_id:
                previous = db.execute("SELECT id FROM video_jobs WHERE owner=? AND client_request_id=?", (user.id, body.client_request_id)).fetchone()
                if previous:
                    return self.get(user.id, previous["id"])
            active = db.execute("SELECT owner FROM video_jobs WHERE state NOT IN ('done','failed','expired')").fetchall()
            if len(active) >= 8 or any(row["owner"] == user.id for row in active):
                raise HTTPException(429, "视频任务并发已达上限，请等待已有任务结束")
            recent = db.execute("SELECT 1 FROM video_jobs WHERE owner=? AND created>?", (user.id, time.time()-60)).fetchone()
            if recent:
                raise HTTPException(429, "每位用户每分钟最多提交一个视频任务")
            job_id = "vid_" + uuid.uuid4().hex
            channel = channels[int(time.time_ns()) % len(channels)]
            # Persist before reserving so crash recovery can identify incomplete setup.
            stored = {**body.model_dump(), "protocol": model["protocol"], "upstream_payload": upstream_payload}
            db.execute("INSERT INTO video_jobs(id,owner,created,state,payload,channel,upstream_name,amount,client_request_id) VALUES(?,?,?,'preparing',?,?,?,?,?)",
                       (job_id, user.id, time.time(), json.dumps(stored), channel_key(channel), str(channel.get("name") or "sub2api"), amount, body.client_request_id))
            db.commit()
            reservation = self.users.reserve_quota(user.id, amount, action="video_generate", model=body.model, metadata={"video_job_id": job_id})
            if not reservation:
                db.execute("DELETE FROM video_jobs WHERE id=?", (job_id,))
                db.commit()
                raise HTTPException(402, "用户积分不足")
            db.execute("UPDATE video_jobs SET reservation=?, state='queued' WHERE id=?", (reservation["id"], job_id))
        return self.get(user.id, job_id)

    def get(self, owner, job_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM video_jobs WHERE id=? AND owner=?", (job_id, owner)).fetchone()
        if not row:
            raise HTTPException(404, "视频任务不存在")
        response = {"request_id": row["id"], "status": row["state"], "created_at": row["created"], "credits": row["amount"]}
        payload = json.loads(row["payload"])
        response.update({key: payload.get(key) for key in ("prompt", "model", "duration", "resolution", "aspect_ratio", "mode")})
        response["accounted"] = bool(row["accounted"])
        if row["result"]:
            response["video"] = json.loads(row["result"])
        if row["error"]:
            response["error"] = row["error"]
        return response

    def list(self, owner, limit=50):
        with self.connect() as db:
            rows = db.execute("SELECT id FROM video_jobs WHERE owner=? ORDER BY created DESC LIMIT ?", (owner, max(1, min(100, limit)))).fetchall()
        return {"items": [self.get(owner, row["id"]) for row in rows]}

    def update(self, job_id, **values):
        with self.connect() as db:
            db.execute("UPDATE video_jobs SET " + ",".join(k+"=?" for k in values) + " WHERE id=?", (*values.values(), job_id))

    def reconcile(self, job_id, body):
        if bool(body.remote_id) == body.confirmed_failed:
            raise HTTPException(400, "请提供上游任务 ID，或确认上游未生成（二选一）")
        with self.lock, self.connect() as db:
            row = db.execute("SELECT * FROM video_jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise HTTPException(404, "视频任务不存在")
            if row["state"] != "unknown":
                raise HTTPException(409, "仅可核对提交结果未知的任务")
            db.execute("UPDATE video_jobs SET state=?, remote_id=?, error=? WHERE id=?",
                       ("pending" if body.remote_id else "failed", body.remote_id, "" if body.remote_id else "管理员确认生成失败，积分将自动退回", job_id))
        return self.get(row["owner"], job_id)

    def tick(self, row):
        payload = json.loads(row["payload"])
        protocol = payload.get("protocol", "grok")
        if row["state"] in {"done", "failed", "expired"}:
            if row["reservation"]:
                if row["state"] == "done":
                    self.users.settle_quota_reservation(row["reservation"], row["amount"], metadata={"video_job_id": row["id"]})
                else:
                    self.users.refund_quota_reservation(row["reservation"], reason="video_failed")
            user = self.users.get_user(row["owner"])
            if user:
                self.log_usage(
                    user, action="video_generate", prompt=payload["prompt"], model=payload["model"],
                    status="success" if row["state"] == "done" else "failed", started_at=row["created"],
                    error=row["error"], upstream_name=row["upstream_name"],
                    usage_amount=row["amount"] if row["state"] == "done" else 0,
                    details={"duration": payload.get("duration"), "resolution": payload.get("resolution"), "mode": payload.get("mode")},
                )
            self.update(row["id"], accounted=1)
            return
        if row["state"] in {"unknown", "preparing"}:
            return
        # Model catalog edits must not strand existing paid jobs. Only the
        # original enabled channel and credential are required for polling.
        channel = next((c for c in self.config.get_video_upstreams() if c.get("enabled") and channel_key(c) == row["channel"]), None)
        if not channel:
            self.update(row["id"], error="原上游不可用，请管理员恢复原渠道配置后继续查询")
            return
        headers = {"Authorization": "Bearer " + str(channel["api_key"])}
        creating = row["state"] == "queued"
        if creating:
            self.update(row["id"], state="submitting")
        try:
            with requests.Session() as session:
                if creating:
                    response = session.post(endpoint(channel, protocol=protocol), json=payload.get("upstream_payload", payload), headers=headers, timeout=(10, 45), allow_redirects=False)
                else:
                    response = session.get(endpoint(channel, "/" + quote(row["remote_id"], safe=""), protocol), headers=headers, timeout=(10, 30), allow_redirects=False)
                if response.status_code >= 400:
                    if creating and response.status_code in {400,401,403,404,422,429}:
                        self.update(row["id"], state="failed", error=f"上游拒绝请求（HTTP {response.status_code}）")
                        return
                    raise ValueError("upstream unavailable")
                response.raise_for_status()
                data = response.json()
                if creating:
                    remote_id = data.get("request_id") or data.get("id")
                    if not isinstance(remote_id, str) or not remote_id or len(remote_id) > 512:
                        raise ValueError("missing request id")
                    self.update(row["id"], state="pending", remote_id=remote_id, error="")
                elif data.get("status") == ("succeeded" if protocol == "seedance" else "done"):
                    video = data.get("content" if protocol == "seedance" else "video") or {}
                    url = video.get("video_url" if protocol == "seedance" else "url")
                    if not isinstance(url, str) or urlsplit(url).scheme not in {"https", "http"}:
                        raise ValueError("invalid video result")
                    self.update(row["id"], state="done", result=json.dumps({"url": url}), error="")
                elif data.get("status") in {"failed", "expired", "cancelled"}:
                    self.update(row["id"], state="expired" if data["status"] == "expired" else "failed", error="上游视频生成失败或已过期，积分将自动退回")
                else:
                    self.update(row["id"], error="")
        except (requests.RequestException, ValueError, TypeError, AttributeError):
            self.update(row["id"], **({"state": "unknown", "error": "提交结果未知，请联系管理员核对；不会自动重试"} if creating else {"error": "暂时无法查询上游，后台将继续查询"}))
        finally:
            if creating and "upstream_payload" in payload:
                # No resubmission is allowed, so retain only asset IDs and user
                # parameters, not large data URIs or signed provider fetch URLs.
                payload.pop("upstream_payload")
                self.update(row["id"], payload=json.dumps(payload))

    def run(self):
        while not self.stop_event.is_set():
            try:
                self.assets.prune()
                with self.connect() as db:
                    rows = db.execute("SELECT * FROM video_jobs WHERE accounted=0 ORDER BY created").fetchall()
                for row in rows:
                    if self.stop_event.is_set():
                        break
                    try:
                        self.tick(row)
                    except Exception as exc:
                        logging.getLogger(__name__).warning("Video job will retry after %s", type(exc).__name__)
            except Exception as exc:
                # No provider responses or secrets in logs. Durable jobs retry next tick.
                logging.getLogger(__name__).warning("Video worker will retry after %s", type(exc).__name__)
            self.stop_event.wait(5)

"""Bounded owned uploads, with expiring unguessable read URLs for media providers."""
import base64
import io
import json
import secrets
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

IMAGE_LIMIT = 5 * 1024 * 1024
AUDIO_LIMIT = 20 * 1024 * 1024


class VideoAssets:
    def __init__(self, service):
        self.service = service
        self.root = service.path.parent / "video_assets"
        self.root.mkdir(parents=True, exist_ok=True)
        with service.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS video_assets (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, token TEXT UNIQUE NOT NULL,
                kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
                created REAL NOT NULL, expires REAL NOT NULL)""")

    def prune(self):
        with self.service.lock, self.service.connect() as db:
            rows = db.execute("SELECT id FROM video_assets WHERE expires<?", (time.time(),)).fetchall()
            for row in rows:
                (self.root / row["id"]).unlink(missing_ok=True)
            db.execute("DELETE FROM video_assets WHERE expires<?", (time.time(),))

    def save(self, owner, content, kind):
        if kind not in {"image", "audio", "video"}:
            raise HTTPException(400, "仅支持参考图片或音频")
        limit = IMAGE_LIMIT if kind == "image" else 50 * 1024 * 1024 if kind == "video" else AUDIO_LIMIT
        if not content or len(content) > limit:
            raise HTTPException(413, "图片最多 5 MB，音频最多 20 MB，视频最多 50 MB")
        if kind == "image":
            try:
                with Image.open(io.BytesIO(content)) as img:
                    if img.format not in {"PNG", "JPEG", "WEBP"} or img.width * img.height > 20_000_000:
                        raise ValueError()
                    img.load()
                    output = io.BytesIO()
                    img.convert("RGB").save(output, format="JPEG", quality=90)
                    content = output.getvalue()
                    if len(content) > IMAGE_LIMIT:
                        raise ValueError()
                mime = "image/jpeg"
            except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
                raise HTTPException(400, "参考图须为有效的 PNG、JPEG 或 WebP，最多 2000 万像素") from None
        elif kind == "video":
            if content[4:8] != b"ftyp":
                raise HTTPException(400, "参考视频仅支持 MP4，最多50 MB、1–60秒")
            mime = "video/mp4"
        else:
            wav = content[:4] == b"RIFF" and content[8:12] == b"WAVE"
            mp3 = content[:3] == b"ID3" or (len(content) > 2 and content[0] == 255 and content[1] & 0xE0 == 0xE0)
            if not wav and not mp3:
                raise HTTPException(400, "音频仅支持 MP3 或 WAV")
            if not shutil.which("ffprobe"):
                raise HTTPException(503, "服务器音频校验组件未安装，请联系管理员更新镜像")
            mime = "audio/wav" if wav else "audio/mpeg"
        self.prune()
        asset_id = uuid.uuid4().hex
        path = self.root / asset_id
        with self.service.lock, self.service.connect() as db:
            usage = db.execute("SELECT COALESCE(SUM(size),0), COALESCE(SUM(CASE WHEN owner=? THEN size ELSE 0 END),0), SUM(CASE WHEN owner=? THEN 1 ELSE 0 END) FROM video_assets", (owner, owner)).fetchone()
            if usage[0] + len(content) > 500 * 1024 * 1024 or usage[1] + len(content) > 80 * 1024 * 1024 or (usage[2] or 0) >= 40:
                raise HTTPException(429, "视频参考素材空间已达上限，请稍后重试")
            try:
                path.write_bytes(content)
                if kind in {"audio", "video"}:
                    try:
                        result = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", str(path)], capture_output=True, timeout=10, check=True)
                        probe = json.loads(result.stdout)
                        duration = float(probe.get("format", {}).get("duration", 0))
                        streams = probe.get("streams", [])
                        if not (1 if kind == "video" else 2) <= duration <= (60 if kind == "video" else 15) or not any(s.get("codec_type") == kind for s in streams):
                            raise ValueError()
                    except (subprocess.SubprocessError, ValueError, KeyError):
                        raise HTTPException(400, "素材必须可读取：音频2–15秒，视频1–60秒") from None
                now = time.time()
                db.execute("INSERT INTO video_assets VALUES(?,?,?,?,?,?,?,?)", (asset_id, owner, secrets.token_urlsafe(32), kind, mime, len(content), now, now + 48 * 3600))
            except Exception:
                path.unlink(missing_ok=True)
                raise
        return {"asset_id": asset_id, "kind": kind, "size": len(content)}

    def resolve(self, owner, asset_id, kind, protocol):
        with self.service.connect() as db:
            row = db.execute("SELECT * FROM video_assets WHERE id=? AND owner=? AND kind=? AND expires>?", (asset_id, owner, kind, time.time())).fetchone()
        if not row:
            raise HTTPException(400, "参考素材不存在、已过期或不属于当前用户，请重新上传")
        base = self.service.config.get().get("video_public_base_url", "")
        if protocol == "grok" and kind == "image" and not base:
            return "data:image/jpeg;base64," + base64.b64encode((self.root / asset_id).read_bytes()).decode()
        if not base:
            raise HTTPException(400, "管理员尚未配置视频素材公网地址")
        return base.rstrip("/") + "/video-assets/" + row["token"]

    def public_file(self, token):
        with self.service.connect() as db:
            row = db.execute("SELECT * FROM video_assets WHERE token=? AND expires>?", (token, time.time())).fetchone()
        if not row or not (self.root / row["id"]).is_file():
            raise HTTPException(404, "素材已过期或不存在")
        return self.root / row["id"], row["mime"]

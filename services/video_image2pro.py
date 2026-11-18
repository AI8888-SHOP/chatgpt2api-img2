"""Explicit Image2Pro contract. No model-ID inference or production addresses."""
import base64
import json
import re
import time
from fastapi import HTTPException


def prepare(service, user, body, model):
    if body.duration not in model["durations"] or body.resolution not in model["resolutions"] or body.aspect_ratio not in model["aspect_ratios"]:
        raise HTTPException(400, "时长、分辨率或比例不符合模型能力；固定时长模型须按实际时长计价")
    if body.reference_audios or body.mode == "edit":
        raise HTTPException(400, "此协议不支持参考音频或视频编辑")
    images, videos = body.reference_images, body.reference_videos
    roles = [image.role for image in images]
    if len(images) > model["max_reference_images"]:
        raise HTTPException(400, "参考图数量超出上限")
    if any(roles):
        if not model["supports_frame_control"] or None in roles or roles.count("first_frame") != 1 or roles.count("last_frame") > 1:
            raise HTTPException(400, "首尾帧角色无效：必须有且仅有一个首帧，不能混用普通图")
    elif images and not model["supports_reference_images"]:
        raise HTTPException(400, "此模型只接受带角色的首帧或首尾帧")
    payload = {"model": body.model, "prompt": body.prompt, "duration": body.duration,
               "resolution": body.resolution, "aspect_ratio": body.aspect_ratio}
    if body.size:
        payload["size"] = body.size
    if videos:
        if not model["supports_extend"] or images or body.duration != 8 or body.resolution != "720p":
            raise HTTPException(400, "续写仅支持开放此能力的模型、8秒720p，不能同时带图")
        source = videos[0].url
        if not source or videos[0].role:
            raise HTTPException(400, "续写须提供本站原任务的 extend://MEDIA_ID 或真实成品直链")
        # Only reuse this owner's result on the same model, never another user's
        # media ID, arbitrary uploaded video or a task ID mistaken for media ID.
        with service.connect() as db:
            rows = db.execute("SELECT payload,result,channel FROM video_jobs WHERE owner=? AND state='done' AND accounted=1", (user.id,))
            match = next((row for row in rows if json.loads(row["payload"])["model"] == body.model and
                          source in {"extend://" + str(json.loads(row["result"] or "{}").get("media_id", "")), json.loads(row["result"] or "{}").get("source_url")}), None)
        if not match or source == "extend://":
            raise HTTPException(400, "续写来源须为本人同模型已完成任务的媒体结果，不能使用任务ID")
        payload["reference_videos"] = [source]
        body.mode = "extend"
        payload["_source_channel"] = match["channel"]
    elif body.mode == "extend":
        raise HTTPException(400, "续写缺少来源")
    if images:
        output = []
        for image in images:
            if image.url:
                try:
                    prefix = re.match(r"^data:image/(png|jpeg|webp);base64,", image.url)
                    if not prefix:
                        raise HTTPException(400, "请先通过视频素材上传接口上传参考图，再使用 asset_id")
                    encoded = image.url[prefix.end():]
                    if len(encoded) > 4 * ((5 * 1024 * 1024 + 2) // 3):
                        raise HTTPException(413, "参考图片最多 5 MB")
                    raw = base64.b64decode(encoded, validate=True)
                    image.asset_id = service.assets.save(user.id, raw, "image")["asset_id"]
                    image.url = None
                except HTTPException:
                    raise
                except Exception:
                    raise HTTPException(400, "参考图读取失败：请上传有效图片文件或 Base64 图片") from None
            # Owner/kind/expiry validation before reading; image2pro accepts data
            # URLs so no publicly accessible material route is required.
            with service.connect() as db:
                asset = db.execute("SELECT id FROM video_assets WHERE id=? AND owner=? AND kind='image' AND expires>?", (image.asset_id, user.id, time.time())).fetchone()
            if not asset:
                raise HTTPException(400, "参考素材不存在、已过期或不属于当前用户")
            url = "data:image/jpeg;base64," + base64.b64encode((service.assets.root / image.asset_id).read_bytes()).decode()
            output.append({"url": url, **({"role": image.role} if image.role else {})})
        payload["reference_images"] = output
        body.mode = "reference"
    return payload


def result_metadata(data):
    result = {}
    for key in ("duration", "resolution", "size", "aspect_ratio", "media_id"):
        value = data.get(key)
        if isinstance(value, (str, int, float)) and not isinstance(value, bool) and len(str(value)) <= 200 and re.fullmatch(r"[A-Za-z0-9_.:x-]+", str(value)):
            result[key] = value
    return result

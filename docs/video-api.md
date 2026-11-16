# sub2api 视频生成

首页 `/image` 提供「生成图片 / 生成视频」切换，保留两套 UI 配色。视频支持文本生成、单图首帧生成、参考素材生成，任务与历史保存在服务端，刷新页面后恢复查询。

后台「视频生成」独立配置 `video_models`、`video_upstreams`、默认视频模型、能力限制和积分单价。一个视频渠道可路由多个模型；视频与图片渠道互不混用。只有启用且有有效渠道的模型会出现在首页。默认关闭；使用上游推理 API Key，不使用 sub2api 管理员登录凭证。

| 协议 | 上游路径 | 参考图 | 音频 |
| --- | --- | --- | --- |
| Grok | `/v1/videos/generations` | 单图首帧、参考图列表；旧版最多 7 图/10 秒，1.5 最多 14 图/15 秒 | `generate_audio` 控制声音；1.5 支持 `reference_audios[].voice_id`，不开放自有音频上传 |
| Seedance | `/api/v3/contents/generations/tasks`（也支持 `/v1`、`/v3` 前缀） | `content[].image_url` + `first_frame` 或 `reference_image` | 支持的模型可使用 `content[].audio_url` + `reference_audio`；后台确认能力后开启 |

Grok 的自有音频参考是上游合作伙伴能力，公开 SDK 只支持预设音色，本项目不猜测未公开字段。Seedance 音频上传默认关闭；需确认 sub2api 版本含 Ark 原生接口，实际模型支持参考音频（如相应的 Seedance 2.0 模型），并配置 `video_public_base_url` 为本站可被上游读取的 HTTPS 地址。本机原有 sub2api 0.1.179 的源码不含此原生协议，本次代码修改不升级该服务。

后台可配置每个模型的最短/最长时长、参考模式最长时长、参考图上限、480p/720p 和音频能力。模型 ID 可使用上游别名，不要求包含 `video` 字符。

使用本站用户令牌提交（不是上游 Key）：

```http
POST /v1/videos/generations
Authorization: Bearer <本站用户令牌>
Content-Type: application/json

{"model":"grok-imagine-video","prompt":"海边日出，镜头缓慢推进","duration":5,"aspect_ratio":"16:9","resolution":"480p","mode":"text","generate_audio":true,"client_request_id":"unique-client-request-0001"}
```

返回 HTTP 202：`{"request_id":"vid_...","status":"queued","credits":5,"created_at":...}`。

用同一用户令牌查询 `GET /v1/videos/generations/{request_id}`；`GET /v1/video-jobs` 返回当前用户最近 50 个任务。状态包括 `queued`、`submitting`、`pending`、`done`、`failed`、`expired`、`unknown`；成功时返回 `video.url`。Seedance 的 `succeeded` 和 `content.video_url` 会统一转换为本站格式。URL 是上游临时下载地址，应及时保存；不提供成品视频的永久本地存储。编辑和延长视频不在本版范围内。

上传参考素材：用户鉴权 `POST /v1/video-assets`，multipart 字段 `kind=image|audio`、`file`，返回 `asset_id`。提交时设置 `mode=image|reference`，图片为 `reference_images:[{"asset_id":"..."}]`，音频为 `reference_audios:[{"asset_id":"..."}]`；Grok 音色使用 `reference_audios:[{"voice_id":"eve"}]`（最多三个）。素材归属检查、模型能力校验和时长检查均在扣费前完成。

图片支持 PNG/JPEG/WebP，每张 5 MB、最多 2000 万像素；服务端重编码为 JPEG。音频仅支持 MP3/WAV，每个 20 MB、2–15 秒，通过 ffprobe 验证。音频文件最多一个且需配合参考图。素材保存在 `data/video_assets`，48 小时后清理；每用户最多 40 个/80 MB，全站 500 MB。Grok 图片通过 data URI 发送；Seedance 通过 `/video-assets/{随机令牌}` 的限时读取链接发送。链接是供上游读取的访问凭证，持有链接的人在到期前可读取，不要公开分享。实例需能被上游通过 HTTPS 访问，且代理上传大小设置应至少 21 MB。Docker 镜像和 CI 已加入 ffmpeg（含 ffprobe）。

限制：提示词最多 8000 字符；时长整数 1–15 秒；480p / 720p，两种分辨率的每秒积分可在后台分别设置，默认分别为 1、2。单用户一分钟一次、同时一个未结束任务；全站八个未结束任务。提交前按当时价格预扣，成功按预扣金额结算，明确失败/过期退款。用量记录包含渠道名称。轮询不会重复扣费，用户不能查询他人任务。

任务保存在 `data/video_jobs.db`，不存上游密钥；已有任务绑定原上游地址、密钥指纹及提交时协议。修改模型列表不会影响已提交任务查询；修改/停用渠道后需恢复原配置。客户端重复使用同一 `client_request_id` 会返回同一任务，不重复扣费或生成。应用重启恢复查询，不会重复 POST。部署时必须保留任务库、素材目录及用户数据库；仅支持单进程应用实例。

提交时网络断开、上游 5xx、返回无法识别的任务 ID，或进程在提交过程中终止时，任务进入 `unknown`，积分保留且占用并发名额，防止重复付费生成。管理员核对上游记录后，使用管理令牌调用：

```http
POST /api/video-jobs/{request_id}/reconcile
Authorization: Bearer <管理令牌>
Content-Type: application/json

{"remote_id":"上游真实任务 ID"}
```

这会恢复查询原任务。只有确认上游未生成时才提交 `{"confirmed_failed":true}` 退款；两个字段不可同时设置。不要用新提交来代替查询。生成完成后端会自动处理结算，无需用户持续开着页面。

协议依据：[sub2api Grok 转发](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/grok_media.go)、[sub2api Seedance](https://github.com/Wei-Shaw/sub2api/blob/main/docs/seedance-api.md)、[Grok 参考图与音色](https://docs.x.ai/developers/model-capabilities/video/reference-to-video)、[Ark 原生类型](https://github.com/volcengine/volcengine-go-sdk/blob/master/service/arkruntime/model/content_generation.go)。

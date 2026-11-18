# 视频 API 与模型能力

登录本站后访问 /api-docs 查看个人 API Key 的图片生成/编辑、视频全流程 curl 示例及当前模型能力；/video 为独立视频工作室。此文档取代旧版仅 Grok/Seedance 的说明。

## 本站契约

Base URL 是本站地址（不含 /v1），使用 Authorization: Bearer YOUR_PERSONAL_API_KEY，不使用管理员或上游密钥。

- GET /v1/models 合并模型目录；GET /v1/video-models 仅返回已启用且已路由的视频及能力 metadata，不含渠道地址或密钥。
- POST /v1/videos 创建，HTTP202，返回同值 id/request_id（本站任务编号）。
- GET /v1/videos/{id} 查询；GET /v1/video-jobs 列出本人历史。
- GET/HEAD /v1/videos/{id}/content 鉴权下载本地成品，非owner拒绝。
- 保留 /v1/videos/generations 创建、/v1/videos/generations/{id} 查询及 /v1/video-jobs/{id}/content 下载。

本站状态为 preparing/queued/submitting/pending/downloading/done/failed/expired/unknown。HTTP200不是生成成功；done且video.local=true后下载。每10秒查询原任务，不重建。

## 参数与协议

公共字段：model、prompt、duration、seconds、resolution、aspect_ratio、size、reference_images、reference_videos、client_request_id。duration支持整数/数字串/8s，与seconds共存必须一致。size对应：
1280x720=720p/16:9，720x1280=720p/9:16，1920x1080=1080p/16:9，1080x1920=1080p/9:16。与分辨率/比例同时给出必须一致并符合模型能力。图片接口使用size，不是resolution。

Grok保持generations或显式videos别名，duration/request_id/done/video.url合同；native使用videos、seconds/id/completed及鉴权content下载；Seedance保留Ark原生合同。Image2Pro使用videos、duration/reference_images/id/completed，从url或output[0].url下载，**上游没有/content**；成品安全转存本站私有缓存，不公开签名源地址。

Image2Pro须后台显式选择协议、能力档位、实际公开模型ID与原生路由渠道，不能按英文标题猜ID：
- Veo Lite/Fast：8秒、720/1080p、普通参考图1–3张或首尾帧、支持续写。
- Veo Quality：相同尺寸时长，但只接受带角色首尾帧。
- Omni1.1：4/6/8/10秒、720p、普通图1–3张。
- Omni1.2：固定15秒、720p、普通图1–3张。
Omni不支持帧角色/续写；五类均不支持音频参考。续写固定8秒720p，无图片，必须本人同模型已结算结果的extend://MEDIA_ID或原真实直链，固定原渠道，不是taskID。

Image2Pro图片可用公开HTTPS URL、PNG/JPEG/WebP DataURL、{url,role}或owner素材{asset_id,role}。role仅first_frame/last_frame，首尾各最多一张且必须有首帧，不能混普通图。其他协议继续用已有素材合同。POST /v1/video-assets接受multipart kind=image|audio|video与file，受模型能力限制。每图5MB/2000万像素，JSON创建体24MB解析前限流；素材48小时过期，每用户40个/80MB、全站500MB。公网下载禁私网/重定向，固定DNS地址并验证TLS，不带上游Authorization；成品200MB且有时间限制。

## 积分、幂等与恢复

每模型按离散/固定时长校验，不能通用假定1–15秒或默认5秒480p。按模型 billing_mode 预扣：per_second（默认）按申请时长乘分辨率单价，per_request 按分辨率单价收取一次、不乘时长；按次必须显式配置各开放清晰度价格。后台可用 durations 限定固定可选秒数，空列表表示连续范围，非空时前后端均拒绝其他秒数，成品保存成功按原预扣结算，明确失败退款；上游实际参数及文件测量值单独记录，不用申请值冒充实际值。每用户每分钟一次、同时一个任务，全站八个。

client_request_id/Idempotency-Key为6–120位字母数字、点、下划线或连字符；同时给出须相同。同owner同号返回旧任务，新任务参数冲突409；别名和默认值按原能力快照归一化。旧无指纹任务保留兼容行为，上游使用稳定本站业务编号。原渠道和协议快照不改，重启不重复POST。

创建超时/408/无ID的5xx保持unknown且预扣保留；Image2Pro明确402/413/415等拒绝按失败退款。查询401/403/404/410、七天期限、下载永久错误或六小时期限转unknown供管理员核对；网络暂态仅重试GET。已生成成品不自动退款。管理员通过既有POST /api/video-jobs/{id}/reconcile恢复原remote_id，或仅在明确未生成证据下confirmed_failed=true；不要再创建付费任务代替核查。

本地成品可管理员清理，清理后不可下载但任务/账目仍保留。部署保留data任务库、用户库、素材与成品；仍为单进程部署。

本轮现有渠道GET模型列表没有Veo/Omni及能力metadata，生产尚未启用；真实生成未实测。需管理员确认原生/videos可用、实际ID和路由，不能添加名称就宣称可生成。

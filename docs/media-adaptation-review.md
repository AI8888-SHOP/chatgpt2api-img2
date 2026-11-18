# 媒体适配待审阅（基于 v1.2.14，尚未发版）

## 图片尺寸与格式

- 最新静态复核后收紧：没有可信尺寸能力表的模型不再展示计算出的 1K/2K/4K 预设，仅提供 auto 和明确标注“尺寸能力待上游确认”的自定义请求。保留正整数宽×高原样发送，不自动降低尺寸。
- Select 以真实尺寸字符串作为值。切到旧 Grok 等受限模型而原尺寸不兼容时，清空选项并要求明确重选，不自动替换为低清尺寸；未知模型、Grok 2.0、Nano Banana 保留合法自定义值。
- 只读查询实际 V6 渠道 `GET /v1/models` 返回 HTTP 200；`gpt-image-2.6` 没有返回尺寸能力枚举。模型配置能力表及其后台编辑尚未接入；获取可信枚举后再开放对应模型预设，不能把下表当作支持证据。
- 文生图 JSON、同步/异步图生图 multipart 均向外部图片渠道传递 `size`。`auto` 时不传固定尺寸；不额外发送 `resolution/width/height/aspect_ratio`，避免多个字段冲突。
- 修复图生图此前在前端、后端丢失参数，最后被硬编码成 `1024x1024` 的问题。
- 旧 `grok-imagine-image` / `grok-imagine-image-edit` 保留既有尺寸适配合同；前端只显示已有的五个支持尺寸，旧会话的其他尺寸须重新选择，不再无提示提交后映射。实际配置中的 `grok-imagine-image-2.0` 不套用旧模型枚举，也不会因切换模型自动降尺寸。账号池没有结构化尺寸接口，图生图沿用文生图的尺寸提示词方式，不能承诺像素级精确输出。
- 缓存增加 `image_spec`：用户请求尺寸、实际出站尺寸、请求格式、成品实际宽高/格式/帧数。后台同时显示请求、出站和实际尺寸，不把请求的 4K 冒充实际 4K。元数据随缓存索引持久化，重载和扫描文件后仍保留。
- `gpt-image-2.6` 可选择 `output_format=gif`，生成接口发送 JSON，编辑接口发送 multipart。其他模型或账号池不允许 GIF；从 GIF 模型切换到其他模型会恢复 PNG。
- Base64/URL 结果均检查真实图片字节，按检测到的 MIME 保存与登记缓存。GIF 保留原始字节和动画帧，不重编码；请求 GIF 却返回 PNG/JPEG 等会报错，不能透传未验证的远程地址冒充成功。预览保持原图，下载与复用参考图支持 `.gif`。
- 通用不支持格式和 GIF 不符错误分开。整批图片先全部验证，再保存；任一图片落盘/元数据失败，撤销本批已保存文件和缓存索引，保留无关缓存，不把未结算批次留下为孤儿成品。

### 候选请求尺寸（尚未开放为模型选项）

短边按既有方式对齐 16 像素，标签比例是目标比例，以实际列出的像素为准。

### 最新缓存分页复核

列表改为同步 FastAPI 路由，由工作线程执行磁盘与数据库扫描，避免阻塞事件循环。视频使用数据库游标逐条读取，不再 fetchall 或全量排序；合并使用有界 top-k 选择，limit 最大 500、offset 最大 10000，同时流式计算准确数量与大小。现有图片索引仍为内存 JSON 索引；准确统计仍是 O(N) 扫描，不宣称已改为数据库索引分页。新增 2000 条流式视频合并回归，检查分页顺序、准确总数及字节统计。

| 比例 | 1K 请求尺寸 | 2K 请求尺寸 | 4K 请求尺寸 |
| --- | --- | --- | --- |
| 1:1 | 1024×1024 | 2048×2048 | 4096×4096 |
| 3:2 | 1024×688 | 2048×1360 | 4096×2736 |
| 2:3 | 688×1024 | 1360×2048 | 2736×4096 |
| 4:3 | 1024×768 | 2048×1536 | 4096×3072 |
| 3:4 | 768×1024 | 1536×2048 | 3072×4096 |
| 16:9 | 1024×576 | 2048×1152 | 4096×2304 |
| 9:16 | 576×1024 | 1152×2048 | 2304×4096 |

### GIF 契约与未实测范围

总协调已确认 V5 使用原生 images 端点；客户端按下列合同实现，不再等待接口选择。本轮没有新增付费请求，也没有已知的 gpt-image-2.6 实际 GIF 响应；mock 只证明客户端处理，不证明供应商生成能力：

1. `POST /v1/images/generations` JSON：`model=gpt-image-2.6, output_format=gif, size=用户请求尺寸`。
2. `POST /v1/images/edits` multipart：`image`、`model`、`prompt`、`size`、`output_format=gif`，仍沿用 `response_format=url`。
3. 返回 `data[].b64_json` 或 `data[].url`，对应实际可解析的 GIF87a/GIF89a 字节。URL 通常应响应 `image/gif`，也接受可验证的二进制响应；客户端按字节纠正错误的图片 MIME。GIF 上限沿用 25 MiB，并限制 1000 帧。
4. 不支持的模型、参数应明确拒绝。各尺寸、动画与图生图 GIF 的实际模型能力未进行付费实测。

## 视频比例与缓存

- Grok：`duration=10, resolution=1080p, aspect_ratio=16:9, image:{url:...}`。
- Native：`seconds=10, resolution=1080p, aspect_ratio=16:9, input_reference:...`。
- 没有添加冲突的 `size/width/height/ratio`；native 编辑/延长按原合同省略比例与分辨率。模型、渠道哈希、协议/端点快照及已受理任务不变。
- 后台既有缓存页从 durable job 自动发现历史 done/accounted 视频，与图片一起过滤、排序、分页和统计，不通过 limit 百万请求拼页。支持鉴权加载/播放/下载和幂等删除。视频行不返回远程签名 URL，所有缓存列表不再返回原始 API key 或私密提示词。
- 管理员内容接口仅通过管理员鉴权，用户内容接口仍按 owner 校验，文件不加入公共静态目录。浏览器使用鉴权请求得到 Blob，关闭/卸载时回收地址。
- 缓存删除只作用于明确选择的已结算 done 视频，不删除生成中任务或输入参考素材，不修改任务结算/余额。原 result 字段完整保留，仅新增 `cache_deleted` 和 `cache_deleted_at`，后台审计记录被清理的视频 ID。用户端显示成品已清理/过期与历史文件无法下载，不误报退款。重复清理不变更时间或账目。
- 未落盘的历史外部 URL 仅列为“无本地缓存”，不提供不安全外链或自动服务器抓取；它们不计本地文件体积。视频没有新增自动过期删除规则。

## 回归结果

- 最新静态复核修订后后端全量：209 项通过（33.566 秒）；专项覆盖 GIF 类型/帧/尺寸元数据、同步异步参数、通用错误与 GIF 错误、多图后续失败回滚、视频比例快照、历史资产扫描、流式混合分页、鉴权、result 审计保留及幂等清理。
- 前端 Node 单测：10 项通过；TypeScript `tsc --noEmit` 通过。未在生产机编译镜像或运行前端生产构建。
- 复用已有成功视频文件的隔离缓存验收：管理员 GET/HEAD、原字节响应、匿名/普通用户拒绝、错误 owner 拒绝、清理后 404、重复清理不改变余额均通过。ffprobe 再核对为 1920×1088、10.041667 秒；没有重新生成视频，没有清理线上原文件。
- `git diff --check` 通过。新后台页面尚未进行浏览器交互验收；发布前可用 GitHub 构建的候选镜像补验，尤其是管理员 Blob 播放/下载和 GIF 预览。

## 修改文件

- 图片请求和存储：`services/api.py`、`services/chatgpt_service.py`、`services/upstream_image_service.py`、`services/user_image_storage.py`、`services/generated_image_cache_service.py`。
- 视频和后台接口：`services/video_service.py`、`admin/api.py`。
- 图片界面：`web/src/lib/image-sizes.ts`（新增）、`web/src/lib/api.ts`、`web/src/app/image/page.tsx`、`web/src/app/image/components/size-selector.tsx`、`web/src/app/image/components/image-composer.tsx`、`web/src/components/image-lightbox.tsx`。
- 视频和缓存界面：`web/src/app/image/components/video-workspace.tsx`、`web/src/app/admin/cache/page.tsx`。
- 回归：`tests/test_media_adaptation.py`（新增）、`tests/test_usage_upstream.py`、`tests/test_video_service.py`、`tests/test_image_conduit_flow.py`、`web/tests/media-adaptation.test.cjs`（新增）。
- 本文档：`docs/media-adaptation-review.md`（新增）。

## 发布边界

v1.2.14 已部署且原付费任务完成：250 积分仅结算一次，实际视频 1920×1088、10.041667 秒。本轮不提交、不推送、不构建生产镜像、不部署；总协调审阅后再决定下一版本和 GIF 能力开放方式。价格、线上配置、生产数据库与 V6 服务均不改动。

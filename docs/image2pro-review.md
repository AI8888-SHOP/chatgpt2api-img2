# Image2Pro / 视频 API 适配：待独立复核

基线 main：6199c9ff9ae3ab05a03acfb396f7306e46738006。生产保持 v1.2.16，尚未提交本轮变更、未部署、未进行付费生成或本机编译。

## 实现与边界

- 显式 `image2pro` 协议及五个能力档位，不根据模型名推断。后台填写实际公开模型 ID、可透传原生 POST/GET `/v1/videos` 的渠道，再选择 Veo Lite/Fast/Quality 或 Omni1.1/1.2 档位。能力由服务端统一规范化，工作室和文档使用同一已启用且已路由目录。
- 新旧创建、查询及下载别名共用服务和个人 Key 鉴权；模型发现有 `/v1/video-models`，并合并到 `/v1/models`。响应为本站 HTTP202、同值 id/request_id、本站任务状态，非上游原始响应。
- duration/seconds、size/resolution/aspect_ratio 在预扣前校验，固定/离散时长准确计价。省略默认和等价别名按原能力快照形成不可变指纹；旧无指纹记录保持原幂等。并发同号返回同任务；跨 owner 隔离。上游收到稳定本站任务号与 Idempotency-Key。
- 普通图、首尾帧互斥，角色和数量受模型能力约束；DataURL/公网 URL 导入 owner 素材并接受原素材配额、格式及像素限制。完整 JSON 解析前鉴权及 24MB 流上限。数据库不持续保存原 Base64，创建后清除上游大请求体。
- HTTPS 媒体 GET 验证全部 DNS 地址为公网并固定连接 IP，TLS 验证原主机名，禁用代理/重定向/重试，不带任何渠道 Authorization。参考图最多5MB，成品最多200MB，流读取有超时及总时限。
- `completed` 从 root url 或 output[0].url 读取，保留 media_id 及实际返回字段；安全转存、ffprobe 后才完成和结算。受保护 GET/HEAD 下载不泄露签名源 URL。测量值单独记录，不用请求时长替代实际时长；本站仍按已预扣的申请时长价格结算，不增加费用。
- 续写只接受本人同模型已结算结果的 media_id/原直链，固定原渠道及8秒720p；不是 task ID，不接受任意上传视频或其他用户结果。
- 创建402/413/415在 Image2Pro 协议下明确失败退款；408/5xx/无ID保持unknown、不重POST。查询401/403/404/410或七天期限、下载永久拒绝/无权/过期进入unknown供现有管理员reconcile；暂态下载只重试GET，六小时后也转核对，已生成不自动退款。
- 新增独立 `/video` 和 `/api-docs` 页面、个人登录校验、菜单及折叠侧栏入口。文档覆盖个人Key、图片生成/编辑size、视频创建查询下载、状态/错误/结算/幂等/素材/续写。

## 只读现场证据

现生产只有 grok-imagine-video-1.5（Grok videos别名），经现有渠道 GET /models 返回200；筛选 Veo/Omni/Grok 只发现 Grok 型号，没有 Veo/Omni，也没有能力metadata。没有修改生产配置。**Veo/Omni 尚未启用，实际链路和供应商生成未验证。** 现有网关原生透传能力与下级实际 `/videos` 可用性需要管理员确认，不用 Grok generations 转换代替。

## 验证

- 后端全量221项通过（40.123秒，包含新增12项时点）；随后新增固定渠道、永久HTTP/到期核对测试，Image2Pro专项15项通过（4.637秒）。
- 真实测试环境 uak_ Key 鉴权；Omni默认15秒预扣/结算；新旧content本人GET/HEAD与他人404；两种结果URL路径、安全转存/重启恢复/结算一次；旧Grok测试兼容。
- 并发同业务DataURL、别名等价、历史无指纹、角色限制、SSRF/重定向、限额前体积限制、查询/下载到期不重POST等覆盖。
- 前端3项纯JS/源码检查通过：实际限制/时长函数、菜单顺序与折叠、独立鉴权页面和文档端点。未运行本地TS编译或生产构建，尚无新页面浏览器验收。
- git diff --check通过。

## Diff 文件

后端：services/api.py、video_config.py、video_service.py；新增 video_image2pro.py、video_safe_http.py。

前端：web/src/lib/api.ts、新增video-controls.js；video-workspace.tsx、image-sidebar.tsx、video-settings-card.tsx、top-nav.tsx、design-provider.tsx；新增user-access.tsx、app/video/page.tsx、app/api-docs/page.tsx。

测试：tests/test_video_service.py、新增tests/test_image2pro_video.py、web/tests/video-contract.test.cjs。

下一步：协调确认本diff无阻塞后，在 codex/v5-veo-omni-api-docs 隔离分支提交完整修改并workflow_dispatch准确HEAD；不合main、不打tag、不Release、不部署、不推latest。需要GitHub前端/镜像构建证据后才可声称编译通过。

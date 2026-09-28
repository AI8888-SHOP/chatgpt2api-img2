# Editable Studio implementation and release gate

Requested outcome: API-driven PPTX and layered PSD, guided templates/free text,
editable plan confirmation, independent admin quotas/budgets, verified release and deployment.

## Live evidence (2026-09-28)

The configured Responses endpoint accepted the synthetic file probe but returned
no code_interpreter_call and no file citations: code interpreter was unavailable.
Do not equate reasoning access with a remote execution sandbox. Use validated JSON
plans and local fixed renderers; never eval model-generated code in the app.
The probe also reported proxy-added input tokens; admission must reserve overhead.

## 用户操作

进入「PPT / PSD」页面。PPT 可先查看 4 套模板的封面、内容页、图表页，
也可直接文字描述主题、受众、用途、页数、已有数据，选填 Logo / 产品图。
「帮我完善需求并生成方案」只整理大纲，不立刻扣生成积分。用户可编辑标题、
正文、页面顺序，确认页数和价格后制作。导出原生 PPTX、逐页实际预览、
PDF（在素材包内）及参考素材。不编造未提供的业绩数据，用待补充标注。

PSD 上传一张原图，描述要拆分的产品、标题、Logo、装饰。AI 给出图层及坐标，
可在原图覆盖预览上核对并编辑，再确认生成 PSD、透明 PNG 素材包与合成预览。
保持原图像素和位置，中文图层名称，透明度以原生像素 / 图层蒙版保存。
不开启修补时背景对应前景位置透明，完整合成应与原图一致。

任务在后台执行，可刷新 / 关闭页面后回来查看。失败自动退生成积分，可保留
当前方案重新制作。相同提交 ID 重试不会再次扣费，即使价格或草稿期限已变化。
新 PPT / PSD 草稿相互独立，A/B 界面试用与偏好投票继续保留。

## 后台配置与默认限额

系统设置 → 「PPT / PSD 文档工作室 · 独立 API」。新安装默认关闭。
可复用提示词优化的地址、密钥和模型（与其开关无关），也可独立配置。
支持 Responses 与 Chat Completions 视觉协议，思考强度 low / medium / high。
管理界面不返回保存的密钥，空白保留，清除操作会停用。

| 限制 | 默认 |
| --- | --- |
| 需求整理 | 3 次 / 分钟，20 次 / UTC 日，单草稿最多 3 次 |
| 正式制作 | 2 次 / 分钟，10 次 / UTC 日，1 个执行位 + 2 个排队位 / 用户 |
| 全站 | 整理和制作共享 2 个执行位，50 个排队位 |
| 单次文本输入 | 8,192 Token，包含固定说明和 Schema |
| 整理输出 | 8,192 Token，含思考 |
| 制作输出 | 单次 32,768，整任务 65,536 Token，最多重试一次 |
| 每次额外输入预留 | 上游指令 32,768，图片每张 8,192 Token |
| 总 Token 预算 | 每用户每日 500,000，全站每日 5,000,000 |
| 页数 / 图层 | PPT 最多 20 页；PSD 最多 30 层，包含背景 |
| 图片 / 文件 | 图片 10 MB / 16M 像素，PPT 最多 5 张；导出文件 150 MB |
| 超时 | 单次 API 180 秒，任务 900 秒，原生渲染最多 300 秒 |
| 存储 / 内存 | 5 GB 工作室预算；渲染进程虚拟内存 1,536 MB；文件保留 7 天 |
| 账号门槛 | 注册满 10 分钟，余额至少 1 积分 |
| 默认价格 | PPT 每页 1 积分，PSD 每任务 1 积分（部署需保留旧站点价格） |

这些参数均可在后台调整。按用户 ID 而不是会话 Token 计数，跨登录 / 重启仍生效。
先在 SQLite 事务中预留保守预算和积分，成功按上游用量结算，未知用量保留预算；
失败请求计次并保留实际 API 成本统计，退回的是用户制作积分。
这是 Token 预算，不是美元等货币精确账单；代理若自行注入额外指令，需调整预留。
仅接受网页登录会话，拒绝普通 API Key；会话仍可被脚本使用，真正防滥用依靠
后端预算、限流、账号门槛和价格。上传也限制并发、读取时长和请求体大小。

文件按用户归属校验，禁止匿名或跨用户读取。旧文件下载也改为认证下载，
旧版历史仍保留。数据库迁移只增加 studio_* 表 / 列，不重建用户、余额或会话表。

## 已执行验收（2026-09-28）

- 后端单元 / HTTP 接口测试：计费幂等、原子退款、预算、队列、用户隔离、密钥脱敏、输入限制和原生文件。
- 实际配置的上游 API：合成参考图 → AI 大纲 / 图层方案 → HTTP 确认 → 持久队列 → 受限子进程 → 下载。
- PPT 实测 3 页、48,023 字节原生 PPTX，逐页预览核对；PSD 实测 4 个有效语义层、1,538,362 字节，原生合成与原图逐像素一致。
- 工作室浏览器 54 项检查，覆盖 320 / 390 / 1366 宽度、两套配色和明暗模式，计划编辑、断网重试、下载、后台设置。
- 既有双 UI 试用回归 54 项检查通过；TypeScript 与 Next 生产构建通过。
- 发布前 GitHub CI 再执行后端测试；构建 amd64 / arm64。部署前备份数据 / 配置，部署后核对数据库与镜像版本。

合成实测证明接口与文件链路，不代表任意自然照片都能完美分层。
特别是毛发、透明物体、低对比度、复杂遮挡，应由用户检查边缘与元素归属。
scripts/check_studio_http.py 只用于隔离环境合成验收，连接从 stdin 提供，
不得复制客户数据库或把连接密钥写入仓库。线上验证不应调用隔离环境脚本。

PSD acceptance: real separate nonempty semantic pixel layers with alpha and matching
positions, meaningful names, PNG assets, visual comparison. Flattened-image input
does not contain original hidden pixels or fonts. Text pixel layers must be labeled
as such, not falsely advertised as native editable typography. Optional background
repair must be disclosed. Reject empty/full-image duplicate or invalid artifacts.

No release until these gates are verified; do not mark completion from mock tests alone.

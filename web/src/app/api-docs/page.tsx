"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ArrowRight, Check, Copy, ImageIcon, Film, KeyRound } from "lucide-react";
import "./docs.css";
import { UserAccess } from "@/components/user-access";
import { httpRequest } from "@/lib/request";
import type { VideoModelConfig } from "@/lib/api";

const sections = [
  ["quickstart", "快速开始"], ["images", "图片生成与编辑"], ["models", "视频模型"],
  ["videos", "视频生成"], ["parameters", "参数与参考素材"], ["billing", "计费与错误处理"],
] as const;

function CodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const formatted = value.replace(/ -H /g, " \\\n  -H ").replace(/ --data /g, " \\\n  --data ").replace(/ -F /g, " \\\n  -F ");
  return <div className="docs-code"><div className="docs-code-bar"><span>{value.startsWith("{") ? "JSON · 请求片段" : "cURL · 请求示例"}</span><button type="button" aria-label="复制代码" onClick={async () => { try { await navigator.clipboard.writeText(formatted); setCopied(true); setFailed(false); } catch { setFailed(true); } }}>{copied ? <Check size={13} /> : <Copy size={13} />}<span aria-live="polite">{copied ? "已复制" : failed ? "请选中代码复制" : "复制"}</span></button></div><pre><code>{formatted}</code></pre></div>;
}

function Documentation() {
  const [base, setBase] = useState("");
  const [models, setModels] = useState<VideoModelConfig[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState("quickstart");
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { const visible = entries.filter(entry => entry.isIntersecting); if (visible.length) setActive(visible[0].target.id); }, { rootMargin: "-100px 0px -55% 0px" });
    document.querySelectorAll(".docs-content h2[id]").forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setBase(window.location.origin); httpRequest<{data: {metadata: VideoModelConfig}[]}>("/v1/video-models", {authScope:"user"}).then(result => setModels(result.data.map(item => item.metadata))).catch(() => setError("暂时无法加载模型目录，请刷新页面重试。")).finally(() => setLoaded(true)); }, []);
  const code = (value: string) => <CodeBlock value={value} />;
  return <div className="api-docs">
    <aside className="docs-sidebar"><span className="docs-eyebrow">DEVELOPER DOCS</span><nav aria-label="文档目录">{sections.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined} onClick={() => setActive(id)}>{label}</a>)}</nav><div className="docs-sidebar-footer">让创意融入你的应用。<Link href="/image">返回创作工作台 <ArrowUpRight size={14} /></Link></div></aside>
    <article className="docs-content">
    <header className="docs-hero"><span className="docs-eyebrow">API REFERENCE</span><h1>将灵感，接入你的应用。</h1><p>通过统一 API 生成图片、创作视频。这里提供从身份认证到获取成品的完整接入说明。</p><div className="docs-hero-links"><a href="#quickstart" className="docs-primary">开始接入 <ArrowRight size={15} /></a><Link href="/api-keys" className="docs-secondary"><KeyRound size={14} />管理 API Key</Link></div></header>
    <div className="docs-quicklinks"><a href="#images"><ImageIcon size={21} /><div><strong>图片 API</strong><p>从文字到画面，或使用参考图编辑创作。</p></div></a><a href="#videos"><Film size={21} /><div><strong>视频 API</strong><p>异步生成、查询进度、安全获取视频。</p></div></a></div>
    <h2 id="quickstart">快速开始</h2>
    <p>本站 Base URL：<code>{base || "当前站点地址"}</code>（不含 /v1）。在<Link href="/api-keys" className="underline">个人中心</Link>创建个人 API Key，用 Authorization: Bearer 发送；不要使用管理员密钥，也不要将个人密钥放入网页公开代码。以下占位 Key 需替换，本站不会在文档中显示真实密钥。</p>
    {code(`BASE_URL='${base || "https://YOUR_SITE"}'\nAPI_KEY='YOUR_PERSONAL_API_KEY'\ncurl --fail "$BASE_URL/v1/models" -H "Authorization: Bearer $API_KEY"\n# 仅视频模型及实际启用、已路由能力\ncurl --fail "$BASE_URL/v1/video-models" -H "Authorization: Bearer $API_KEY"`)}
    <h2 id="images">图片生成与编辑</h2>
    <p>参考图片必须上传至本站，不接受 HTTP(S) 图片地址。图片编辑使用 multipart 文件上传，单张最多 25 MiB、合计最多 60 MiB、最多 10 张。Chat Completions / Responses 的图片输入可发送 Base64 Data URL，单张最多 10 MiB、合计最多 60 MiB、最多 10 张；本站接收后转发。计费与网页一致，按后台开放模型的独立价格预扣；提交结果不明时保留预扣，不自动再次提交。</p>
    <p>图片模型使用模型列表中实际可用的 ID。尺寸字段是 size（auto 或宽x高），不是 resolution；output_format 为 png/jpeg/webp，gpt-image-2.6 可请求 gif，但实际供应商 GIF 与尺寸支持未实测。请求参数不保证成品像素，失败会明确报错。图片接口同步返回 data 数组，读取其中 url；不要将视频响应格式用于图片。</p>
    {code(`curl --fail "$BASE_URL/v1/images/generations" -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' --data '{"model":"YOUR_IMAGE_MODEL_ID","prompt":"一只纸船","size":"2048x1152","output_format":"png","n":1}'\n\ncurl --fail "$BASE_URL/v1/images/edits" -H "Authorization: Bearer $API_KEY" -F 'model=YOUR_IMAGE_MODEL_ID' -F 'prompt=让天空变成黄昏' -F 'image=@reference.png' -F 'size=2048x1152' -F 'output_format=png'`)}
    <h2 id="models">可用视频模型</h2><p>此目录与视频工作室同步。调用时请使用模型 ID，并遵循对应的时长、清晰度与素材限制。</p>
    {error && <p role="alert">{error}</p>}
    {!loaded && <p role="status">正在加载模型目录…</p>}{loaded && !models.length && !error && <p>暂无可用视频模型。模型启用后将在此显示。</p>}
    {models.map(model => <section className="docs-model" key={model.id}><h3>{model.label} — <code>{model.id}</code></h3><p>时长：{model.durations?.length ? model.durations.join(" / ") : `${model.min_duration}–${model.max_duration}`} 秒；默认 {model.duration_default ?? 5} 秒。分辨率：{model.resolutions.join(" / ")}；默认 {model.resolution_default ?? "480p"}。比例：{model.aspect_ratios?.join(" / ") || "按原协议"}。</p><p>普通参考图：{model.supports_reference_images === false ? "不支持" : `最多${model.max_reference_images}张`}；首尾帧：{model.supports_frame_control ? "支持，首尾各最多1张且必须含首帧" : "不支持"}；续写：{model.supports_extend ? "支持（Image2Pro固定8秒720p）" : "不支持"}；参考音频：{model.supports_audio_upload || model.supports_voice ? "按配置支持" : "不支持"}。</p></section>)}
    <p>Veo Lite/Fast：8秒、720p/1080p、普通图1–3张、首尾帧与续写；Quality仅首尾帧、不能普通图。Omni1.1：4/6/8/10秒720p普通图；Omni1.2：固定15秒720p普通图。两种 Omni 不支持帧角色或续写，五种均不支持参考音频。以上仅说明能力档位，只有上方实际已配置模型才可调用。</p>
    <h2 id="videos">视频生成</h2><p>创建任务 → 查询进度 → 下载成品。请保存创建时返回的任务 ID，后续使用同一账户查询与下载。</p>
    {code(`curl --fail "$BASE_URL/v1/videos" -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Idempotency-Key: example-order-000001' --data '{"model":"YOUR_ENABLED_VIDEO_MODEL_ID","prompt":"纸船顺着溪水漂流","duration":8,"resolution":"720p","aspect_ratio":"16:9"}'\n# 创建HTTP 202：保存返回的 id/request_id（本站业务任务ID）\nTASK_ID='REPLACE_WITH_RETURNED_ID'\ncurl --fail "$BASE_URL/v1/videos/$TASK_ID" -H "Authorization: Bearer $API_KEY"\n# status=done 且 video.local=true 后下载，始终携带本人Key\ncurl --fail "$BASE_URL/v1/videos/$TASK_ID/content" -H "Authorization: Bearer $API_KEY" -o result.mp4`)}
    <p>兼容旧 POST /v1/videos/generations、GET /v1/videos/generations/ID 与 GET/HEAD /v1/video-jobs/ID/content。创建返回 id 和 request_id，值相同；查询返回本站状态 preparing/queued/submitting/pending/downloading/done/failed/expired/unknown。HTTP 200 不等于完成。建议每10秒 GET，暂时查询失败只延后查询同任务，绝不再次创建。</p>
    <h2 id="parameters">参数与参考素材</h2>
    <p>duration 接受整数、数字串或 8s；seconds 为别名，同时传必须相同。省略按模型默认值；Omni1.2 默认并仅接受15秒，按15秒计价，不将5/10秒伪装为真实时长。size 可替代 resolution/aspect_ratio，同时提供必须一致。</p>
    <div className="docs-table-wrap"><table><thead><tr><th>size</th><th>resolution</th><th>aspect_ratio</th></tr></thead><tbody>{[["1280x720","720p","16:9"],["720x1280","720p","9:16"],["1920x1080","1080p","16:9"],["1080x1920","1080p","9:16"]].map(row => <tr key={row[0]}>{row.map(cell => <td key={cell}>{cell}</td>)}</tr>)}</tbody></table></div>
    <p>视频参考图片先通过 /v1/video-assets 上传，使用本人素材的 asset_id；不接受外部图片 URL。Image2Pro 也可接收 PNG/JPEG/WebP Base64 Data URL，本站校验并存储后转发，单张最多5 MiB/2000万像素，请求体最多24 MiB。所有素材均受大小、配额与并发限制。role 仅 first_frame/last_frame；普通图和带角色图不可混用，不能只有尾帧。</p>
    {code(`curl --fail "$BASE_URL/v1/video-assets" -H "Authorization: Bearer $API_KEY" -F 'kind=image' -F 'file=@reference.png'\n# 将上传结果 asset_id 填入视频创建请求；首尾帧须由模型支持\n{"reference_images":[{"asset_id":"REPLACE_WITH_UPLOADED_ASSET_ID","role":"first_frame"}]}\n# 续写：本人同模型已完成任务 video.media_id，不是任务ID\n{"duration":8,"resolution":"720p","reference_videos":["extend://REPLACE_WITH_MEDIA_ID"]}`)}
    <p>续写不能带图片，只接受本人同模型已完成且已结算任务的媒体ID或原成品直链，并固定原渠道；不会公开返回上游签名直链，推荐使用 media_id。成品自动下载到本站私有缓存；video.duration/resolution/size 为上游实际返回（可能缺省），measured_duration/measured_size 为文件检测值，不用申请值冒充实测。</p>
    <h2 id="billing">计费与错误处理</h2>
    <p>client_request_id 或 Idempotency-Key 为6–120位字母、数字、点、下划线或连字符；同时提供须一致。同用户同编号重放返回原任务，新任务参数冲突返回409；不同用户隔离。duration/seconds、size与对应分辨率/比例以及省略默认值在原能力快照下归一化。历史无指纹任务保留原重放行为。向上游使用稳定的本站任务编号，不重试未知创建。</p>
    <p>提交按模型 billing_mode 计费：per_second（默认）按申请时长×分辨率单价预扣，per_request 按分辨率单价每次预扣，不乘时长，成品验证保存后结算；实际时长另行记录，不二次扣费。明确失败按既有流程退款，accounted 表示结算处理完成；unknown 保留预扣等待核对，不能声称已退款。每用户同时最多20个任务、滚动60秒内最多新建50个，全站同时最多500个；网页和API共享限额，待核对任务也占并发，已失败任务仍计入该分钟提交次数。401/403鉴权失败，402积分不足，409业务号冲突，413请求/素材过大，415不支持格式，400/422参数错误，429限流。视频创建收到HTTP502时按本站政策失败退款，不自动重提；已有任务的查询或下载遇到502则继续查询原任务。创建超时、408或其他无ID的5xx可能已受理，保持unknown、不盲目重发。成品清理或过期后不能下载，任务和账目仍保留。</p>
  </article></div>;
}
export default function ApiDocsPage() { return <UserAccess><Documentation /></UserAccess>; }

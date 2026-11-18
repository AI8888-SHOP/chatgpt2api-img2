"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { UserAccess } from "@/components/user-access";
import { httpRequest } from "@/lib/request";
import type { VideoModelConfig } from "@/lib/api";

function Documentation() {
  const [base, setBase] = useState("");
  const [models, setModels] = useState<VideoModelConfig[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { setBase(window.location.origin); httpRequest<{data: {metadata: VideoModelConfig}[]}>("/v1/video-models", {authScope:"user"}).then(result => setModels(result.data.map(item => item.metadata))).catch(() => setError("模型能力加载失败，请刷新重试；不能据此假定模型可用。")); }, []);
  const code = (value: string) => <pre className="overflow-x-auto rounded border bg-muted/30 p-4 text-xs whitespace-pre">{value}</pre>;
  return <article className="mx-auto max-w-4xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">API 接入文档</h1>
    <p>本站 Base URL：<code>{base || "当前站点地址"}</code>（不含 /v1）。在<Link href="/api-keys" className="underline">个人中心</Link>创建个人 API Key，用 Authorization: Bearer 发送；不要使用管理员密钥，也不要将个人密钥放入网页公开代码。以下占位 Key 需替换，本站不会在文档中显示真实密钥。</p>
    {code(`BASE_URL='${base || "https://YOUR_SITE"}'\nAPI_KEY='YOUR_PERSONAL_API_KEY'\ncurl --fail "$BASE_URL/v1/models" -H "Authorization: Bearer $API_KEY"\n# 仅视频模型及实际启用、已路由能力\ncurl --fail "$BASE_URL/v1/video-models" -H "Authorization: Bearer $API_KEY"`)}
    <h2 className="text-xl">图片生成与编辑</h2>
    <p>图片模型使用模型列表中实际可用的 ID。尺寸字段是 size（auto 或宽x高），不是 resolution；output_format 为 png/jpeg/webp，gpt-image-2.6 可请求 gif，但实际供应商 GIF 与尺寸支持未实测。请求参数不保证成品像素，失败会明确报错。图片接口同步返回 data 数组，读取其中 url；不要将视频响应格式用于图片。</p>
    {code(`curl --fail "$BASE_URL/v1/images/generations" -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' --data '{"model":"YOUR_IMAGE_MODEL_ID","prompt":"一只纸船","size":"2048x1152","output_format":"png","n":1}'\n\ncurl --fail "$BASE_URL/v1/images/edits" -H "Authorization: Bearer $API_KEY" -F 'model=YOUR_IMAGE_MODEL_ID' -F 'prompt=让天空变成黄昏' -F 'image=@reference.png' -F 'size=2048x1152' -F 'output_format=png'`)}
    <h2 className="text-xl">视频能力（与工作室共用配置）</h2>
    {error && <p role="alert">{error}</p>}
    {!models.length && !error && <p>当前未配置可用视频模型；不要猜测英文标题就是模型 ID。</p>}
    {models.map(model => <section className="rounded border p-4" key={model.id}><h3>{model.label} — <code>{model.id}</code></h3><p>时长：{model.durations?.length ? model.durations.join(" / ") : `${model.min_duration}–${model.max_duration}`} 秒；默认 {model.duration_default ?? 5} 秒。分辨率：{model.resolutions.join(" / ")}；默认 {model.resolution_default ?? "480p"}。比例：{model.aspect_ratios?.join(" / ") || "按原协议"}。</p><p>普通参考图：{model.supports_reference_images === false ? "不支持" : `最多${model.max_reference_images}张`}；首尾帧：{model.supports_frame_control ? "支持，首尾各最多1张且必须含首帧" : "不支持"}；续写：{model.supports_extend ? "支持（Image2Pro固定8秒720p）" : "不支持"}；参考音频：{model.supports_audio_upload || model.supports_voice ? "按配置支持" : "不支持"}。</p></section>)}
    <p>Veo Lite/Fast：8秒、720p/1080p、普通图1–3张、首尾帧与续写；Quality仅首尾帧、不能普通图。Omni1.1：4/6/8/10秒720p普通图；Omni1.2：固定15秒720p普通图。两种 Omni 不支持帧角色或续写，五种均不支持参考音频。以上仅说明能力档位，只有上方实际已配置模型才可调用。</p>
    <h2 className="text-xl">视频创建、查询、鉴权下载</h2>
    {code(`curl --fail "$BASE_URL/v1/videos" -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -H 'Idempotency-Key: example-order-000001' --data '{"model":"YOUR_ENABLED_VIDEO_MODEL_ID","prompt":"纸船顺着溪水漂流","duration":8,"resolution":"720p","aspect_ratio":"16:9"}'\n# 创建HTTP 202：保存返回的 id/request_id（本站业务任务ID）\nTASK_ID='REPLACE_WITH_RETURNED_ID'\ncurl --fail "$BASE_URL/v1/videos/$TASK_ID" -H "Authorization: Bearer $API_KEY"\n# status=done 且 video.local=true 后下载，始终携带本人Key\ncurl --fail "$BASE_URL/v1/videos/$TASK_ID/content" -H "Authorization: Bearer $API_KEY" -o result.mp4`)}
    <p>兼容旧 POST /v1/videos/generations、GET /v1/videos/generations/ID 与 GET/HEAD /v1/video-jobs/ID/content。创建返回 id 和 request_id，值相同；查询返回本站状态 preparing/queued/submitting/pending/downloading/done/failed/expired/unknown。HTTP 200 不等于完成。建议每10秒 GET，暂时查询失败只延后查询同任务，绝不再次创建。</p>
    <h2 className="text-xl">统一视频参数</h2>
    <p>duration 接受整数、数字串或 8s；seconds 为别名，同时传必须相同。省略按模型默认值；Omni1.2 默认并仅接受15秒，按15秒计价，不将5/10秒伪装为真实时长。size 可替代 resolution/aspect_ratio，同时提供必须一致。</p>
    <table className="w-full text-sm"><thead><tr><th>size</th><th>resolution</th><th>aspect_ratio</th></tr></thead><tbody>{[["1280x720","720p","16:9"],["720x1280","720p","9:16"],["1920x1080","1080p","16:9"],["1080x1920","1080p","9:16"]].map(row => <tr key={row[0]}>{row.map(cell => <td key={cell}>{cell}</td>)}</tr>)}</tbody></table>
    <p>Image2Pro reference_images 支持公开 HTTPS URL、PNG/JPEG/WebP Data URL、或 {`{url, role}`}/本站 owner-scoped {`{asset_id, role}`}。URL必须无需登录、无重定向且不指向内网；每图最多5MB/2000万像素，请求体最多24MB，仍受用户素材配额与并发限制。其他协议继续使用 /v1/video-assets 上传后返回的 asset_id。role 仅 first_frame/last_frame；普通图和带角色图不可混用，不能只有尾帧。</p>
    {code(`{"reference_images":[{"url":"https://YOUR_FILES/first.png","role":"first_frame"},{"url":"data:image/png;base64,REPLACE_WITH_REAL_BASE64","role":"last_frame"}]}\n# 续写：本人同模型已完成任务 video.media_id，不是任务ID\n{"duration":8,"resolution":"720p","reference_videos":["extend://REPLACE_WITH_MEDIA_ID"]}`)}
    <p>续写不能带图片，只接受本人同模型已完成且已结算任务的媒体ID或原成品直链，并固定原渠道；不会公开返回上游签名直链，推荐使用 media_id。成品自动下载到本站私有缓存；video.duration/resolution/size 为上游实际返回（可能缺省），measured_duration/measured_size 为文件检测值，不用申请值冒充实测。</p>
    <h2 className="text-xl">幂等、积分与错误</h2>
    <p>client_request_id 或 Idempotency-Key 为6–120位字母、数字、点、下划线或连字符；同时提供须一致。同用户同编号重放返回原任务，新任务参数冲突返回409；不同用户隔离。duration/seconds、size与对应分辨率/比例以及省略默认值在原能力快照下归一化。历史无指纹任务保留原重放行为。向上游使用稳定的本站任务编号，不重试未知创建。</p>
    <p>提交按申请时长×模型分辨率单价预扣，成品验证保存后结算；实际时长另行记录，不二次扣费。明确失败按既有流程退款，accounted 表示结算处理完成；unknown 保留预扣等待核对，不能声称已退款。每用户每分钟最多一次、同时一个任务，全站最多八个。401/403鉴权失败，402积分不足，409业务号冲突，413请求/素材过大，415不支持格式，400/422参数错误，429限流。创建超时、408或无ID的5xx可能已受理，保持unknown、不盲目重发。成品清理或过期后不能下载，任务和账目仍保留。</p>
  </article>;
}
export default function ApiDocsPage() { return <UserAccess><Documentation /></UserAccess>; }

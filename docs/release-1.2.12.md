# v1.2.12

Video submission diagnostics and protocol configuration fix.

- Grok uses `/v1/videos/generations`, `duration`, `image.url`, `request_id` (or compatible `id` / `data.request_id` / `data.id`), and `done` with `video.url`. Native uses `/v1/videos`, `seconds`, `input_reference`, `id`, and `completed` followed by authenticated `/content`. These are separate contracts, not interchangeable endpoint aliases.
- Allow administrators to enable 1080p independently of protocol. Changing protocol preserves configured resolution prices. Actual provider/model capability still needs confirmation.
- Prefer configured public reference image URLs for Grok; retain data-URI compatibility when no public asset base is configured.
- Persist the last eight structural diagnostics per job: phase, time, HTTP status, error type/code, gateway and upstream IDs. Do not store raw response messages, URLs, credentials, prompts or base64 in diagnostics. Owners can inspect diagnostics in the video workspace.
- Explicit creation rejections fail and refund once. Ambiguous 5xx, timeouts, malformed responses and missing task IDs remain unknown and never trigger another POST. Existing tasks retain original protocol/channel snapshots and GET polling backs off on errors.
- Administrator reconciliation records evidence notes and is idempotent. Refund ledger metadata links to the video job and gateway diagnostic ID.

Contract reference: https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/grok_media.go

Gateway requirement: preserve definitive rejection semantics. A generic 502 does not prove non-acceptance. Automatic reconciliation without a task ID requires a caller-authenticated lookup by diagnostic/business ID with an explicit accepted/rejected/unknown result; do not expose gateway administrative credentials to this application.

Validation uses synthetic providers only; no paid video generation is performed by this release's tests. Provider 422 evidence can justify a specific local credit refund without claiming that the ultimate provider invoice was audited.

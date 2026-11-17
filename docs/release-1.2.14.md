# v1.2.14

Grok gateway tasks could finish with `status=done` and a root-relative authenticated content path. The service previously rejected that path and left already-generated videos pending, preventing delivery and credit settlement.

- For the explicitly configured Grok `/v1/videos` alias, accept only the exact content path for the original task. Build the download URL from the pinned channel and task ID, never from an arbitrary provider URL.
- Reuse native server-side authenticated streaming download, bounded storage, video validation and owner-authorized local delivery. Redirects are disabled. Reject other task paths, protocol-relative hosts, traversal, queries and fragments. External absolute result URLs keep the existing contract and never receive channel credentials.
- Recover existing pending/downloading jobs after deployment or restart without another creation request. Settle existing credit reservations only after a validated video is stored.
- Regression coverage includes Grok relative content, rejected paths, download timeout/restart recovery, redirect rejection, owner isolation, external URLs and once-only settlement.

No model settings, prices or gateway service changes. Live verification must reuse the previously accepted test video; no new paid generation is needed.

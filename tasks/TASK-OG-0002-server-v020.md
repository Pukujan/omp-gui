# TASK-OG-0002 — Per-chat agent sessions, protocol v2 transport, ranked model picker, image generation

Status: in review (PR #10). Owning issue: #3 (projects/chats), contributes to #2 (UI parity), #4 (docker/mobile), #6 (auth hardening). Parent: #1.
Writer: Pukujan. Branch: feat/server-v0.2.0.

## Deliverables
- `server/lib/pool.js` + `server/lib/rpc.js`: one `omp --mode rpc` process per GUI
  chat, clean context, `cwd` = project folder; new chat = new session, reopen =
  `switch_session`, reconnect = re-attach; idle kill after 30 min.
- `server/lib/frames.js`: protocol v2 negotiation + validated `rpc_chunk`
  reassembly (lossless oversized frames).
- `server/lib/models.js`: `GET /api/models` ranking the live omp catalog with the
  Inference Recommendation Engine, with status/reason badges and filters.
- `server/lib/images.js`: `POST /api/image` (ckff endpoint, token server-side,
  format sniffing, per-model quota fallback) + `/api/images/<file>`.
- Notifications (`/ws/control`, `/api/notifications`), pins, search, recents,
  session titles, capabilities, feedback.
- `scripts/test-server.js` (18 tests) and an updated `scripts/smoke.js`.

## Acceptance
- `node scripts/test-server.js` → 18/18 pass, including per-chat isolation
  (two chats → two session files) and v2 framing rejection cases.
- `node scripts/smoke.js` → streamed reply over a negotiated v2 session.
- Live `POST /api/image` → stored + served image; `/api/models` → engine-ranked
  catalog.
- CI `test` job runs the suite; PR-only merge to `main`.

## Notes
- Blocked (issue #7): `omp.design-bakery.com` needs interactive
  `cloudflared tunnel login`; the API token cannot write tunnel configuration.
- The UI rebuild lands in a follow-up PR against `docs/UI-SPEC.md`.

### 2026-09-30 03:09:33 UTC — omp-gui-builder

<!-- continuity:checkpoint {"agent":"omp-gui-builder","blocked":["omp.design-bakery.com tunnel: API token cannot write tunnel configuration (10405) and local-src tunnels fail to register; needs interactive cloudflared tunnel login (issue #7). Tailscale serve is the working remote path."],"changed":["server/lib/*.js, server/index.js, scripts/test-server.js, scripts/smoke.js, README.md, CHANGELOG.md, docs/UI-SPEC.md, docs/DEPLOY.md, .env.example, .gitignore, .github/workflows/ci.yml, tasks/TASK-OG-0002-server-v020.md"],"completed":["server v0.2.0 modules: per-chat omp session pool, RPC protocol v2 negotiation + rpc_chunk reassembly, IRE-ranked model picker, ckff image generation with model fallback, notifications, pins/search/recents/capabilities/feedback APIs; 18-test suite + smoke green; PR #10 opened"],"decisions":["one omp --mode rpc process per GUI chat (clean context, cwd = project folder); protocol v2 is required for the model catalog; image generation falls back across ckff image models because gpt-image-2.5 currently returns upstream 429"],"evidence":["node scripts/test-server.js -> 18/18 pass; node scripts/smoke.js -> streamed OMG-GUI-OK with response:negotiate_protocol; live POST /api/image -> 200 /api/images/463b05fb-....jpg image/jpeg 391108 bytes; GET /api/models -> engine 0.2.0, 766 models ranked"],"next_action":"verify PR #10 CI green + auto-merge; then land the web/ UI rebuild and browser-verify at 1440px/390px","protocol_version":"0.1.0-draft","schema":"project-continuity.checkpoint.v1","task_id":"OG-0002","timestamp":"2026-09-30T03:09:33Z"} -->
<!-- continuity:checkpoint-operation {"payload_sha256":"7cff5e67fbfd4ddcc657a4ed49367f9c7280fdf53ffb72e793bf415920266e4a","request_id":"88e0776425ad48069e5bb8bea859297f","schema":"project-continuity.checkpoint-operation.v1","task_id":"OG-0002"} -->

Completed:
- server v0.2.0 modules: per-chat omp session pool, RPC protocol v2 negotiation + rpc_chunk reassembly, IRE-ranked model picker, ckff image generation with model fallback, notifications, pins/search/recents/capabilities/feedback APIs; 18-test suite + smoke green; PR #10 opened

Evidence:
- node scripts/test-server.js -> 18/18 pass; node scripts/smoke.js -> streamed OMG-GUI-OK with response:negotiate_protocol; live POST /api/image -> 200 /api/images/463b05fb-....jpg image/jpeg 391108 bytes; GET /api/models -> engine 0.2.0, 766 models ranked

Decisions:
- one omp --mode rpc process per GUI chat (clean context, cwd = project folder); protocol v2 is required for the model catalog; image generation falls back across ckff image models because gpt-image-2.5 currently returns upstream 429

Changed:
- server/lib/*.js, server/index.js, scripts/test-server.js, scripts/smoke.js, README.md, CHANGELOG.md, docs/UI-SPEC.md, docs/DEPLOY.md, .env.example, .gitignore, .github/workflows/ci.yml, tasks/TASK-OG-0002-server-v020.md

Blocked/uncertain:
- omp.design-bakery.com tunnel: API token cannot write tunnel configuration (10405) and local-src tunnels fail to register; needs interactive cloudflared tunnel login (issue #7). Tailscale serve is the working remote path.

Next:
- verify PR #10 CI green + auto-merge; then land the web/ UI rebuild and browser-verify at 1440px/390px

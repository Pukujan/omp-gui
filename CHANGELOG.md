# Changelog

All notable changes to omp-gui. Modules are versioned together with the server
(`server/package.json`), and each module carries its own `@ vX.Y.Z` header.

## 0.2.0 — 2026-09-29

### Added
- **Per-chat agent sessions**: every GUI chat owns one `omp --mode rpc` process
  with a clean context; cwd is the project folder. New chat = new session, reopen
  = fresh process switched to that session file, reconnect = re-attach to the live
  process. Chats never share a process (`server/lib/pool.js`, `server/lib/rpc.js`).
- **Protocol v2 transport**: `negotiate_protocol` on `ready` plus a validated
  `rpc_chunk` assembler, so oversized frames (the ~2 MB model catalog) arrive
  losslessly instead of failing with "RPC response exceeded the transport limit"
  (`server/lib/frames.js`).
- **Ranked model picker**: `GET /api/models` ranks the live omp catalog with the
  Inference Recommendation Engine (price, provider breadth, runtime evidence,
  policy) and returns status + gate reasons; filters for vision/free/reasoning/
  query (`server/lib/models.js`).
- **Image generation**: `POST /api/image` posts to the ckff image endpoint, stores
  the result under `data/images/`, serves it at `/api/images/<file>`, sniffs the
  real format, and falls back across image models when the provider reports
  429/503 for one of them (`server/lib/images.js`).
- **Image attachments**: composer images are converted to RPC `prompt.images`
  payloads for vision models.
- **Notifications**: `/ws/control` fans out `input_required`, `prompt_result`,
  `settled`, `error` and `process_exit` per chat, with a ring buffer at
  `GET /api/notifications` for the bell after a reload.
- **Session UX APIs**: `GET /api/recent`, `GET /api/search?q=`, `GET /api/pins`
  + `POST /api/pins`, `GET /api/projects/:id/sessions` with titles parsed from the
  session JSONL, `GET /api/capabilities` (skills/plugins/MCP discovery),
  `POST /api/feedback`.
- **Tests**: `scripts/test-server.js` — 18 tests covering auth + rate-limit
  lockout, project validation, pins, search, capabilities, feedback, image
  generation against a mock provider, IRE ranking, per-chat isolation (two chats →
  two session files), v2 framing (valid + interrupted/duplicate/oversized/non-UTF8),
  control-socket fanout, and one real agent turn.

### Changed
- Server split into modules: `lib/config`, `lib/auth`, `lib/projects`, `lib/rpc`,
  `lib/frames`, `lib/pool`, `lib/models`, `lib/images`; `server/index.js` is now
  wiring + routes only.
- Passwords are hashed with a runtime-generated pepper (`data/pepper.key`) instead
  of a hardcoded string; logout invalidates issued session ids.
- Rate limiting keys on `cf-connecting-ip` / `x-forwarded-for` before the socket
  address, so tunnel and Tailscale traffic is limited per client, not per proxy.
- `--no-title` sessions let the client name a chat from its first message via
  `set_session_name` (no extra model call).

### Fixed
- `get_available_models` no longer fails on large catalogs (v2 negotiation +
  reassembly).
- `.env` keys containing hyphens (the ckff provider keys) are now loaded.
- Image endpoint accepts both a base URL and a full
  `.../images/generations` URL.

## 0.1.0 — 2026-09-28

- Initial server + UI: single-user auth, project store, `omp --mode rpc` relay,
  streaming transcript, tool cards, thinking, steering queue, model/thinking
  pickers, PWA manifest, Dockerfile, CI.

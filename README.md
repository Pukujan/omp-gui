# omp-gui

ChatGPT-style web GUI for the [omp](https://omp.sh) coding agent. A small Node
server spawns **one `omp --mode rpc` process per GUI chat**, relays the JSONL RPC
frames to the browser over WebSocket, and serves a responsive dark UI that works
on desktop and phone.

Your machine runs the agent and all tools; the browser is just a window into it.
Each chat gets a **clean context** and the project's own folder as its working
directory — exactly as if you had launched `omp` there yourself.

## Quick start (Windows / Linux / WSL)

```bash
cp .env.example .env        # set OMP_GUI_USER, OMP_GUI_PASS_PLAINTEXT, OMP_GUI_SESSION_SECRET
cd server && npm install    # one dep: ws
node server/index.js        # http://127.0.0.1:8790
```

Requires `omp` on PATH (or set `OMP_BIN`). Log in, **Add project** (name + absolute
path), then chat. `Esc` aborts a running turn; Enter queues steering/follow-ups.

## How a chat maps to an agent session

| GUI concept | Server reality |
| --- | --- |
| Chat (sidebar row) | one `omp --mode rpc` child process + one session file in `data/projects/<slug>/sessions/` |
| New chat | new process, new empty session — never reuses another chat's context |
| Reopen chat | `--resume <file>` equivalent: fresh process, `switch_session` to that file |
| Project folder | the process `cwd` (the folder you added, on your machine) |
| Chat ⇄ Work toggle | `--no-tools` (tool-free chat) vs. full agent |
| Approval pill | `--approval-mode always-ask \| write \| yolo` at spawn |
| Idle chats | killed after 30 min without a client; reattach is transparent |

Protocol v2 is negotiated on the `ready` frame, so oversized RPC payloads (the
~2 MB model catalog) arrive losslessly as reassembled `rpc_chunk` sequences.

## Model picker (ranked, not alphabetical)

`GET /api/models` ranks the live `omp` catalog with the local
[Inference Recommendation Engine](https://github.com/Pukujan/inference-recommendation-engine)
(`IRE_ROOT`, default `D:/claude/inference-recommendation-engine`): price ladder,
provider breadth, runtime evidence, deterministic policy. Each entry carries
`rank`, `status` (`qualified` / `provisional` / `unknown`) and machine-readable
`reasons` (`low_availability`, `insufficient_provider_breadth`,
`insufficient_runtime_evidence`, …) plus cost, throughput, vision/reasoning flags
and thinking levels. Filters: `?vision=1&free=1&reasoning=1&q=`. Without the
engine checkout the endpoint degrades to a local price/throughput ordering. On a
host with no configured providers the response is `{available:false, reason}`
rather than an error, and the UI says so.

## Image generation and vision

- **Vision**: attach or paste images in the composer; they are sent as RPC
  `prompt.images` to the session's model.
- **Generation**: the composer's image button calls `POST /api/image`, which posts
  to the ckff image endpoint (`ckff-image-url` + `ckff-cortex-image-generation`
  from `.env`) and stores the result in `data/images/`, served at
  `/api/images/<file>`. The token stays server-side.
- Provider quota is per model: when the configured model answers 429/503 the
  module retries the models in `CKFF_IMAGE_FALLBACKS` (default
  `gemini-3.1-flash-image`) and reports which one served the image.

## Docker (dev in WSL)

```bash
docker compose up -d --build
# app on http://127.0.0.1:8790 (WSL → Windows browser works via localhost)
```

The image installs the Linux omp binary; provider auth is read from the mounted
`/root/.omp` volume (`docker volume inspect omp-gui_omp-home`).

## Mobile / remote access

The server binds `0.0.0.0` inside the container but the compose file publishes
loopback only. Reach it from your phone over Tailscale:

```bash
tailscale serve --bg 8790          # on the host running omp-gui
# phone (tailnet): http://<machine>:41062 or the serve URL
```

For `omp.design-bakery.com` the Cloudflare tunnel needs the host to own the
account certificate (`cloudflared tunnel login`) or dashboard-managed ingress;
the API token alone cannot write tunnel configuration. See `docs/DEPLOY.md` and
issue #7.

## Layout

| Path | Role |
| --- | --- |
| `server/index.js` | HTTP/WS wiring, routes, static host |
| `server/lib/config.js` | env, paths, versions |
| `server/lib/auth.js` | scrypt+pepper passwords, HMAC cookie, rate limit + lockout |
| `server/lib/projects.js` | project store, session listing/titles, pins, search, recents |
| `server/lib/rpc.js` | `omp --mode rpc` child: spawn flags, v2 negotiation, state, notifications |
| `server/lib/frames.js` | protocol v2 `rpc_chunk` assembler (lossless oversized frames) |
| `server/lib/pool.js` | chat-keyed session pool, idle kill, notification fanout |
| `server/lib/models.js` | Inference Recommendation Engine adapter for the model picker |
| `server/lib/images.js` | ckff image generation + attachment storage |
| `web/` | static client (modular ES modules): sidebar, transcript, composer, pickers, dialogs |
| `scripts/test-server.js` | API + isolation + framing tests (`node scripts/test-server.js`) |
| `scripts/smoke.js` | end-to-end: login → project → WS → real prompt → streamed reply |
| `docs/UI-SPEC.md` | every control → function → test id |
| `Dockerfile`, `docker-compose.yml` | containerized deploy |

## Tests

```bash
node scripts/test-server.js   # 18 tests: auth, rate limit, projects, pins, search,
                              # capabilities, feedback, images (mock provider),
                              # IRE ranking, per-chat session isolation, v2 framing,
                              # notification fanout, one real agent turn
node scripts/smoke.js         # full end-to-end against a running server
```

## Security notes

- Single-user by design; credentials never leave `.env` (gitignored).
- Login: 10 attempts/min/IP, 15 min lockout; session cookie HttpOnly, 30 days,
  rotated server-side (`liveSids`) so logout invalidates issued tokens.
- Static assets are public (the login page must load); every `/api/*` route and
  both WebSocket endpoints require the cookie.
- Client-supplied RPC frames are checked against an allowlist; anything else is
  refused with a visible error.
- The agent runs with the same power as your CLI — approvals follow the session's
  `--approval-mode`. Treat the link like a shell. Bind loopback; use Tailscale,
  never port-forward.

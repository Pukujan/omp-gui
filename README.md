# omp-gui

ChatGPT-style web GUI for the [omp](https://omp.sh) coding agent. One Node server
spawns `omp --mode rpc` per project, relays the JSONL RPC frames to the browser
over WebSocket, and serves a responsive dark UI that works on desktop and phone.

Your machine runs the agent and all tools; the browser is just a window into it.

## Quick start (Windows / Linux / WSL)

```bash
cp .env.example .env        # set OMP_GUI_USER, OMP_GUI_PASS_PLAINTEXT, OMP_GUI_SESSION_SECRET
cd server && npm install    # one dep: ws
node server/index.js        # http://127.0.0.1:8790
```

Requires `omp` on PATH (or set `OMP_BIN`). Log in, **Add project** (name + absolute
path), then chat. `Esc` aborts a running turn; Enter queues steering/follow-ups.

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

For `omp.design-bakery.com`: reverse-proxy from the tailnet host that owns the
DNS (see issue #4) — the app itself never needs a public port.

## Layout

| Path | Role |
| --- | --- |
| `server/index.js` | auth (scrypt + HMAC cookie), login rate-limit + lockout, project store, `omp --mode rpc` pool, WS relay, static host |
| `web/` | static client: sidebar projects/chats, streaming transcript, tool cards, thinking, steering queue, model/thinking pickers, subagent panel, `ask`/extension dialogs, PWA manifest |
| `scripts/smoke.js` | end-to-end: login → project → WS → real prompt → streamed reply |
| `Dockerfile`, `docker-compose.yml` | containerized deploy |

## Security notes

- Single-user by design; credentials never leave `.env` (gitignored).
- Login: 10 attempts/min/IP, 15 min lockout; session cookie HttpOnly, 30 days.
- The agent runs with the same power as your CLI — approvals follow your
  `~/.omp` config (`tools.approvalMode`). Treat the link like a shell.
- Bind loopback; use Tailscale, never port-forward.

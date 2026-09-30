# Deploy

Topology: the app + agent run in Docker on **gravebuster** (always-on tailnet
linux box). Phones/laptops reach it via Tailscale; `omp.design-bakery.com`
resolves to the tailnet edge with TLS at the box. Dev loop runs the same
compose stack in WSL on the Windows workstation.

## 1. WSL dev (Windows workstation)

```bash
cd /mnt/c/Users/pujan/OneDrive/Desktop/work/omg-gui
cp .env.example .env      # fill user/pass/secret
docker compose up -d --build
# http://127.0.0.1:8790  (WSL localhost forwarding → Windows browser)
```

## 2. gravebuster (production)

```bash
git clone https://github.com/Pukujan/omp-gui ~/omp-gui && cd ~/omp-gui
cp .env.example .env      # strong OMP_GUI_SESSION_SECRET; pass not in repo
docker compose up -d --build
```

Provider auth: `docker cp ~/.omp/agent/models.yml omp-gui:/root/.omp/agent/`
or mount your own; the container reads `/root/.omp`.

## 3. Tailnet access

On gravebuster:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8790
```

Phone (on tailnet): `https://<gravebuster-tailnet-name>` — works from the
iOS/Android Tailscale app; add-to-home-screen from the browser gives a PWA.

## 4. omp.design-bakery.com

DNS `omp` record in the design-bakery.com zone points at gravebuster.
Two options, pick one:

- **Tailnet-only (default):** Caddy/nginx on gravebuster terminates TLS
  (self-signed or `tailscale cert omp.design-bakery.com`) and proxies
  `127.0.0.1:8790` with WebSocket upgrade headers.
- **Public (needs login hardening first, issue #6):** Cloudflare Tunnel
  (`cloudflared tunnel`) with the origin bound to `127.0.0.1` only.

WebSocket proxy config (Caddy):

```
omp.design-bakery.com {
  reverse_proxy 127.0.0.1:8790
}
```

## 5. R2 (attachments/exports, optional)

R2 credentials live in the local `.env` (never committed). The server reads
`CLOUDFLARE_R2_*` when present; exports upload to the configured bucket,
otherwise they stay on the `omp-data` volume.

## Security invariants

- The box never binds a public port; compose publishes loopback only.
- Login: 10/min/IP, 15-min lockout, 30-day HttpOnly cookie.
- Secrets exist only in `.env` / container env; CI has no credentials.

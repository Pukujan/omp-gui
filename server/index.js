#!/usr/bin/env node
// omp-gui server v0.2.0 — ChatGPT-style web front for `omp --mode rpc`.
// Modules: lib/config, lib/auth, lib/projects, lib/rpc, lib/pool, lib/models, lib/images.
// One omp process per GUI chat (clean context), cwd = the project's launch folder.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const config = require("./lib/config");
const auth = require("./lib/auth");
const projects = require("./lib/projects");
const pool = require("./lib/pool");
const modelRank = require("./lib/models");
const images = require("./lib/images");

const { PORT, HOST, DATA_DIR, WEB_DIR, VERSION } = config;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- model catalog (cached from a live/ephemeral rpc session) ----------
let modelsCache = { at: 0, data: null };
const MODELS_TTL = 10 * 60e3;
const MODELS_FAIL_TTL = 60e3; // don't spawn a probe on every request while it is unavailable
async function getModels() {
  if (modelsCache.data && Date.now() - modelsCache.at < MODELS_TTL) return modelsCache.data;
  if (!modelsCache.data && modelsCache.at && Date.now() - modelsCache.at < MODELS_FAIL_TTL) return null;
  const live = pool.all().find((s) => s.models);
  if (live) { modelsCache = { at: Date.now(), data: live.models }; return live.models; }
  // ephemeral probe session: no GUI chat owns it, killed as soon as it answers
  const { RpcSession } = require("./lib/rpc");
  const pr = projects.loadProjects()[0];
  if (!pr) return null;
  const dir = projects.sessionDir(pr);
  const probe = new RpcSession({
    id: "models-probe", chatId: "models-probe", project: pr, sessionDir: dir, cwd: pr.path,
    kind: "chat", approval: "always-ask", fetchModels: true, log: () => {},
    onFrame: (s, f) => {
      if (f.type === "response" && f.command === "get_available_models") {
        modelsCache = { at: Date.now(), data: f.success ? f.data : null };
        setTimeout(() => s.dispose(), 200);
      }
    },
  });
  const ok = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (modelsCache.data || probe.dead || Date.now() - t0 > 45e3) { clearInterval(iv); resolve(!!modelsCache.data); }
    }, 250);
  });
  try { probe.dispose(); } catch {}
  if (!ok) modelsCache = { at: Date.now(), data: null };
  return ok ? modelsCache.data : null;
}

// ---------- http helpers ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".webmanifest": "application/manifest+json", ".json": "application/json", ".ico": "image/x-icon" };
function serveStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(buf);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req, max = 12e6) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > max) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);
  const ip = auth.clientIp(req);

  if (p === "/api/health") return json(res, 200, { ok: true, version: VERSION, sessions: pool.all().length, omp: config.OMP_BIN });

  if (p === "/api/login" && req.method === "POST") {
    const lock = auth.lockRemainingMs(ip);
    if (lock) return json(res, 429, { error: `too many attempts; locked for ${Math.ceil(lock / 60000)} min` });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "bad json" }); }
    auth.rateHit(ip);
    if (body.username !== config.USER || !auth.verifyPassword(body.password)) return json(res, 401, { error: "invalid credentials" });
    const sid = auth.newSid();
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": `omg_session=${auth.makeToken(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.SESSION_TTL_MS / 1000}${auth.secureFlag(req)}`,
    });
    return res.end(JSON.stringify({ ok: true, user: config.USER, version: VERSION }));
  }

  if (p === "/api/logout" && req.method === "POST") {
    auth.dropSids();
    res.writeHead(200, { "content-type": "application/json", "set-cookie": `omg_session=; Path=/; HttpOnly; Max-Age=0${auth.secureFlag(req)}` });
    return res.end('{"ok":true}');
  }

  // static assets are public; the login page must load before a cookie exists
  if (req.method === "GET" || req.method === "HEAD") {
    const rel = p === "/" ? "/index.html" : p;
    const full = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (full.startsWith(WEB_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) return serveStatic(res, full);
  }

  if (!auth.authed(req)) return json(res, 401, { error: "unauthorized" });

  if (p === "/api/me") return json(res, 200, { user: config.USER, version: VERSION, imageGen: images.configured() });

  // ---- projects ----
  if (p === "/api/projects" && req.method === "GET") {
    const pins = projects.loadPins();
    const list = projects.loadProjects().map((pr) => ({
      ...pr,
      pinned: pins.projects.includes(pr.name),
      sessionCount: projects.listSessions(pr, 999).length,
      live: pool.countForProject(pr.id),
    }));
    return json(res, 200, { projects: list });
  }
  if (p === "/api/projects" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "bad json" }); }
    const name = String(body.name || "").trim().slice(0, 60);
    const cw = String(body.path || "").trim();
    if (!name || !cw) return json(res, 400, { error: "name and path required" });
    const abs = path.resolve(cw);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return json(res, 400, { error: "path is not a directory" });
    const r = projects.addProject(name, abs);
    return r.error ? json(res, 409, { error: r.error }) : json(res, 200, { project: r.project });
  }
  const projMatch = p.match(/^\/api\/projects\/([^/]+)$/);
  if (projMatch && req.method === "DELETE") {
    const r = projects.removeProject(projMatch[1]);
    return r.error ? json(res, 404, { error: r.error }) : json(res, 200, { ok: true });
  }
  const sessMatch = p.match(/^\/api\/projects\/([^/]+)\/sessions$/);
  if (sessMatch && req.method === "GET") {
    const pr = projects.findProject(sessMatch[1]);
    if (!pr) return json(res, 404, { error: "no such project" });
    return json(res, 200, { project: pr, sessions: projects.listSessions(pr, 100) });
  }
  if (p === "/api/recent") return json(res, 200, { sessions: projects.recent(Number(url.searchParams.get("limit") || 40)) });
  if (p === "/api/search") return json(res, 200, { results: projects.search(url.searchParams.get("q") || "") });

  // ---- pins ----
  if (p === "/api/pins" && req.method === "GET") return json(res, 200, projects.loadPins());
  if (p === "/api/pins" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "bad json" }); }
    const kind = body.kind === "chat" ? "chat" : "project";
    const key = String(body.key || "");
    if (!key) return json(res, 400, { error: "key required" });
    return json(res, 200, projects.togglePin(kind, key));
  }

  // ---- models (ranked by the Inference Recommendation Engine) ----
  if (p === "/api/models") {
    const data = await getModels();
    // No providers configured (or omp cannot report a catalog): say so explicitly
    // instead of failing the picker — the UI shows a notice and the rest works.
    if (!data || !Array.isArray(data.models)) {
      return json(res, 200, { available: false, reason: "model catalog unavailable (no configured providers?)", engineVersion: null, count: 0, models: [] });
    }
    const ranked = await modelRank.rank(data.models, {
      vision: url.searchParams.get("vision") === "1",
      free: url.searchParams.get("free") === "1",
      reasoning: url.searchParams.get("reasoning") === "1",
      query: url.searchParams.get("q") || "",
      limit: Number(url.searchParams.get("limit") || 0) || 0,
    });
    return json(res, 200, { available: true, ...ranked });
  }

  // ---- image generation ----
  if (p === "/api/image" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "bad json" }); }
    try {
      const r = await images.generate(body);
      return json(res, r.error ? 502 : 200, r);
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }
  const imgMatch = p.match(/^\/api\/images\/([A-Za-z0-9._-]+)$/);
  if (imgMatch && req.method === "GET") {
    const f = images.filePath(imgMatch[1]);
    if (!f) return json(res, 404, { error: "no such image" });
    return serveStatic(res, f);
  }

  // ---- capabilities (skills / plugins / MCP) ----
  if (p === "/api/capabilities") return json(res, 200, capabilities());

  // ---- feedback ----
  if (p === "/api/feedback" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "bad json" }); }
    const rec = { at: new Date().toISOString(), user: config.USER, ...body };
    fs.appendFileSync(path.join(DATA_DIR, "feedback.jsonl"), JSON.stringify(rec) + "\n");
    return json(res, 200, { ok: true });
  }

  // ---- notifications ring (for the bell after a reload) ----
  if (p === "/api/notifications") return json(res, 200, { events: pool.recentEvents ? pool.recentEvents(50) : [] });

  json(res, 404, { error: "not found" });
});

// ---------- capabilities: real discovery + real enable/disable ----------
function ompConfigDir() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const d = path.join(home, ".omp", "agent");
  return fs.existsSync(d) ? d : null;
}
function listDir(d) {
  try { return fs.readdirSync(d).filter((f) => !f.startsWith(".")); } catch { return []; }
}
function capabilities() {
  const dir = ompConfigDir();
  if (!dir) return { available: false, skills: [], plugins: [], mcp: [] };
  const mk = (root) =>
    listDir(path.join(dir, root)).map((name) => ({ name, enabled: !name.endsWith(".disabled") })).sort((a, b) => a.name.localeCompare(b.name));
  let mcp = [];
  for (const f of ["mcp.json", "config.yml"]) {
    const fp = path.join(dir, f);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, "utf8");
    const names = [...txt.matchAll(/^\s{2}([A-Za-z0-9._-]+):\s*$/gm)].map((m) => m[1]);
    if (f === "mcp.json") { try { mcp = Object.keys(JSON.parse(txt).mcpServers || {}); } catch {} }
    else mcp = mcp.concat(names.filter((n) => /mcp|server/i.test(n)));
  }
  return { available: true, dir, skills: mk("skills"), plugins: mk("plugins"), mcp: [...new Set(mcp)] };
}

// ---------- websocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws" && url.pathname !== "/ws/control" && !url.pathname.startsWith("/ws/")) { socket.destroy(); return; }
  if (!auth.authed(req)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

const RPC_ALLOW = new Set([
  "get_state", "get_messages_page", "get_messages", "get_available_commands", "get_available_models",
  "get_available_thinking_levels", "set_model", "cycle_model", "set_thinking_level", "cycle_thinking_level",
  "compact", "set_auto_compaction", "set_auto_retry", "abort_retry", "bash", "abort_bash", "get_session_stats",
  "switch_session", "set_session_name", "branch", "get_tree", "get_entries", "new_session", "open_session",
  "handoff", "export_html", "set_steering_mode", "set_follow_up_mode", "get_branch_messages",
  "get_last_assistant_text", "remove_queued_message", "get_subagents", "get_subagent_messages",
  "set_subagent_subscription", "abort", "set_fast_mode", "set_todos", "get_todos",
]);

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/ws/control") {
    pool.subscribe(ws);
    ws.send(JSON.stringify({ t: "notify_ready", sessions: pool.all().map((s) => ({ chatId: s.chatId, project: s.project.name, kind: s.kind, streaming: s.state.streaming })) }));
    ws.on("close", () => pool.unsubscribe(ws));
    return;
  }
  const projectId = url.searchParams.get("project");
  const chatId = url.searchParams.get("chat") || `chat-${Math.random().toString(36).slice(2, 10)}`;
  const kind = url.searchParams.get("kind") === "chat" ? "chat" : "work";
  const approval = ["always-ask", "write", "yolo"].includes(url.searchParams.get("approval")) ? url.searchParams.get("approval") : "write";
  const resume = url.searchParams.get("resume") || null;
  const model = url.searchParams.get("model") || null;
  const thinking = url.searchParams.get("thinking") || null;
  const pr = projects.findProject(projectId);
  if (!pr) { ws.send(JSON.stringify({ type: "server_event", event: "error", error: "unknown project" })); ws.close(); return; }
  if (resume && !/^[A-Za-z0-9._-]+\.jsonl$/.test(resume)) { ws.send(JSON.stringify({ type: "server_event", event: "error", error: "bad resume file" })); ws.close(); return; }

  const r = pool.open({ chatId, project: pr, kind, approval, resumeFile: resume, model, thinking });
  if (r.error) { ws.send(JSON.stringify({ type: "server_event", event: "error", error: r.error })); ws.close(); return; }
  const s = r.session;
  s.attach(ws);
  if (!r.reused) log(`chat ${chatId} -> ${pr.name} (${kind}/${approval}) cwd=${pr.path}`);

  ws.on("message", async (data) => {
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    s.lastActivity = Date.now();
    switch (m.t) {
      case "prompt": {
        const imgs = (m.images || []).map(images.toImageContent).filter(Boolean);
        s.rpc("prompt", { message: String(m.text || ""), ...(imgs.length ? { images: imgs } : {}), ...(m.streamingBehavior ? { streamingBehavior: m.streamingBehavior } : {}) });
        break;
      }
      case "steer": {
        const imgs = (m.images || []).map(images.toImageContent).filter(Boolean);
        s.rpc("steer", { message: String(m.text || ""), ...(imgs.length ? { images: imgs } : {}) });
        break;
      }
      case "follow_up": s.rpc("follow_up", { message: String(m.text || "") }); break;
      case "abort": s.rpc("abort"); break;
      case "dispose": s.dispose(); break;
      case "ui_response":
      case "rpc": {
        const f = m.frame;
        if (!f || typeof f.type !== "string") break;
        if (f.type === "extension_ui_response" || RPC_ALLOW.has(f.type)) s.send(f);
        else s.broadcast({ type: "server_event", event: "error", error: `rpc command not allowed from client: ${f.type}` });
        break;
      }
      default: break;
    }
  });
  ws.on("close", () => s.clients.delete(ws));
});

server.listen(PORT, HOST, () => {
  log(`omp-gui v${VERSION} on http://${HOST}:${PORT} (omp: ${config.OMP_BIN}, data: ${DATA_DIR}, ire: ${config.IRE_ROOT})`);
  if (!config.PASS) log("WARNING: OMP_GUI_PASS_PLAINTEXT unset — login impossible; set it in .env");
  if (!images.configured()) log("WARNING: image generation unconfigured (ckff-image-url / ckff-cortex-image-generation)");
});

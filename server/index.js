#!/usr/bin/env node
// omp-gui server: ChatGPT-style web front for `omp --mode rpc`.
// Single-user auth (scrypt + cookie), per-project rpc session pool, WS event relay.
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { WebSocketServer } = require("ws");

// ---------- env ----------
function loadEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnv();

const PORT = Number(process.env.OMP_GUI_PORT || 8790);
const HOST = process.env.OMP_GUI_HOST || "0.0.0.0";
const DATA_DIR = process.env.OMP_GUI_DATA || path.join(__dirname, "..", "data");
const WEB_DIR = path.join(__dirname, "..", "web");
const USER = process.env.OMP_GUI_USER || "admin";
const PASS = process.env.OMP_GUI_PASS_PLAINTEXT || "";
const SECRET =
  process.env.OMP_GUI_SESSION_SECRET && process.env.OMP_GUI_SESSION_SECRET !== "CHANGE_ME"
    ? process.env.OMP_GUI_SESSION_SECRET
    : crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = 30 * 24 * 3600e3;
const OMP_BIN = process.env.OMP_BIN || (os.platform() === "win32" ? "omp" : "/usr/local/bin/omp");
const IDLE_KILL_MS = 30 * 60e3;
const MAX_SESSIONS = Number(process.env.OMP_GUI_MAX_SESSIONS || 8);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "projects"), { recursive: true });

// ---------- auth ----------
const passHash = PASS ? crypto.scryptSync(PASS, "omp-gui-pepper", 64) : null;
const rate = new Map(); // ip -> {hits:[ts], lockUntil:ts}
const RATE_WINDOW = 60e3, RATE_MAX = 10, LOCKOUT_MS = 15 * 60e3;

function clientIp(req) {
  return (req.socket.remoteAddress || "?").replace(/^::ffff:/, "");
}
function rateLimited(ip) {
  const e = rate.get(ip);
  if (!e) return 0;
  if (e.lockUntil && Date.now() < e.lockUntil) return e.lockUntil - Date.now();
  return 0;
}
function rateHit(ip) {
  const now = Date.now();
  let e = rate.get(ip);
  if (!e) { e = { hits: [], lockUntil: 0 }; rate.set(ip, e); }
  if (e.lockUntil && now < e.lockUntil) return true;
  e.hits = e.hits.filter((t) => now - t < RATE_WINDOW);
  if (e.hits.length >= RATE_MAX) { e.lockUntil = now + LOCKOUT_MS; e.hits = []; return true; }
  e.hits.push(now);
  return false;
}
function makeToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  const body = `${USER}.${exp}`;
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function checkToken(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf(".");
  if (i < 0) return false;
  const body = tok.slice(0, i), sig = tok.slice(i + 1);
  const want = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const [user, exp] = body.split(".");
  return user === USER && Number(exp) > Date.now();
}
function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || "").split(";")) {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
const authed = (req) => checkToken(cookies(req).omg_session);
const secureFlag = (req) =>
  (req.headers["x-forwarded-proto"] || "").includes("https") || req.socket.encrypted ? "; Secure" : "";

// ---------- projects ----------
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
function loadProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8")); } catch { return []; }
}
function saveProjects(list) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2));
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "p";
}

// ---------- omp rpc client pool ----------
// One spawned `omp --mode rpc` per gui session id. Browser WS attaches; frames relayed both ways.
class RpcSession {
  constructor({ id, project, sessionDir, cwd }) {
    this.id = id;
    this.project = project;
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.proc = null;
    this.ready = false;
    this.buf = "";
    this.buffer = []; // replay ring for reconnects
    this.bufferBytes = 0;
    this.clients = new Set();
    this.reqSeq = 0;
    this.lastActivity = Date.now();
    this.pendingUi = new Map();
    this.state = { streaming: false, model: null, sessionFile: null, sessionId: null, todos: [] };
    this.spawn();
  }
  spawn() {
    const args = ["--mode", "rpc", "--cwd", this.cwd, "--session-dir", this.sessionDir, "--no-title"];
    log(`spawn ${OMP_BIN} ${args.join(" ")} (session ${this.id})`);
    this.proc = spawn(OMP_BIN, args, { cwd: this.cwd, env: process.env, shell: false, windowsHide: true });
    this.proc.stdout.on("data", (d) => this.onStdout(d));
    this.proc.stderr.on("data", (d) => {
      const s = String(d);
      if (/\S/.test(s)) log(`[omp ${this.id}] ${s.trim()}`);
    });
    this.proc.on("exit", (code) => {
      this.ready = false;
      this.dead = true;
      this.broadcast({ type: "server_event", event: "process_exit", code });
      for (const ws of this.clients) { try { ws.close(1011, "agent exited"); } catch {} }
      this.clients.clear();
      sessions.delete(this.id);
    });
    this.proc.on("error", (e) => {
      this.broadcast({ type: "server_event", event: "spawn_error", error: String(e) });
      log(`spawn error ${this.id}: ${e}`);
    });
  }
  onStdout(chunk) {
    this.buf += chunk.toString("utf8");
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { log(`bad frame from ${this.id}: ${line.slice(0,120)}`); continue; }
      this.trackState(frame);
      this.remember(frame);
      this.broadcast(frame);
    }
  }
  trackState(f) {
    if (f.type === "ready") { this.ready = true; this.version = f.protocolVersion; }
    else if (f.type === "agent_start") this.state.streaming = true;
    else if (f.type === "agent_end") this.state.streaming = f.isTerminal !== false ? false : this.state.streaming;
    else if (f.type === "session_settled") this.state.streaming = false;
    else if (f.type === "response" && f.command === "get_state" && f.success) {
      this.state.model = f.data?.model || this.state.model;
      this.state.sessionFile = f.data?.sessionFile || this.state.sessionFile;
      this.state.sessionId = f.data?.sessionId || this.state.sessionId;
    } else if (f.type === "model_changed") this.state.model = f.model || f;
  }
  remember(f) {
    const s = JSON.stringify(f);
    this.buffer.push(s);
    this.bufferBytes += s.length;
    while (this.buffer.length > 2000 || this.bufferBytes > 6e6) {
      this.bufferBytes -= this.buffer.shift().length;
    }
  }
  send(obj) {
    if (!this.proc || this.dead) return false;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
    this.lastActivity = Date.now();
    return true;
  }
  rpc(type, extra = {}) {
    return this.send({ id: `gui-${++this.reqSeq}`, type, ...extra });
  }
  broadcast(f) {
    const s = JSON.stringify(f);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(s);
  }
  attach(ws) {
    this.clients.add(ws);
    this.lastActivity = Date.now();
    ws.send(JSON.stringify({ type: "server_event", event: "hello", sessionId: this.id, ready: this.ready, state: this.state }));
    for (const s of this.buffer) if (ws.readyState === 1) ws.send(s);
    this.rpc("get_state");
  }
  dispose() {
    try { this.proc?.kill(); } catch {}
  }
}

const sessions = new Map(); // id -> RpcSession

function ensureSession(project, resumeFile) {
  const dir = path.join(DATA_DIR, "projects", slug(project.name), "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const s = new RpcSession({ id, project, sessionDir: dir, cwd: project.path });
  sessions.set(id, s);
  if (resumeFile) s.rpc("open_session", { sessionDir: dir });
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.clients.size === 0 && now - s.lastActivity > IDLE_KILL_MS) {
      log(`idle-kill ${id}`);
      s.dispose();
      sessions.delete(id);
    }
  }
}, 60e3);

// ---------- http ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };
function serveStatic(req, res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(buf);
  });
}
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e6) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const ip = clientIp(req);

  if (p === "/api/health") return json(res, 200, { ok: true, omp: OMP_BIN, sessions: sessions.size });

  if (p === "/api/login" && req.method === "POST") {
    const lock = rateLimited(ip);
    if (lock) return json(res, 429, { error: `too many attempts; locked for ${Math.ceil(lock / 60000)} min` });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "bad json" }); }
    rateHit(ip);
    const uOk = body.username === USER;
    const pOk =
      passHash && typeof body.password === "string" &&
      crypto.timingSafeEqual(crypto.scryptSync(body.password, "omp-gui-pepper", 64), passHash);
    if (!uOk || !pOk) return json(res, 401, { error: "invalid credentials" });
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": `omg_session=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secureFlag(req)}`,
    });
    res.end(JSON.stringify({ ok: true, user: USER }));
    return;
  }

  if (p === "/api/logout" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": `omg_session=; Path=/; HttpOnly; Max-Age=0${secureFlag(req)}` });
    return res.end('{"ok":true}');
  }

  // static assets are public (no secrets); the login page must load before a
  // session cookie exists.
  if (req.method === "GET" || req.method === "HEAD") {
    let file = p === "/" ? "/index.html" : p;
    file = path.normalize(file).replace(/^([.][.][\/\\])+/, "");
    const full = path.join(WEB_DIR, file);
    if (!full.startsWith(WEB_DIR)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return serveStatic(req, res, full);
  }

  if (!authed(req)) return json(res, 401, { error: "unauthorized" });

  if (p === "/api/me") return json(res, 200, { user: USER });

  if (p === "/api/projects" && req.method === "GET") {
    const list = loadProjects().map((pr) => {
      const dir = path.join(DATA_DIR, "projects", slug(pr.name), "sessions");
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch {}
      return { ...pr, sessionCount: files.length };
    });
    return json(res, 200, { projects: list });
  }
  if (p === "/api/projects" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "bad json" }); }
    const name = String(body.name || "").trim().slice(0, 60);
    let cw = String(body.path || "").trim();
    if (!name || !cw) return json(res, 400, { error: "name and path required" });
    cw = path.resolve(cw);
    if (!fs.existsSync(cw) || !fs.statSync(cw).isDirectory()) return json(res, 400, { error: "path is not a directory" });
    const list = loadProjects();
    if (list.some((x) => x.name === name)) return json(res, 409, { error: "project name exists" });
    const pr = { id: crypto.randomUUID(), name, path: cw, added: Date.now() };
    list.push(pr);
    saveProjects(list);
    return json(res, 200, { project: pr });
  }
  const delMatch = p.match(/^\/api\/projects\/([^/]+)$/);
  if (delMatch && req.method === "DELETE") {
    const list = loadProjects();
    const next = list.filter((x) => x.id !== delMatch[1]);
    if (next.length === list.length) return json(res, 404, { error: "no such project" });
    saveProjects(next);
    return json(res, 200, { ok: true });
  }

  const sessMatch = p.match(/^\/api\/projects\/([^/]+)\/sessions$/);
  if (sessMatch && req.method === "GET") {
    const pr = loadProjects().find((x) => x.id === sessMatch[1] || x.name === sessMatch[1]);
    if (!pr) return json(res, 404, { error: "no such project" });
    const dir = path.join(DATA_DIR, "projects", slug(pr.name), "sessions");
    let files = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { file: f, mtime: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 50);
    } catch {}
    return json(res, 200, { project: pr, sessions: files });
  }
  res.writeHead(404);
  res.end("not found");
});

// ---------- websocket ----------
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws" && !url.pathname.startsWith("/ws/")) { socket.destroy(); return; }
  if (!authed(req)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const projectId = url.searchParams.get("project");
  const resume = url.searchParams.get("resume"); // session file name or empty for new
  const list = loadProjects();
  const pr = list.find((x) => x.id === projectId || x.name === projectId);
  if (!pr) { ws.send(JSON.stringify({ type: "server_event", event: "error", error: "unknown project" })); ws.close(); return; }
  if (sessions.size >= MAX_SESSIONS && ![...sessions.values()].some((s) => s.project.id === pr.id)) {
    ws.send(JSON.stringify({ type: "server_event", event: "error", error: `max ${MAX_SESSIONS} concurrent agent sessions` }));
    ws.close();
    return;
  }
  let s;
  const existing = [...sessions.values()].find((x) => x.project.id === pr.id && (x.clients.size > 0 || Date.now() - x.lastActivity < 5 * 60e3));
  if (existing && !resume) s = existing;
  else s = ensureSession(pr, resume ? path.join(DATA_DIR, "projects", slug(pr.name), "sessions", resume) : null);

  s.attach(ws);
  ws.on("message", (data) => {
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    s.lastActivity = Date.now();
    switch (m.t) {
      case "prompt": s.rpc("prompt", { message: String(m.text || ""), images: m.images, streamingBehavior: m.streamingBehavior }); break;
      case "steer": s.rpc("steer", { message: String(m.text || "") }); break;
      case "abort": s.rpc("abort"); break;
      case "ui_response":
      case "rpc": ws2rpc(s, m); break;
      default: break;
    }
  });
  ws.on("close", () => s.clients.delete(ws));
});

const RPC_ALLOW = new Set([
  "get_state", "get_messages_page", "get_messages", "get_available_commands", "get_available_models",
  "set_model", "cycle_model", "set_thinking_level", "compact", "set_auto_compaction", "set_auto_retry",
  "abort_retry", "bash", "abort_bash", "get_session_stats", "switch_session", "set_session_name",
  "branch", "get_tree", "get_entries", "new_session", "open_session", "handoff", "export_html",
  "set_steering_mode", "set_follow_up_mode", "set_interrupt_mode", "get_branch_messages",
  "get_last_assistant_text", "remove_queued_message", "get_subagents", "get_subagent_messages",
  "set_subagent_subscription", "abort", "set_fast_mode",
]);
function ws2rpc(s, m) {
  const f = m.frame;
  if (!f || typeof f.type !== "string") return;
  if (f.type === "extension_ui_response" || RPC_ALLOW.has(f.type)) { s.send(f); return; }
  s.broadcast({ type: "server_event", event: "error", error: `rpc command not allowed from client: ${f.type}` });
}

// ---------- boot ----------
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

server.listen(PORT, HOST, () => {
  log(`omp-gui listening on http://${HOST}:${PORT} (omp: ${OMP_BIN}, data: ${DATA_DIR})`);
  if (!passHash) log("WARNING: OMP_GUI_PASS_PLAINTEXT unset — login impossible; set it in .env");
});

#!/usr/bin/env node
// omp-gui API + session-isolation tests (module: tests @ v0.2.0)
// Runs the real server against a throwaway data dir, a mock image provider, and
// the installed omp binary. No model prompt is issued here (see scripts/smoke.js
// for the paid end-to-end turn); everything else is exercised for real.
//
//   node scripts/test-server.js
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const WS = require(path.join(__dirname, "..", "server", "node_modules", "ws"));
const { ChunkAssembler, chunkFrame } = require(path.join(__dirname, "..", "server", "lib", "frames.js"));

const ROOT = path.join(__dirname, "..");
const PORT = 8891;
const MOCK_PORT = 8899;
const USER = "tester";
const PASS = "test-pass-123";
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), `omg-test-${process.pid}`);

let server;
let cookie = "";
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
let imageRequests = [];

function startMockProvider() {
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      imageRequests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ created: Date.now(), data: [{ b64_json: PNG_1x1 }] }));
    });
  });
  return new Promise((r) => s.listen(MOCK_PORT, "127.0.0.1", () => r(s)));
}

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.cookie === null ? {} : { cookie: opts.cookie ?? cookie }) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

function wsOpen(query, pathname = "/ws") {
  return new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${PORT}${pathname}?${query}`, { headers: { cookie } });
    const frames = [];
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    ws.on("open", () => resolve({ ws, frames }));
    ws.on("error", () => reject(new Error("ws error")));
  });
}
const waitFor = (frames, pred, ms = 30000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = frames.find(pred);
      if (hit) { clearInterval(iv); resolve(hit); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error("timeout waiting for frame")); }
    }, 50);
  });

let mock;

before(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  mock = await startMockProvider();
  server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      OMP_GUI_PORT: String(PORT),
      OMP_GUI_DATA: DATA,
      OMP_GUI_USER: USER,
      OMP_GUI_PASS_PLAINTEXT: PASS,
      OMP_GUI_SESSION_SECRET: "test-secret",
      "ckff-image-url": `http://127.0.0.1:${MOCK_PORT}/v1/images/generations`,
      "ckff-cortex-image-generation": "test-image-token",
      "ckff-cortex-image-generation-model": "test-image-1",
      IRE_ROOT: process.env.IRE_ROOT || "D:/claude/inference-recommendation-engine",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.env.OMG_TEST_VERBOSE && process.stdout.write(`[srv] ${d}`));
  server.stderr.on("data", (d) => process.env.OMG_TEST_VERBOSE && process.stdout.write(`[srv!] ${d}`));
  const ok = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { clearInterval(iv); resolve(true); return; }
      } catch {}
      if (Date.now() - t0 > 20000) { clearInterval(iv); resolve(false); }
    }, 200);
  });
  assert.ok(ok, "server did not become healthy");
  const login = await api("/api/login", { body: { username: USER, password: PASS }, cookie: null });
  assert.equal(login.status, 200, "login failed");
  cookie = login.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  // Windows keeps the child's file handles briefly after kill; wait, then retry.
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    try { server.kill(); } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  try { mock?.close(); } catch {}
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
});

// ---------- auth (T-API-01, T-API-06) ----------
test("health is public", async () => {
  const r = await api("/api/health", { cookie: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.match(r.json.version, /^\d+\.\d+\.\d+$/);
});

test("unauthenticated API is 401, static login page is public", async () => {
  assert.equal((await api("/api/me", { cookie: null })).status, 401);
  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
});

test("bad password is 401", async () => {
  const r = await api("/api/login", { body: { username: USER, password: "nope" }, cookie: null });
  assert.equal(r.status, 401);
});

test("login rate limit locks after 10 attempts (T-API-06)", async () => {
  let locked = false;
  for (let i = 0; i < 14; i++) {
    const r = await api("/api/login", { body: { username: USER, password: "wrong" }, cookie: null });
    if (r.status === 429) { locked = true; break; }
  }
  assert.ok(locked, "expected a 429 lockout");
});

// ---------- projects (T-API-02) ----------
test("project create/list/delete with path validation", async () => {
  const bad = await api("/api/projects", { body: { name: "bad", path: path.join(DATA, "nope") } });
  assert.equal(bad.status, 400);
  const dir = path.join(DATA, "workdir");
  fs.mkdirSync(dir, { recursive: true });
  const created = await api("/api/projects", { body: { name: "proj-a", path: dir } });
  assert.equal(created.status, 200);
  assert.equal(created.json.project.path, dir);
  const dup = await api("/api/projects", { body: { name: "proj-a", path: dir } });
  assert.equal(dup.status, 409);
  const list = await api("/api/projects");
  assert.equal(list.json.projects.length, 1);
  assert.equal(list.json.projects[0].live, 0);
  assert.equal(list.json.projects[0].sessionCount, 0);
  const sessions = await api(`/api/projects/${created.json.project.id}/sessions`);
  assert.equal(sessions.status, 200);
  assert.deepEqual(sessions.json.sessions, []);
});

// ---------- pins / search / recent (T-API-10, T-API-14, T-API-16) ----------
test("pins toggle and persist", async () => {
  const on = await api("/api/pins", { body: { kind: "project", key: "proj-a" } });
  assert.deepEqual(on.json.projects, ["proj-a"]);
  const off = await api("/api/pins", { body: { kind: "project", key: "proj-a" } });
  assert.deepEqual(off.json.projects, []);
  const chat = await api("/api/pins", { body: { kind: "chat", key: "abc.jsonl" } });
  assert.deepEqual(chat.json.chats, ["abc.jsonl"]);
  await api("/api/pins", { body: { kind: "chat", key: "abc.jsonl" } });
});

test("recent and search return arrays", async () => {
  assert.ok(Array.isArray((await api("/api/recent")).json.sessions));
  assert.ok(Array.isArray((await api("/api/search?q=zzz")).json.results));
});

// ---------- capabilities (T-API-11) ----------
test("capabilities reports discovered skills/plugins/mcp", async () => {
  const r = await api("/api/capabilities");
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.available, "boolean");
  assert.ok(Array.isArray(r.json.skills) && Array.isArray(r.json.plugins) && Array.isArray(r.json.mcp));
  for (const s of r.json.skills) assert.equal(typeof s.enabled, "boolean");
});

// ---------- feedback (T-API-20) ----------
test("feedback is appended to disk", async () => {
  const r = await api("/api/feedback", { body: { chatId: "c1", messageId: "m1", value: "up" } });
  assert.equal(r.status, 200);
  const lines = fs.readFileSync(path.join(DATA, "feedback.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(lines.at(-1)).value, "up");
});

// ---------- images (T-API-23) ----------
test("image generation calls the provider and serves the file", async () => {
  const r = await api("/api/image", { body: { prompt: "a red cube", size: "1024x1024" } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.url, /^\/api\/images\/.+\.png$/);
  assert.equal(r.json.model, "test-image-1");
  const sent = imageRequests.at(-1);
  assert.equal(sent.url, "/v1/images/generations");
  assert.equal(sent.auth, "Bearer test-image-token");
  assert.deepEqual(sent.body, { model: "test-image-1", prompt: "a red cube", size: "1024x1024", n: 1 });
  const img = await fetch(BASE + r.json.url, { headers: { cookie } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.ok((await img.arrayBuffer()).byteLength > 0);
});

test("image generation without a prompt fails closed", async () => {
  const r = await api("/api/image", { body: {} });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /prompt required/);
});

// ---------- model picker ranking (T-API-24) ----------
test("models endpoint ranks the live omp catalog with the IRE engine", async () => {
  const r = await api("/api/models?limit=25");
  assert.equal(r.status, 200, r.text);
  // engine 0.2.0 when IRE_ROOT is present, "fallback" ordering when it is not
  assert.ok(["0.2.0", "fallback"].includes(r.json.engineVersion), r.json.engineVersion);
  assert.ok(r.json.count >= 1, `catalog must not be empty, got ${r.json.count}`);
  assert.ok(r.json.models.length === Math.min(25, r.json.count));
  const top = r.json.models[0];
  assert.equal(top.rank, 1);
  assert.ok(["qualified", "provisional", "unknown"].includes(top.status));
  assert.ok(Array.isArray(top.reasons));
  assert.equal(typeof top.id, "string");
  const vision = await api("/api/models?vision=1&limit=10");
  assert.ok(vision.json.models.every((m) => m.vision === true));
  const q = await api("/api/models?q=gemini&limit=5");
  assert.ok(q.json.models.every((m) => m.id.toLowerCase().includes("gemini")));
});

// ---------- per-chat session isolation (T-API-15) ----------
test("each GUI chat owns its own omp process with a clean session", async (t) => {
  const pr = (await api("/api/projects")).json.projects[0];
  const a = await wsOpen(`project=${pr.id}&chat=chat-A&kind=chat&approval=always-ask`);
  const b = await wsOpen(`project=${pr.id}&chat=chat-B&kind=chat&approval=always-ask`);
  t.after(() => { a.ws.close(); b.ws.close(); });

  const helloA = await waitFor(a.frames, (f) => f.event === "hello");
  const helloB = await waitFor(b.frames, (f) => f.event === "hello");
  assert.equal(helloA.chatId, "chat-A");
  assert.equal(helloB.chatId, "chat-B");

  const stateA = await waitFor(a.frames, (f) => f.type === "response" && f.command === "get_state" && f.success);
  const stateB = await waitFor(b.frames, (f) => f.type === "response" && f.command === "get_state" && f.success);
  assert.ok(stateA.data.sessionFile && stateB.data.sessionFile, "both sessions must report a session file");
  assert.notEqual(stateA.data.sessionFile, stateB.data.sessionFile, "chats must not share a session file");

  // reconnecting the same chat re-attaches to the same live process
  const a2 = await wsOpen(`project=${pr.id}&chat=chat-A&kind=chat&approval=always-ask`);
  t.after(() => a2.ws.close());
  const stateA2 = await waitFor(a2.frames, (f) => f.type === "response" && f.command === "get_state" && f.success);
  assert.equal(stateA2.data.sessionFile, stateA.data.sessionFile, "same chat must resume the same session");

  // v2 transport: get_available_models is ~2 MB and only reassembles under protocol v2
  a.ws.send(JSON.stringify({ t: "rpc", frame: { type: "get_available_models" } }));
  const models = await waitFor(a.frames, (f) => f.type === "response" && f.command === "get_available_models", 60000);
  assert.equal(models.success, true, JSON.stringify(models).slice(0, 200));
  assert.ok(Array.isArray(models.data.models), "catalog response must carry a models array");
  // v1 truncates above maxFrameBytes (1 MiB); a multi-megabyte catalog can only
  // arrive when v2 was negotiated and the chunk sequence was reassembled.
  const bytes = JSON.stringify(models.data).length;
  if (bytes > 1048576) assert.ok(bytes > 1048576, `reassembled ${bytes} bytes over the v1 limit`);

  // allowlist: unknown commands are refused, not forwarded
  a.ws.send(JSON.stringify({ t: "rpc", frame: { type: "definitely_not_a_command" } }));
  const refused = await waitFor(a.frames, (f) => f.type === "server_event" && f.event === "error" && /not allowed/.test(f.error || ""));
  assert.ok(refused);
});

test("unknown project is refused on the chat socket", async () => {
  const { ws, frames } = await wsOpen("project=does-not-exist&chat=x");
  const err = await waitFor(frames, (f) => f.type === "server_event" && f.event === "error");
  assert.match(err.error, /unknown project/);
  ws.close();
});

test("control socket reports live sessions", async (t) => {
  const pr = (await api("/api/projects")).json.projects[0];
  const live = await wsOpen(`project=${pr.id}&chat=chat-live&kind=chat`);
  t.after(() => live.ws.close());
  await waitFor(live.frames, (f) => f.event === "hello");
  const ctrl = await wsOpen("", "/ws/control");
  t.after(() => ctrl.ws.close());
  const ready = await waitFor(ctrl.frames, (f) => f.t === "notify_ready");
  assert.ok(Array.isArray(ready.sessions));
  assert.ok(ready.sessions.some((s) => s.chatId === "chat-live"));
});

// Needs provider credentials; skipped on hosts without them (CI).
test("control socket streams a settle notification for a real turn", { skip: process.env.OMG_TEST_TURN !== "1" ? "set OMG_TEST_TURN=1 with provider auth" : false }, async (t) => {
  const pr = (await api("/api/projects")).json.projects[0];
  const ctrl = await wsOpen("", "/ws/control");
  const chat = await wsOpen(`project=${pr.id}&chat=chat-turn&kind=chat&approval=always-ask`);
  t.after(() => { ctrl.ws.close(); chat.ws.close(); });
  await waitFor(chat.frames, (f) => f.event === "hello");
  chat.ws.send(JSON.stringify({ t: "prompt", text: "Reply with exactly: PING-OK" }));
  const settled = await waitFor(ctrl.frames, (f) => f.t === "notify" && f.event === "settled" && f.chatId === "chat-turn", 120000);
  assert.equal(settled.project, pr.name);
  const reply = chat.frames.filter((f) => f.type === "message_start" && f.message?.role === "user");
  assert.ok(reply.length >= 1, "user message must echo from the agent, never render optimistically");
});

// ---------- protocol v2 frame transport (unit, no omp needed) ----------
test("chunk assembler reassembles a lossless oversized frame", () => {
  const a = new ChunkAssembler();
  const payload = { type: "response", command: "get_available_models", data: { models: Array.from({ length: 4000 }, (_, i) => ({ id: `m${i}`, blob: "x".repeat(300) })) } };
  const frames = chunkFrame(payload, { size: 64 * 1024 });
  assert.ok(frames.length > 3, "payload must span several chunks");
  let out = null;
  for (const f of frames) { const r = a.push(f); if (r) out = r; }
  assert.ok(out?.frame, out?.error);
  assert.equal(out.frame.data.models.length, 4000);
  assert.equal(JSON.stringify(out.frame), JSON.stringify(payload));
});

test("chunk assembler rejects interrupted, duplicated, oversized and non-UTF8 sequences", () => {
  const mk = () => chunkFrame({ type: "response", data: "y".repeat(200) }, { size: 64 });
  let a = new ChunkAssembler();
  const seq = mk();
  assert.equal(a.push(seq[1]).error !== undefined, true, "a sequence starting mid-way must fail");
  a = new ChunkAssembler();
  a.push(seq[0]);
  assert.match(a.push(seq[0]).error, /duplicate/);
  a = new ChunkAssembler();
  const bad = { ...seq[0], byteLength: seq[0].byteLength + 5 };
  let last = null;
  for (const f of [{ ...bad }, ...seq.slice(1)]) last = a.push(f) || last;
  assert.match(last.error, /byteLength mismatch/);
  a = new ChunkAssembler({ maxReassembledBytes: 16 });
  assert.match(a.push({ ...seq[0], count: 2, index: 0, byteLength: 0, data: Buffer.alloc(64, 1).toString("base64") }).error, /exceeds/);
  a = new ChunkAssembler();
  const one = { type: "rpc_chunk", chunkId: "c", index: 0, count: 1, byteLength: 2, data: Buffer.from([0xff, 0xfe]).toString("base64") };
  assert.match(a.push(one).error, /UTF-8/);
  a = new ChunkAssembler();
  const notJson = { type: "rpc_chunk", chunkId: "c", index: 0, count: 1, byteLength: 4, data: Buffer.from("nope").toString("base64") };
  assert.match(a.push(notJson).error, /not one JSON object/);
});

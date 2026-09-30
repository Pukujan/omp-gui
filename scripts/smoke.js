/* end-to-end smoke: health -> login -> add project -> ws prompt -> expect streaming + reply */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require(path.join(__dirname, "..", "server", "node_modules", "ws"));

// credentials come from the gitignored repo .env — never hardcode them
const ENV = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_-]+)=(.*)$/i))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);
const USER = ENV.OMP_GUI_USER;
const PASS = ENV.OMP_GUI_PASS_PLAINTEXT;
if (!USER || !PASS) { console.error("FAIL: .env missing OMP_GUI_USER/OMP_GUI_PASS_PLAINTEXT"); process.exit(1); }

const BASE = "http://127.0.0.1:8790";
function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("ok:", m); };

(async () => {
  let r = await req("GET", "/api/health");
  ok(r.status === 200 && JSON.parse(r.body).ok, "health");

  r = await req("GET", "/api/projects");
  ok(r.status === 401, "projects require auth");

  r = await req("POST", "/api/login", { username: USER, password: "WRONG-PASSWORD" });
  ok(r.status === 401, "bad password rejected");

  r = await req("POST", "/api/login", { username: USER, password: PASS });
  ok(r.status === 200, "login ok");
  const cookie = (r.headers["set-cookie"] || []).find((c) => c.startsWith("omg_session=")).split(";")[0];

  r = await req("GET", "/api/me", null, cookie);
  const me = JSON.parse(r.body);
  ok(r.status === 200 && !!me.user, "me (" + me.user + ", v" + me.version + ")");

  r = await req("GET", "/api/models?limit=5", null, cookie);
  const ranked = JSON.parse(r.body);
  ok(r.status === 200 && ranked.models?.length === 5, "ranked model picker (engine " + ranked.engineVersion + ", " + ranked.count + " models)");

  r = await req("POST", "/api/projects", { name: "smoke", path: process.env.TEMP + "\\omp-gui-smoke" }, cookie);
  if (r.status !== 200) { ok(r.status === 409, "project exists"); }
  const pr = JSON.parse((await req("GET", "/api/projects", null, cookie)).body).projects.find((p) => p.name === "smoke");
  ok(pr, "project listed");

  // websocket: prompt the real agent in its own chat (one process per chat)
  const chatId = "smoke-" + Date.now().toString(36);
  const ws = new WebSocket(`ws://127.0.0.1:8790/ws?project=${pr.id}&chat=${chatId}&kind=work&approval=write`, { headers: { cookie } });
  const frames = [];
  let gotText = "";
  let settled = false;
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("ws open timeout")), 30000);
    ws.on("open", () => { clearTimeout(t); res(); });
    ws.on("error", rej);
  });
  console.log("ok: ws open");
  ws.on("message", (d) => {
    const f = JSON.parse(d);
    frames.push(f.type + (f.command ? ":" + f.command : "") + (f.event ? ":" + f.event : ""));
    if (f.type === "message_update" && f.assistantMessageEvent?.type === "text_delta") gotText += f.assistantMessageEvent.delta;
    if (f.type === "session_settled") settled = true;
    if (f.type === "server_event" && f.event === "hello") ok(f.chatId === chatId && f.ready !== undefined, "hello names the chat (" + f.chatId + ", kind " + f.kind + ")");
  });
  // wait for ready frame
  await new Promise((res) => setTimeout(res, 8000));
  ws.send(JSON.stringify({ t: "prompt", text: "Reply with exactly: OMG-GUI-OK" }));
  const t0 = Date.now();
  while (!settled && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 500));
  ok(settled, "session settled");
  ok(/OMG-GUI-OK/.test(gotText), "assistant text streamed: " + JSON.stringify(gotText.slice(0, 60)));
  console.log("frames:", frames.slice(0, 14).join(", "), "…", frames.length, "total");
  ws.close();
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });

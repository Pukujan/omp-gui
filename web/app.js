/* omp-gui client: talks to /api/* (projects) and /ws (omp rpc frames). */
"use strict";

const $ = (s) => document.querySelector(s);
const state = {
  projects: [],
  current: null,      // project
  ws: null,
  sessionId: null,
  streaming: false,
  model: null,
  thinking: null,
  commands: [],
  msgs: new Map(),    // messageId -> {kind, el, text}
  tools: new Map(),   // toolCallId -> el
  todos: [],
  subagents: new Map(),
  queue: { steering: [], followUp: [] },
  pendingUi: null,
  lastUserText: "",
};

/* ---------- login ---------- */
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#l-err").textContent = "";
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: $("#l-user").value.trim(), password: $("#l-pass").value }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("#l-err").textContent = j.error || "login failed"; return; }
  boot();
});

$("#logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  location.reload();
});

async function boot() {
  const me = await fetch("/api/me");
  if (me.status === 401) return; // login overlay already visible
  const j = await me.json();
  $("#login").classList.add("hidden");
  $("#whoami").textContent = j.user;
  await loadProjects();
}

/* ---------- projects / sidebar ---------- */
async function loadProjects() {
  const r = await fetch("/api/projects");
  if (!r.ok) return;
  state.projects = (await r.json()).projects || [];
  renderProjects();
}

function renderProjects() {
  const box = $("#project-list");
  box.innerHTML = "";
  for (const pr of state.projects) {
    const node = $("#tpl-project").content.firstElementChild.cloneNode(true);
    node.querySelector(".proj-name").textContent = pr.name;
    node.querySelector(".proj-name").addEventListener("click", () => openProject(pr));
    node.querySelector(".proj-caret").addEventListener("click", (ev) => { ev.stopPropagation(); toggleSessions(pr, node.querySelector(".sess-list")); });
    if (state.current && state.current.id === pr.id) node.classList.add("active");
    box.appendChild(node);
  }
}

async function toggleSessions(pr, list) {
  const parent = list.closest(".project");
  if (parent.classList.contains("open")) { parent.classList.remove("open"); list.innerHTML = ""; return; }
  parent.classList.add("open");
  list.innerHTML = '<div class="sess muted">loading…</div>';
  const r = await fetch(`/api/projects/${pr.id}/sessions`);
  if (!r.ok) { list.innerHTML = '<div class="sess err">failed</div>'; return; }
  const { sessions } = await r.json();
  list.innerHTML = "";
  if (!sessions.length) { list.innerHTML = '<div class="sess muted">no chats yet</div>'; return; }
  for (const s of sessions.slice(0, 25)) {
    const el = document.createElement("button");
    el.className = "sess";
    el.innerHTML = `<span>${chatTitle(s)}</span><span class="when">${ago(s.mtime)}</span>`;
    el.addEventListener("click", () => openProject(pr, s.file));
    list.appendChild(el);
  }
}

function chatTitle(s) {
  const m = s.file.match(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_(.+)\.jsonl$/);
  return m ? m[1].slice(0, 8) + "…" : s.file.replace(/\.jsonl$/, "").slice(0, 28);
}
function ago(ms) {
  const d = (Date.now() - ms) / 1000;
  if (d < 90) return "now";
  if (d < 3600 * 24) return Math.round(d / 3600) + "h";
  return Math.round(d / 86400) + "d";
}

$("#add-project").addEventListener("click", () => {
  const pop = $("#project-pop");
  pop.innerHTML = `
    <div class="pop-title">Add project</div>
    <input id="np-name" placeholder="name (e.g. Study-os)">
    <input id="np-path" placeholder="absolute path on this machine">
    <div class="err" id="np-err"></div>
    <button class="primary" id="np-ok">Add</button>`;
  pop.classList.remove("hidden");
  pop.style.left = "16px";
  pop.style.bottom = "120px";
  $("#np-ok").onclick = async () => {
    const r = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $("#np-name").value, path: $("#np-path").value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $("#np-err").textContent = j.error || "failed"; return; }
    pop.classList.add("hidden");
    await loadProjects();
    openProject(j.project);
  };
});

$("#new-chat").addEventListener("click", () => {
  if (state.current) openProject(state.current);
  else $("#sidebar").classList.add("open");
});

document.addEventListener("click", (e) => {
  for (const sel of ["#model-pop", "#think-pop", "#project-pop"]) {
    const el = $(sel);
    if (!el.classList.contains("hidden") && !el.contains(e.target) && !e.target.closest(".pill")) el.classList.add("hidden");
  }
});

/* ---------- session / websocket ---------- */
function openProject(pr, resumeFile) {
  state.current = pr;
  $("#chat-title").textContent = pr.name;
  $("#welcome").classList.add("hidden");
  $("#composer").classList.remove("hidden");
  $("#thread").innerHTML = "";
  state.msgs.clear(); state.tools.clear(); state.subagents.clear();
  renderProjects();
  connect(pr, resumeFile);
  if (window.innerWidth < 900) $("#sidebar").classList.remove("open");
}

function connect(pr, resumeFile) {
  state.ws?.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = `project=${encodeURIComponent(pr.id)}${resumeFile ? `&resume=${encodeURIComponent(resumeFile)}` : ""}`;
  const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
  state.ws = ws;
  ws.onopen = () => setStatus("connecting…");
  ws.onclose = () => { setStatus("disconnected"); state.streaming = false; setBusy(false); };
  ws.onerror = () => setStatus("connection error");
  ws.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    handleFrame(f);
  };
}

function send(obj) { if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(obj)); }

/* ---------- rpc frame handling ---------- */
const pendingResponses = new Map();

function handleFrame(f) {
  switch (f.type) {
    case "server_event": return onServerEvent(f);
    case "response": return onResponse(f);
    case "agent_start": state.streaming = true; setBusy(true); return;
    case "agent_end": if (f.isTerminal !== false) { state.streaming = false; setBusy(false); } return;
    case "session_settled": state.streaming = false; setBusy(false); return;
    case "prompt_result": if (f.status === "error") flashError(f.error?.message || "turn failed"); return;
    case "message_start": return onMessageStart(f);
    case "message_update": return onMessageUpdate(f);
    case "message_end": return onMessageEnd(f);
    case "tool_execution_start": return onToolStart(f);
    case "tool_execution_update": return onToolUpdate(f);
    case "tool_execution_end": return onToolEnd(f);
    case "queue_update": state.queue = { steering: f.steering || [], followUp: f.followUp || [] }; return renderQueue();
    case "available_commands_update": state.commands = f.commands || []; return;
    case "model_changed": state.model = f.model || f; renderModel(); return;
    case "thinking_level_changed": state.thinking = f.level || f.thinkingLevel; renderModel(); return;
    case "extension_ui_request": return onUiRequest(f);
    case "notice": return flashNote(f.text || f.message || "");
    case "auto_compaction_start": return setStatus("compacting…");
    case "auto_retry_start": return setStatus("retrying…");
    case "subagent_lifecycle":
    case "subagent_progress": return onSubagent(f);
    default: return;
  }
}

function onServerEvent(f) {
  if (f.event === "hello") {
    state.sessionId = f.sessionId;
    setStatus(f.ready ? "" : "starting agent…");
  } else if (f.event === "error" || f.event === "spawn_error") {
    flashError(f.error || "agent error");
  } else if (f.event === "process_exit") {
    setStatus("agent stopped");
  }
}

function onResponse(f) {
  if (f.command) pendingResponses.set(f.command, f);
  if (!f.success) { if (f.command !== "get_state") flashError(`${f.command}: ${f.error}`); return; }
  if (f.command === "get_state") {
    const d = f.data || {};
    state.model = d.model || state.model;
    state.thinking = d.thinkingLevel || state.thinking;
    state.streaming = !!d.isStreaming;
    state.queue = d.queuedMessages || state.queue;
    state.todos = d.todoPhases || [];
    renderModel(); renderQueue(); setBusy(state.streaming);
    if (d.contextUsage) setStatus(`${d.model?.id || ""} · ${Math.round(d.contextUsage.percent || 0)}% ctx${d.tokensPerSecond ? ` · ${d.tokensPerSecond.toFixed(1)} tok/s` : ""}`);
  } else if (f.command === "get_messages_page" || f.command === "get_messages") {
    for (const m of f.data.messages || []) replayMessage(m);
  }
}

/* messages */
function onMessageStart(f) {
  const m = f.message || {};
  const id = f.messageId;
  if (m.role === "user") {
    const el = addMessage("user", textOf(m));
    state.msgs.set(id, { kind: "user", el, text: textOf(m) });
  } else if (m.role === "assistant") {
    const el = addMessage("assistant", "");
    state.msgs.set(id, { kind: "assistant", el, text: "", think: "" });
  }
}
function onMessageUpdate(f) {
  const rec = state.msgs.get(f.messageId);
  if (!rec) return;
  const e = f.assistantMessageEvent;
  if (!e) {
    if (f.message?.role === "assistant") { rec.text = textOf(f.message); paint(rec.el, rec.text); }
    return;
  }
  if (e.type === "text_delta") { rec.text += e.delta; paint(rec.el, rec.text); }
  else if (e.type === "thinking_delta") { rec.think += e.delta; showThink(rec); }
}
function onMessageEnd(f) {
  const rec = state.msgs.get(f.messageId);
  if (!rec) return;
  if (f.message?.role === "assistant") {
    rec.text = textOf(f.message) || rec.text;
    if (!rec.text && f.message.stopReason === "error") paint(rec.el, "⚠ provider error (see fallback notice)");
    else paint(rec.el, rec.text);
  }
  if (rec.think) showThink(rec, true);
}
function replayMessage(m) {
  if (m.role === "user" && m.attribution !== "agent") addMessage("user", textOf(m));
  else if (m.role === "assistant") { const el = addMessage("assistant", ""); paint(el, textOf(m)); }
}
function textOf(m) {
  return (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}
function addMessage(role, text) {
  const node = $("#tpl-msg").content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector(".bubble").textContent = text || "";
  if (!text) node.querySelector(".bubble").classList.add("pending");
  $("#thread").appendChild(node);
  scrollDown();
  return node;
}
function paint(el, text) {
  const b = el.querySelector(".md");
  b.classList.remove("pending");
  b.innerHTML = md(text);
  scrollDown();
}
function showThink(rec, done) {
  let d = rec.el.querySelector(".think");
  if (!d) {
    d = document.createElement("details");
    d.className = "think";
    d.innerHTML = "<summary>thinking</summary><pre></pre>";
    rec.el.querySelector(".bubble").prepend(d);
  }
  d.querySelector("pre").textContent = rec.think;
  if (done) d.open = false;
}
function md(text) {
  if (!window.marked || !window.DOMPurify) return escapeHtml(text);
  const raw = window.marked.parse(text || "", { breaks: true, gfm: true });
  return DOMPurify.sanitize(raw);
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

let stick = true;
$("#chat").addEventListener("scroll", (e) => { stick = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 120; });
function scrollDown() { if (stick) { const c = $("#chat"); c.scrollTop = c.scrollHeight; } }

/* tools */
function onToolStart(f) {
  const el = $("#tpl-tool").content.firstElementChild.cloneNode(true);
  el.querySelector(".tname").textContent = f.toolName || "tool";
  el.querySelector(".tsum").textContent = summarize(f.args);
  el.classList.add("running");
  $("#thread").appendChild(el);
  state.tools.set(f.toolCallId, el);
  scrollDown();
}
function onToolUpdate(f) {
  const el = state.tools.get(f.toolCallId);
  if (!el) return;
  const r = f.partialResult || f.result;
  if (r) el.querySelector(".tbody").textContent = resultText(r);
}
function onToolEnd(f) {
  const el = state.tools.get(f.toolCallId);
  if (!el) return;
  el.classList.remove("running");
  el.classList.add(f.isError ? "error" : "done");
  const r = f.result;
  if (r) el.querySelector(".tbody").textContent = resultText(r);
}
function resultText(r) {
  const c = r.content || r;
  if (typeof c === "string") return c;
  return (Array.isArray(c) ? c : []).map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n").slice(0, 20000);
}
function summarize(args) {
  if (!args || typeof args !== "object") return "";
  const k = ["path", "command", "query", "pattern", "message", "code", "url", "task"];
  for (const key of k) if (args[key]) return String(args[key]).replace(/\s+/g, " ").slice(0, 90);
  return Object.keys(args).slice(0, 3).join(", ");
}

/* subagents */
function onSubagent(f) {
  const id = f.subagentId || f.id || "?";
  const cur = state.subagents.get(id) || { id };
  Object.assign(cur, {
    name: f.name || cur.name || id,
    status: f.status || f.event || cur.status || "",
    progress: f.summary || (typeof f.progress === "string" ? f.progress : cur.progress) || "",
  });
  state.subagents.set(id, cur);
  renderAgents();
}
function renderAgents() {
  const body = $("#agents-body");
  if (!state.subagents.size) { body.innerHTML = '<div class="muted pad">No active subagents</div>'; return; }
  body.innerHTML = [...state.subagents.values()].map((a) => `<div class="agent"><b>${escapeHtml(a.name)}</b><div class="muted">${escapeHtml(a.status)} ${escapeHtml(a.progress)}</div></div>`).join("");
}
$("#toggle-agents").addEventListener("click", () => {
  const panel = $("#agents");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) {
    send({ t: "rpc", frame: { type: "set_subagent_subscription", level: "progress" } });
    renderAgents();
  }
});
$("#close-agents").addEventListener("click", () => $("#agents").classList.add("hidden"));

/* ui requests (ask tool / extension dialogs) */
function onUiRequest(f) {
  state.pendingUi = f;
  if (f.method === "confirm") return dialog(f, `<div class="q">${escapeHtml(f.message || "")}</div><div class="row"><button id="ui-no" class="ghost">Cancel</button><button id="ui-yes" class="primary">Confirm</button></div>`, () => {
    $("#ui-yes").onclick = () => answer(f.id, { confirmed: true });
    $("#ui-no").onclick = () => answer(f.id, { cancelled: true });
  });
  if (f.method === "input" || f.method === "editor") return dialog(f, `<div class="q">${escapeHtml(f.title || "")}</div><textarea id="ui-in" rows="4" placeholder="${escapeHtml(f.placeholder || "")}">${escapeHtml(f.value || "")}</textarea><div class="row"><button id="ui-cancel" class="ghost">Cancel</button><button id="ui-ok" class="primary">Send</button></div>`, () => {
    $("#ui-ok").onclick = () => answer(f.id, { value: $("#ui-in").value });
    $("#ui-cancel").onclick = () => answer(f.id, { cancelled: true });
    setTimeout(() => $("#ui-in")?.focus(), 30);
  });
  if (f.method === "select") {
    const opts = (f.options || []).map((o, i) => `<button class="opt" data-i="${i}">${escapeHtml(o)}</button>`).join("");
    return dialog(f, `<div class="q">${escapeHtml(f.title || "")}</div><div class="opts">${opts}</div>`, () => {
      document.querySelectorAll("#ui-dialog .opt").forEach((b) => (b.onclick = () => answer(f.id, { value: f.options[+b.dataset.i] })));
    });
  }
  if (f.method === "notify") { flashNote(f.message || ""); return; }
  if (f.method === "setStatus" || f.method === "setWidget" || f.method === "setTitle" || f.method === "set_editor_text") return;
  answer(f.id, { cancelled: true });
}
function answer(id, extra) {
  send({ t: "ui_response", frame: { type: "extension_ui_response", id, ...extra } });
  $("#ui-dialog")?.remove();
  state.pendingUi = null;
}
function dialog(f, html, wire) {
  $("#ui-dialog")?.remove();
  const el = document.createElement("div");
  el.id = "ui-dialog";
  el.className = "ui-dialog";
  el.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(el);
  wire?.();
}

/* ---------- composer ---------- */
const input = $("#input");
input.addEventListener("input", () => {
  input.style.height = "0px";
  input.style.height = Math.min(input.scrollHeight, 240) + "px";
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !isMobile()) { e.preventDefault(); $("#composer").requestSubmit(); }
  if (e.key === "Escape" && state.streaming) { send({ t: "abort" }); flashNote("aborting…"); }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = ""; input.style.height = "0px";
  stick = true;
  // no optimistic bubble: the agent echoes message_start for every user message
  // (including queued steering/follow-ups), which is also what a reconnect replay shows.
  if (state.streaming) {
    const steer = $("#steer-btn").classList.contains("on");
    send({ t: steer ? "steer" : "prompt", text, streamingBehavior: steer ? undefined : "followUp" });
  } else {
    send({ t: "prompt", text });
  }
});
$("#steer-btn").addEventListener("click", () => $("#steer-btn").classList.toggle("on"));

function setBusy(b) {
  $("#send").classList.toggle("busy", b);
  $("#send").title = b ? "stop" : "send";
  $("#steer-btn").classList.toggle("hidden", !b);
}
$("#send").addEventListener("click", (e) => {
  if (state.streaming && !input.value.trim()) { e.preventDefault(); send({ t: "abort" }); }
}, true);

/* model + thinking pickers */
$("#model-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  const pop = $("#model-pop");
  if (!pop.classList.contains("hidden")) { pop.classList.add("hidden"); return; }
  pop.innerHTML = '<div class="muted pad">loading models…</div>';
  pop.classList.remove("hidden");
  anchor(pop, $("#model-btn"));
  pendingResponses.delete("get_available_models");
  send({ t: "rpc", frame: { id: "gui-models", type: "get_available_models" } });
  const r = await waitResponse("get_available_models", 3000);
  const models = (r?.data?.models || r?.data?.available || []).filter((m) => m && m.id);
  if (!models.length) { pop.innerHTML = '<div class="muted pad">no model list from agent</div>'; return; }
  pop.innerHTML = models.map((m, i) => `<button class="mrow" data-i="${i}"><span>${escapeHtml(m.id)}</span><span class="muted">${escapeHtml(m.provider || "")}</span></button>`).join("");
  pop.querySelectorAll(".mrow").forEach((b) => (b.onclick = () => {
    const m = models[+b.dataset.i];
    send({ t: "rpc", frame: { type: "set_model", provider: m.provider, modelId: m.id } });
    pop.classList.add("hidden");
  }));
});
$("#think-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  const pop = $("#think-pop");
  if (!pop.classList.contains("hidden")) { pop.classList.add("hidden"); return; }
  pop.classList.remove("hidden");
  anchor(pop, $("#think-btn"));
  pop.innerHTML = '<div class="muted pad">loading…</div>';
  pendingResponses.delete("get_available_thinking_levels");
  send({ t: "rpc", frame: { id: "gui-think", type: "get_available_thinking_levels" } });
  const r = await waitResponse("get_available_thinking_levels", 3000);
  const levels = r?.data?.levels || ["off", "minimal", "low", "medium", "high", "xhigh"];
  pop.innerHTML = levels.map((l) => `<button class="mrow" data-l="${escapeHtml(l)}">${escapeHtml(l)}</button>`).join("");
  pop.querySelectorAll(".mrow").forEach((b) => (b.onclick = () => {
    send({ t: "rpc", frame: { type: "set_thinking_level", level: b.dataset.l } });
    pop.classList.add("hidden");
  }));
});
function renderModel() {
  $("#model-name").textContent = state.model?.id || state.model || "model";
  const t = $("#think-btn");
  if (state.thinking) { t.classList.remove("hidden"); t.textContent = state.thinking + " ▾"; }
}
function anchor(pop, btn) {
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 340)) + "px";
  pop.style.top = (r.bottom + 6) + "px";
}
function waitResponse(command, ms) {
  const t0 = Date.now();
  return new Promise((res) => {
    const poll = setInterval(() => {
      const f = pendingResponses.get(command);
      if (f) { pendingResponses.delete(command); clearInterval(poll); res(f); }
      else if (Date.now() - t0 > ms) { clearInterval(poll); res(null); }
    }, 60);
  });
}

/* queue + status */
function renderQueue() {
  const q = [...(state.queue.steering || []).map((s) => ["steer", s]), ...(state.queue.followUp || []).map((s) => ["next", s])];
  const el = $("#queue");
  el.classList.toggle("hidden", !q.length);
  el.innerHTML = q.map(([kind, text]) => `<span class="chip">${kind}: ${escapeHtml(String(text).slice(0, 60))}<button data-kind="${kind}" data-text="${escapeHtml(String(text))}">✕</button></span>`).join("");
  el.querySelectorAll("button").forEach((b) => (b.onclick = () => send({ t: "rpc", frame: { type: "remove_queued_message", message: b.dataset.text, queue: b.dataset.kind === "steer" ? "steering" : "followUp" } })));
}
let statusTimer = null;
function setStatus(s) {
  const el = $("#statusline");
  el.classList.toggle("hidden", !s);
  el.textContent = s;
  clearTimeout(statusTimer);
  if (s) statusTimer = setTimeout(() => setStatus(""), 8000);
}
function flashError(msg) { setStatus("⚠ " + msg); addSystem("⚠ " + msg, "err"); }
function flashNote(msg) { if (msg) addSystem(msg, "note"); }
function addSystem(text, cls) {
  const el = document.createElement("div");
  el.className = "sys " + cls;
  el.textContent = text;
  $("#thread").appendChild(el);
  scrollDown();
}

/* mobile drawer */
$("#menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#collapse").addEventListener("click", () => $("#sidebar").classList.remove("open"));
function isMobile() { return window.innerWidth < 700; }

boot();

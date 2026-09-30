// omp-gui session pool (v0.2.0)
// Keyed by GUI chat id: every chat owns exactly one `omp --mode rpc` process with
// a clean context. Chats never share a process; reconnecting to a live chat
// re-attaches, reopening a stored chat spawns a fresh process that switches to
// the stored session file. cwd is always the project's launch folder.
"use strict";
const path = require("node:path");
const config = require("./config");
const projects = require("./projects");
const { RpcSession } = require("./rpc");

const sessions = new Map(); // chatId -> RpcSession
const notifySubs = new Set();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const events = []; // ring buffer for the bell after a reload
function recentEvents(limit = 50) { return events.slice(-limit); }

function subscribe(ws) { notifySubs.add(ws); }
function unsubscribe(ws) { notifySubs.delete(ws); }
function notify(payload) {
  const rec = { ...payload, at: Date.now() };
  events.push(rec);
  if (events.length > 200) events.shift();
  const s = JSON.stringify({ t: "notify", ...rec });
  for (const ws of notifySubs) if (ws.readyState === 1) ws.send(s);
}

function get(chatId) { return sessions.get(chatId) || null; }
function countForProject(projectId) { return [...sessions.values()].filter((s) => s.project.id === projectId).length; }
function all() { return [...sessions.values()]; }

// opts: {chatId, project, kind, approval, resumeFile, model, thinking}
function open(opts) {
  const { chatId, project, kind = "work", approval = "write", resumeFile = null, model = null, thinking = null } = opts;
  const live = sessions.get(chatId);
  if (live && !live.dead) return { session: live, reused: true };
  if (sessions.size >= config.MAX_SESSIONS) return { error: `max ${config.MAX_SESSIONS} concurrent agent sessions` };
  const sessionDir = projects.sessionDir(project);
  const s = new RpcSession({
    id: chatId,
    chatId,
    project,
    sessionDir,
    cwd: project.path, // project folder = where omp launches from
    kind,
    approval,
    resumeFile: resumeFile ? path.join(sessionDir, resumeFile) : null,
    model,
    thinking,
    log,
    onFrame: (sess, frame) => { if (frame.type === "response" && frame.command === "get_available_models" && frame.success) cachedModels = frame.data; },
    onNotify: (n) => notify(n),
  });
  s.onExit = () => sessions.delete(chatId);
  sessions.set(chatId, s);
  return { session: s, reused: false };
}

let cachedModels = null;
function modelsCache() { return cachedModels; }

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.clients.size === 0 && now - s.lastActivity > config.IDLE_KILL_MS) {
      log(`idle-kill ${id}`);
      s.dispose();
      sessions.delete(id);
    }
  }
}, 60e3);

module.exports = { open, get, all, countForProject, subscribe, unsubscribe, notify, recentEvents, modelsCache, sessions };

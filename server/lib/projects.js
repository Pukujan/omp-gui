// omp-gui projects/pins/recents store (v0.2.0)
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("./config");

const PFILE = path.join(config.DATA_DIR, "projects.json");
const KFILE = path.join(config.DATA_DIR, "pins.json");

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "p";
}
function read(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; } }
function write(f, v) { fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

const loadProjects = () => read(PFILE);
const saveProjects = (l) => write(PFILE, l);
function addProject(name, p) {
  const list = loadProjects();
  if (list.some((x) => x.name === name)) return { error: "project name exists" };
  const pr = { id: crypto.randomUUID(), name, path: path.resolve(p), added: Date.now() };
  list.push(pr);
  saveProjects(list);
  return { project: pr };
}
function removeProject(id) {
  const list = loadProjects();
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return { error: "no such project" };
  saveProjects(next);
  return { ok: true };
}
function findProject(q) {
  return loadProjects().find((x) => x.id === q || x.name === q) || null;
}
function sessionDir(pr) {
  const d = path.join(config.DATA_DIR, "projects", slug(pr.name), "sessions");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// session jsonl -> {file,title,mtime,size,project}
function sessionTitle(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "title" && e.title) return String(e.title).slice(0, 80);
      } catch {}
    }
  } catch {}
  return null;
}
function listSessions(pr, limit = 50) {
  const dir = sessionDir(pr);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  return files
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, title: sessionTitle(path.join(dir, f)), mtime: st.mtimeMs, size: st.size, project: pr.name, projectId: pr.id };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}
function recent(limit = 40) {
  return loadProjects()
    .flatMap((pr) => listSessions(pr, 10))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}
function search(q) {
  const needle = String(q || "").toLowerCase();
  if (!needle) return [];
  const hits = [];
  for (const pr of loadProjects()) {
    for (const s of listSessions(pr, 100)) {
      const full = path.join(sessionDir(pr), s.file);
      let score = 0;
      if ((s.title || "").toLowerCase().includes(needle)) score += 5;
      try {
        const txt = fs.readFileSync(full, "utf8").toLowerCase();
        if (txt.includes(needle)) score += 1 + Math.min(3, txt.split(needle).length - 2) / 10;
      } catch {}
      if (score) hits.push({ ...s, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime).slice(0, 30);
}
// pins: {projects:[name], chats:[file]}
function loadPins() { try { return JSON.parse(fs.readFileSync(KFILE, "utf8")); } catch { return { projects: [], chats: [] }; } }
function savePins(p) { write(KFILE, p); }
function togglePin(kind, key) {
  const p = loadPins();
  const arr = kind === "project" ? p.projects : p.chats;
  const i = arr.indexOf(key);
  if (i >= 0) arr.splice(i, 1); else arr.push(key);
  savePins(p);
  return p;
}

module.exports = { slug, loadProjects, saveProjects, addProject, removeProject, findProject, sessionDir, listSessions, recent, search, loadPins, togglePin };

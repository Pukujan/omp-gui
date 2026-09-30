// omp-gui RPC client module (v0.2.0)
// One `omp --mode rpc` child per GUI chat. Protocol v2 negotiation + rpc_chunk
// reassembly (omp://rpc.md §Transport and Framing): v1 truncates oversized
// payloads (get_available_models is ~2.1 MB > 1 MiB maxFrameBytes).
"use strict";
const { spawn } = require("node:child_process");
const config = require("./config");
const { ChunkAssembler, DEFAULT_MAX_REASSEMBLED } = require("./frames");

class RpcSession {
  constructor({ id, chatId, project, sessionDir, cwd, kind = "work", approval = "write", resumeFile = null, model = null, thinking = null, fetchModels = false, onFrame = null, onNotify = null, log = console.log }) {
    this.id = id;
    this.chatId = chatId;
    this.project = project;
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.kind = kind;
    this.approval = approval;
    this.resumeFile = resumeFile;
    this.fetchModels = !!fetchModels;
    this.proc = null;
    this.ready = false;
    this.protocol = 1;
    this.buf = "";
    this.assembler = new ChunkAssembler({ maxReassembledBytes: DEFAULT_MAX_REASSEMBLED });
    this.buffer = [];
    this.bufferBytes = 0;
    this.clients = new Set();
    this.reqSeq = 0;
    this.lastActivity = Date.now();
    this.pendingUi = new Map();
    this.models = null; // last get_available_models payload (cached for the picker)
    this.onFrame = onFrame;
    this.onNotify = onNotify;
    this.log = log;
    this.state = { streaming: false, model: null, thinkingLevel: null, sessionFile: null, sessionId: null, todos: [], title: null };
    this.binIndex = 0;
    this.bin = config.OMP_CANDIDATES[0];
    this.spawn();
  }

  spawnArgs() {
    const a = ["--mode", "rpc", "--cwd", this.cwd, "--session-dir", this.sessionDir, "--no-title"];
    if (this.kind === "chat") a.push("--no-tools");
    if (this.approval) a.push("--approval-mode", this.approval);
    if (this.model) a.push("--model", this.model);
    if (this.thinking) a.push("--thinking", this.thinking);
    return a;
  }

  spawn() {
    const args = this.spawnArgs();
    this.log(`spawn ${this.bin} ${args.join(" ")} (chat ${this.chatId} kind=${this.kind})`);
    this.proc = spawn(this.bin, args, { cwd: this.cwd, env: process.env, shell: false, windowsHide: true });
    this.proc.stdout.on("data", (d) => this.onStdout(d));
    this.proc.stderr.on("data", (d) => {
      const s = String(d);
      if (/\S/.test(s)) this.log(`[omp ${this.chatId}] ${s.trim()}`);
    });
    this.proc.on("exit", (code) => {
      this.ready = false;
      this.dead = true;
      this.broadcast({ type: "server_event", event: "process_exit", code });
      for (const ws of this.clients) { try { ws.close(1011, "agent exited"); } catch {} }
      this.clients.clear();
      this.onNotify?.({ event: "process_exit", chatId: this.chatId, project: this.project.name, code });
      this.onExit?.(this);
    });
    this.proc.on("error", (e) => {
      // a missing binary is recoverable: try the next known install location
      if (e.code === "ENOENT" && !this.ready && this.binIndex < config.OMP_CANDIDATES.length - 1) {
        this.binIndex++;
        this.bin = config.OMP_CANDIDATES[this.binIndex];
        this.log(`omp not found at previous path, retrying: ${this.bin}`);
        setTimeout(() => { if (!this.dead && !this.ready) this.spawn(); }, 50);
        return;
      }
      this.broadcast({ type: "server_event", event: "spawn_error", error: String(e) });
      this.log(`spawn error ${this.chatId}: ${e}`);
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
      try { frame = JSON.parse(line); } catch { this.log(`bad frame from ${this.chatId}: ${line.slice(0, 120)}`); continue; }
      if (frame.type === "rpc_chunk") { this.onChunk(frame); continue; }
      this.dispatch(frame);
    }
  }

  onChunk(f) {
    const r = this.assembler.push(f);
    if (!r) return;
    if (r.error) {
      this.log(`frame transport error on ${this.chatId}: ${r.error}`);
      this.broadcast({ type: "server_event", event: "error", error: r.error });
      return;
    }
    this.dispatch(r.frame);
  }

  dispatch(f) {
    if (f.type === "ready") {
      this.ready = true;
      this.protocol = f.protocolVersion;
      const supported = f.supportedProtocolVersions || [1];
      if (supported.includes(2)) {
        this.send({ id: "protocol-1", type: "negotiate_protocol", protocolVersion: 2 });
      }
      if (this.resumeFile) this.rpc("switch_session", { sessionPath: this.resumeFile });
      else this.rpc("get_state");
      if (this.fetchModels) setTimeout(() => this.rpc("get_available_models"), 200);
    }
    this.trackState(f);
    this.remember(f);
    this.onFrame?.(this, f);
    this.broadcast(f);
  }

  trackState(f) {
    if (f.type === "agent_start") this.state.streaming = true;
    else if (f.type === "agent_end") this.state.streaming = f.isTerminal === false ? this.state.streaming : false;
    else if (f.type === "session_settled") this.state.streaming = false;
    else if (f.type === "response" && f.command === "get_state" && f.success && f.data) {
      const d = f.data;
      this.state.model = d.model ? `${d.model.provider}/${d.model.id}` : this.state.model;
      this.state.thinkingLevel = d.thinkingLevel || this.state.thinkingLevel;
      this.state.sessionFile = d.sessionFile || this.state.sessionFile;
      this.state.sessionId = d.sessionId || this.state.sessionId;
      this.state.title = d.sessionName || this.state.title;
    } else if (f.type === "response" && f.command === "get_available_models" && f.success) {
      this.models = f.data;
    } else if (f.type === "response" && f.command === "set_model" && f.success) {
      this.state.model = `${f.data?.provider ?? ""}/${f.data?.id ?? ""}`;
    } else if (f.type === "model_changed") {
      this.state.model = f.provider ? `${f.provider}/${f.model ?? f.id ?? ""}` : this.state.model;
    } else if (f.type === "session_info_update") {
      if (f.title || f.name) this.state.title = f.title || f.name;
    } else if (f.type === "config_update" && f.thinkingLevel) this.state.thinkingLevel = f.thinkingLevel;

    // notifications
    if (f.type === "extension_ui_request") {
      this.pendingUi.set(f.id, f);
      this.onNotify?.({ event: "input_required", chatId: this.chatId, project: this.project.name, frame: f });
    } else if (f.type === "extension_ui_response") {
      this.pendingUi.delete(f.id);
    } else if (f.type === "prompt_result") {
      this.onNotify?.({ event: "prompt_result", chatId: this.chatId, project: this.project.name, status: f.status, error: f.error });
    } else if (f.type === "session_settled") {
      this.onNotify?.({ event: "settled", chatId: this.chatId, project: this.project.name });
    } else if (f.type === "extension_error") {
      this.onNotify?.({ event: "error", chatId: this.chatId, project: this.project.name, error: f.error });
    }
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
    ws.send(JSON.stringify({ type: "server_event", event: "hello", chatId: this.chatId, project: this.project.name, kind: this.kind, approval: this.approval, protocol: this.protocol, ready: this.ready, state: this.state }));
    for (const s of this.buffer) if (ws.readyState === 1) ws.send(s);
    this.rpc("get_state");
  }

  dispose() {
    this.dead = true;
    try { this.proc?.kill(); } catch {}
  }
}

module.exports = { RpcSession };

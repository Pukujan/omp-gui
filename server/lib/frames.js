// omp-gui RPC frame transport (module: frames @ v0.2.0)
// Protocol v2 (omp://rpc.md §Transport and Framing): oversized stdout objects are
// emitted as an uninterrupted `rpc_chunk` sequence carrying base64 segments of one
// UTF-8 JSON object. v1 truncates at maxFrameBytes (1 MiB), which is why
// get_available_models (~2.1 MB) only works after negotiating v2.
"use strict";

const DEFAULT_MAX_REASSEMBLED = 64 * 1024 * 1024;

class ChunkAssembler {
  constructor({ maxReassembledBytes = DEFAULT_MAX_REASSEMBLED } = {}) {
    this.maxReassembledBytes = maxReassembledBytes;
    this.pending = new Map();
  }
  // returns {frame} on completion, {error} on protocol violation, null while buffering
  push(f) {
    const { chunkId, index, count } = f;
    if (typeof chunkId !== "string" || !chunkId) return { error: "rpc_chunk missing chunkId" };
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
      return { error: `rpc_chunk invalid index/count (${index}/${count})` };
    }
    let e = this.pending.get(chunkId);
    if (!e) {
      if (index !== 0) return { error: `rpc_chunk sequence for ${chunkId} started at index ${index}` };
      e = { parts: new Array(count), count, byteLength: Number(f.byteLength) || 0, got: 0, bytes: 0 };
      this.pending.set(chunkId, e);
    }
    if (e.count !== count) {
      this.pending.delete(chunkId);
      return { error: `rpc_chunk count changed for ${chunkId}` };
    }
    if (e.parts[index] !== undefined) {
      this.pending.delete(chunkId);
      return { error: `rpc_chunk duplicate index ${index} for ${chunkId}` };
    }
    const buf = Buffer.from(String(f.data ?? ""), "base64");
    e.parts[index] = buf;
    e.bytes += buf.length;
    e.got++;
    if (e.bytes > this.maxReassembledBytes) {
      this.pending.delete(chunkId);
      return { error: `rpc_chunk reassembly exceeds ${this.maxReassembledBytes} bytes` };
    }
    if (e.got < e.count) return null;
    this.pending.delete(chunkId);
    const all = Buffer.concat(e.parts);
    if (e.byteLength && all.length !== e.byteLength) {
      return { error: `rpc_chunk byteLength mismatch for ${chunkId} (${all.length} != ${e.byteLength})` };
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(all);
    } catch {
      return { error: `rpc_chunk payload for ${chunkId} is not valid UTF-8` };
    }
    try {
      return { frame: JSON.parse(text) };
    } catch {
      return { error: `rpc_chunk payload for ${chunkId} is not one JSON object` };
    }
  }
  reset() { this.pending.clear(); }
}

// Split one JSON object into chunk frames (used by tests and any host that needs
// to exercise the lossless path).
function chunkFrame(obj, { chunkId = "rpc-1", size = 64 * 1024 } = {}) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  const parts = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return parts.map((p, index) => ({
    type: "rpc_chunk",
    chunkId,
    index,
    count: parts.length,
    byteLength: buf.length,
    data: p.toString("base64"),
  }));
}

module.exports = { ChunkAssembler, chunkFrame, DEFAULT_MAX_REASSEMBLED };

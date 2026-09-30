// omp-gui image module (v0.2.0): ckff image generation + attachment storage.
// The GUI's image button and any tool-generated image land in DATA_DIR/images and
// are served from /api/images/<file>. Provider config comes from .env
// (ckff-image-url / ckff-cortex-image-generation / ...-model); nothing is
// hardcoded and no secret is ever sent to the browser.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("./config");

const DIR = path.join(config.DATA_DIR, "images");
fs.mkdirSync(DIR, { recursive: true });

// The configured value may be a base (`https://host/v1`) or the full endpoint
// (`https://host/v1/images/generations`). Normalize to the full endpoint.
function endpoint() {
  let u = String(config.CKFF_IMAGE_URL || "").replace(/\/+$/, "");
  if (!u) return "";
  if (/\/images\/generations$/.test(u)) return u;
  if (!/\/v\d+$/.test(u)) u += "/v1";
  return `${u}/images/generations`;
}

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF") return "webp";
  return "png";
}
function saveB64(b64) {
  const buf = Buffer.from(b64, "base64");
  const file = `${crypto.randomUUID()}.${sniff(buf)}`;
  fs.writeFileSync(path.join(DIR, file), buf);
  return file;
}
async function saveUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`image download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const ext = (r.headers.get("content-type") || "").includes("jpeg") ? "jpg" : "png";
  const file = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(DIR, file), buf);
  return file;
}

const configured = () => Boolean(endpoint() && config.CKFF_IMAGE_TOKEN);

// The provider groups quota per model: a model can be out of quota (429) or have
// no channel (503) while another image model on the same key works. Try the
// requested/configured model first, then the documented fallbacks, and report
// which one actually served the image.
async function tryModel(model, prompt, size, quality) {
  const body = { model, prompt, size, n: 1 };
  if (quality) body.quality = quality;
  let res;
  try {
    res = await fetch(endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.CKFF_IMAGE_TOKEN}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { error: `provider unreachable: ${e.message}`, retryable: true };
  }
  const text = await res.text();
  if (!res.ok) return { error: `provider ${res.status}: ${text.slice(0, 240)}`, status: res.status, retryable: res.status === 429 || res.status === 503 };
  let data;
  try { data = JSON.parse(text); } catch { return { error: `provider returned non-json: ${text.slice(0, 200)}` }; }
  const item = (data.data || data.images || [])[0];
  if (!item) return { error: "provider returned no image" };
  let file;
  if (item.b64_json || item.b64) file = saveB64(item.b64_json || item.b64);
  else if (item.url) file = await saveUrl(item.url);
  else return { error: "provider returned no b64_json or url" };
  return { file, model };
}

// {prompt, size?, model?, quality?} -> {file, url, model, size, fallback?}
async function generate({ prompt, size = "1024x1024", model, quality } = {}) {
  const p = String(prompt || "").trim();
  if (!p) return { error: "prompt required" };
  if (!configured()) return { error: "image provider not configured (ckff-image-url / ckff-cortex-image-generation)" };
  const primary = model || config.CKFF_IMAGE_MODEL;
  const fallbacks = String(process.env.CKFF_IMAGE_FALLBACKS || "gemini-3.1-flash-image").split(",").map((s) => s.trim()).filter(Boolean);
  const tried = [];
  for (const m of [primary, ...fallbacks.filter((f) => f !== primary)]) {
    const r = await tryModel(m, p, size, quality);
    if (!r.error) return { file: r.file, url: `/api/images/${r.file}`, model: r.model, size, prompt: p, ...(r.model === primary ? {} : { fallback: true, primaryError: tried[0]?.error }) };
    tried.push({ model: m, error: r.error });
    if (!r.retryable) break; // a real request error (bad prompt/size) must not fan out
  }
  return { error: tried.map((t) => `${t.model}: ${t.error}`).join(" | ").slice(0, 600), tried };
}

function listFiles() {
  return fs.readdirSync(DIR).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
}
function filePath(name) {
  const f = path.join(DIR, path.basename(String(name)));
  return fs.existsSync(f) ? f : null;
}
// data:image/png;base64,... -> {type:"image", data, mimeType} for RPC prompt.images
function toImageContent(dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return null;
  return { type: "image", data: m[2], mimeType: m[1] };
}

module.exports = { generate, listFiles, filePath, toImageContent, configured, endpoint, DIR };

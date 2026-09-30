// omp-gui auth module (v0.2.0): scrypt+pepper passwords, HMAC cookies, login rate limit.
"use strict";
const crypto = require("node:crypto");
const config = require("./config");

const passHash = config.PASS ? crypto.scryptSync(config.PASS, config.pepper, 64) : null;
const rate = new Map(); // ip -> {hits:[ts], lockUntil:ts}

function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim().slice(0, 64);
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  return (req.socket.remoteAddress || "?").replace(/^::ffff:/, "");
}
function lockRemainingMs(ip) {
  const e = rate.get(ip);
  if (!e || !e.lockUntil) return 0;
  return Date.now() < e.lockUntil ? e.lockUntil - Date.now() : 0;
}
function rateHit(ip) {
  const now = Date.now();
  let e = rate.get(ip);
  if (!e) { e = { hits: [], lockUntil: 0 }; rate.set(ip, e); }
  if (e.lockUntil && now < e.lockUntil) return true;
  e.hits = e.hits.filter((t) => now - t < config.RATE_WINDOW);
  if (e.hits.length >= config.RATE_MAX) { e.lockUntil = now + config.LOCKOUT_MS; e.hits = []; return true; }
  e.hits.push(now);
  return false;
}
function verifyPassword(pw) {
  if (!passHash || typeof pw !== "string") return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, config.pepper, 64), passHash);
}
function makeToken(sid) {
  const exp = Date.now() + config.SESSION_TTL_MS;
  const body = `${config.USER}.${exp}.${sid}`;
  const sig = crypto.createHmac("sha256", config.SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
const liveSids = new Set(); // rotation: issued sids; logout/re-auth invalidates old
function checkToken(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf(".");
  if (i < 0) return false;
  const body = tok.slice(0, i), sig = tok.slice(i + 1);
  const want = crypto.createHmac("sha256", config.SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const [user, exp, sid] = body.split(".");
  return user === config.USER && Number(exp) > Date.now() && liveSids.has(sid);
}
function newSid() { const s = crypto.randomUUID(); liveSids.add(s); return s; }
function dropSids() { liveSids.clear(); }
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

module.exports = { clientIp, lockRemainingMs, rateHit, verifyPassword, makeToken, newSid, dropSids, cookies, authed, secureFlag };

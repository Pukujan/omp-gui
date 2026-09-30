// omp-gui server config module (v0.2.0)
"use strict";
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..", "..");

function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnv();

const VERSION = require("../package.json").version;

const config = {
  VERSION,
  PORT: Number(process.env.OMP_GUI_PORT || 8790),
  HOST: process.env.OMP_GUI_HOST || "0.0.0.0",
  DATA_DIR: process.env.OMP_GUI_DATA || path.join(ROOT, "data"),
  WEB_DIR: path.join(ROOT, "web"),
  USER: process.env.OMP_GUI_USER || "admin",
  PASS: process.env.OMP_GUI_PASS_PLAINTEXT || "",
  SECRET:
    process.env.OMP_GUI_SESSION_SECRET && process.env.OMP_GUI_SESSION_SECRET !== "CHANGE_ME"
      ? process.env.OMP_GUI_SESSION_SECRET
      : crypto.randomBytes(32).toString("hex"),
  SESSION_TTL_MS: 30 * 24 * 3600e3,
  OMP_BIN: process.env.OMP_BIN || "omp",
  IDLE_KILL_MS: 30 * 60e3,
  MAX_SESSIONS: Number(process.env.OMP_GUI_MAX_SESSIONS || 8),
  IRE_ROOT: process.env.IRE_ROOT || "D:/claude/inference-recommendation-engine",
  CKFF_IMAGE_URL: process.env["ckff-image-url"] || process.env.CKFF_IMAGE_URL || "",
  CKFF_IMAGE_TOKEN: process.env["ckff-cortex-image-generation"] || process.env.CKFF_IMAGE_TOKEN || "",
  CKFF_IMAGE_MODEL: process.env["ckff-cortex-image-generation-model"] || process.env.CKFF_IMAGE_MODEL || "gpt-image-2.5",
  RATE_WINDOW: 60e3,
  RATE_MAX: 10,
  LOCKOUT_MS: 15 * 60e3,
};
// `omp` may not be on PATH (Linux installs to ~/.local/bin, Windows to
// %LOCALAPPDATA%\omp). Try the configured binary, then the known locations.
config.OMP_CANDIDATES = [
  config.OMP_BIN,
  "omp",
  path.join(os.homedir(), ".local", "bin", "omp"),
  "/usr/local/bin/omp",
  path.join(os.homedir(), "AppData", "Local", "omp", "omp.exe"),
  "C:\\Users\\pujan\\AppData\\Local\\omp\\omp.exe",
].filter((v, i, a) => v && a.indexOf(v) === i);

config.PEPPER = path.join(config.DATA_DIR, "pepper.key");
fs.mkdirSync(config.DATA_DIR, { recursive: true });
if (!fs.existsSync(config.PEPPER)) fs.writeFileSync(config.PEPPER, crypto.randomBytes(32).toString("hex"));
config.pepper = fs.readFileSync(config.PEPPER, "utf8").trim();

module.exports = config;

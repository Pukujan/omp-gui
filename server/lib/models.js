// omp-gui model ranking module (v0.2.0)
// Ranks the models omp reports (RPC get_available_models) with the local
// Inference Recommendation Engine (IRE_ROOT, default
// D:/claude/inference-recommendation-engine): price ladder, provider breadth,
// runtime evidence, deterministic policy -> ranked recommendations + gate
// reasons. Falls back to a local price/throughput ordering when the engine is
// unavailable (e.g. inside Docker), never to an empty list.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const config = require("./config");

let engine = null; // { rankCandidates, defaultPolicy, ENGINE_VERSION }
let enginePolicy = null;

async function loadEngine() {
  if (engine) return engine;
  const entry = path.join(config.IRE_ROOT, "src", "index.mjs");
  if (!fs.existsSync(entry)) return null;
  try {
    const mod = await import(pathToFileURL(entry).href);
    engine = mod;
    const p = path.join(config.IRE_ROOT, "policy.example.json");
    enginePolicy = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
    return engine;
  } catch (e) {
    console.error("ire load failed:", e.message);
    return null;
  }
}

// omp model entry -> IRE candidate
function normalizeId(m) {
  const raw = String(m.id || m.requestModelId || m.name || "").toLowerCase();
  const parts = raw.split("/");
  return parts[parts.length - 1].replace(/[-_.]?(latest|preview)$/g, "");
}
function toCandidate(m, breadth) {
  const input = Number(m.cost?.input);
  const output = Number(m.cost?.output);
  const key = normalizeId(m);
  const b = breadth.get(key) || { providers: new Set(), routes: 0 };
  const measured = Number.isFinite(Number(m.tps));
  return {
    id: `${m.provider}/${m.id || m.name}`,
    provider: m.provider,
    modelId: m.id,
    name: m.name,
    price: Number.isFinite(input) && Number.isFinite(output) ? { inputPerMillion: input, outputPerMillion: output } : undefined,
    discountPct: 0,
    providerCount: b.providers.size,
    routeCount: b.routes,
    vision: Array.isArray(m.input) && m.input.includes("image"),
    reasoning: !!m.reasoning,
    thinkingEfforts: m.thinking?.efforts || [],
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    intelligence: Number.isFinite(Number(m.int)) ? Number(m.int) : null,
    runtime: {
      public: measured
        ? { evidenceState: "measured", eligibleAttempts: 1, throughputTokensPerSecond: Number(m.tps) }
        : { evidenceState: "insufficient_evidence", eligibleAttempts: 0 },
    },
  };
}

function breadthIndex(models) {
  const map = new Map();
  for (const m of models) {
    const k = normalizeId(m);
    if (!k) continue;
    let e = map.get(k);
    if (!e) { e = { providers: new Set(), routes: 0 }; map.set(k, e); }
    e.providers.add(m.provider);
    e.routes++;
  }
  return map;
}

function fallbackRank(cands) {
  return cands
    .map((c) => {
      const p = c.price ? Math.sqrt(Math.max(c.price.inputPerMillion, 1e-6) * Math.max(c.price.outputPerMillion, 1e-6)) : Infinity;
      const nearFree = c.price && p <= 0.1;
      const reasons = [];
      if (!c.price) reasons.push("missing_price");
      if (c.providerCount < 2) reasons.push("insufficient_provider_breadth");
      if (c.runtime.public.evidenceState !== "measured") reasons.push("insufficient_runtime_evidence");
      const score = (nearFree ? 0.5 : 0) + (1 / (1 + Math.log1p(p / 0.01))) * 0.4 + Math.min(c.providerCount, 5) / 5 * 0.1;
      return { id: c.id, rank: 0, status: reasons.length ? "provisional" : "qualified", reasons, score, price: c.price || null, candidate: c };
    })
    .sort((a, b) => b.score - a.score || (a.price ? a.price.inputPerMillion : Infinity) - (b.price ? b.price.inputPerMillion : Infinity) || a.id.localeCompare(b.id))
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

// models: raw array from get_available_models. opts: {vision, free, reasoning, query, limit}
async function rank(models, opts = {}) {
  let cands = models.map((m) => toCandidate(m, breadthIndexCache(models)));
  if (opts.vision) cands = cands.filter((c) => c.vision);
  if (opts.reasoning) cands = cands.filter((c) => c.reasoning);
  if (opts.free) cands = cands.filter((c) => c.price && c.price.inputPerMillion === 0 && c.price.outputPerMillion === 0);
  if (opts.query) {
    const q = String(opts.query).toLowerCase();
    cands = cands.filter((c) => c.id.toLowerCase().includes(q) || String(c.name || "").toLowerCase().includes(q));
  }
  const mod = await loadEngine();
  let ranked, engineVersion = "fallback";
  if (mod?.rankCandidates) {
    try {
      ranked = mod.rankCandidates(cands, enginePolicy || {}, "public");
      engineVersion = mod.ENGINE_VERSION || "unknown";
    } catch (e) {
      console.error("ire rank failed, falling back:", e.message);
      ranked = fallbackRank(cands);
    }
  } else {
    ranked = fallbackRank(cands);
  }
  const byId = new Map(cands.map((c) => [c.id, c]));
  const out = ranked.map((r) => {
    const c = byId.get(r.id) || {};
    return {
      rank: r.rank,
      id: r.id,
      provider: c.provider,
      modelId: c.modelId,
      name: c.name,
      status: r.status,
      reasons: r.reasons || [],
      score: r.score,
      price: c.price || null,
      vision: !!c.vision,
      reasoning: !!c.reasoning,
      thinkingEfforts: c.thinkingEfforts || [],
      contextWindow: c.contextWindow ?? null,
      maxTokens: c.maxTokens ?? null,
      intelligence: c.intelligence ?? null,
      providerCount: c.providerCount ?? 1,
      throughput: c.runtime?.public?.throughputTokensPerSecond ?? null,
    };
  });
  return { engineVersion, count: out.length, models: opts.limit ? out.slice(0, opts.limit) : out };
}

// breadth index is recomputed per call but memoized by model-list identity
let lastListRef = null, lastIndex = null;
function breadthIndexCache(models) {
  if (lastListRef === models && lastIndex) return lastIndex;
  lastListRef = models;
  lastIndex = breadthIndex(models);
  return lastIndex;
}

module.exports = { rank, loadEngine, normalizeId, toCandidate, breadthIndex, fallbackRank };

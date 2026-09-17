#!/usr/bin/env node
/**
 * Chat Translator spending report.
 *
 *   node report.mjs              — current month
 *   node report.mjs 2026-08      — a specific month
 *   node report.mjs all          — all time
 *   node report.mjs 2026-08 --days   — plus a per-day breakdown
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const wantDays = args.includes("--days");
const periodArg = args.find((a) => !a.startsWith("--")) ?? new Date().toISOString().slice(0, 7);
const dataDir = process.env.CHAT_TRANSLATOR_DIR ?? join(homedir(), ".openclaw", "chat-translator");
const usageFile = join(dataDir, "usage.jsonl");

const money = (v) => `$${v.toFixed(v < 1 ? 4 : 2)}`;
const pad = (v, n) => String(v).padEnd(n);
const padL = (v, n) => String(v).padStart(n);

let raw;
try {
  raw = await readFile(usageFile, "utf8");
} catch {
  console.log(`No usage records yet (${usageFile})`);
  process.exit(0);
}

const rows = raw
  .split("\n")
  .filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean)
  .filter((r) => periodArg === "all" || String(r.ts).startsWith(periodArg));

if (rows.length === 0) {
  console.log(`No records for ${periodArg}.`);
  process.exit(0);
}

const KIND_LABEL = { translate: "text translation", stt: "voice transcription", image: "image reading" };

const byKind = new Map();
const byModel = new Map();
const byDay = new Map();
let knownCost = 0;
let unpriced = 0;

for (const r of rows) {
  const kind = r.kind ?? "other";
  const k = byKind.get(kind) ?? { calls: 0, inTok: 0, outTok: 0, cost: 0, unpriced: 0 };
  k.calls += 1;
  k.inTok += r.inputTokens ?? 0;
  k.outTok += r.outputTokens ?? 0;
  if (typeof r.costUsd === "number") k.cost += r.costUsd; else k.unpriced += 1;
  byKind.set(kind, k);

  const model = r.model ?? "(unspecified)";
  const m = byModel.get(model) ?? { calls: 0, cost: 0, unpriced: 0 };
  m.calls += 1;
  if (typeof r.costUsd === "number") m.cost += r.costUsd; else m.unpriced += 1;
  byModel.set(model, m);

  const day = String(r.ts).slice(0, 10);
  const d = byDay.get(day) ?? { calls: 0, cost: 0 };
  d.calls += 1;
  d.cost += r.costUsd ?? 0;
  byDay.set(day, d);

  if (typeof r.costUsd === "number") knownCost += r.costUsd; else unpriced += 1;
}

const period = periodArg === "all" ? "all time" : periodArg;
console.log(`\nChat Translator — spending, ${period}\n`);

console.log(pad("What", 22) + padL("Calls", 9) + padL("Tokens in", 13) + padL("Tokens out", 13) + padL("Cost", 12));
console.log("-".repeat(69));
for (const [kind, v] of [...byKind].sort((a, b) => b[1].cost - a[1].cost)) {
  console.log(
    pad(KIND_LABEL[kind] ?? kind, 22) +
    padL(v.calls, 9) +
    padL(v.inTok || "—", 13) +
    padL(v.outTok || "—", 13) +
    padL(v.cost > 0 ? money(v.cost) : (v.unpriced ? "subscription" : "—"), 12)
  );
}

console.log("\n" + pad("Model", 40) + padL("Calls", 9) + padL("Cost", 12));
console.log("-".repeat(61));
for (const [model, v] of [...byModel].sort((a, b) => b[1].cost - a[1].cost)) {
  console.log(pad(model.slice(0, 39), 40) + padL(v.calls, 9) + padL(v.cost > 0 ? money(v.cost) : "subscription", 12));
}

if (wantDays) {
  console.log("\n" + pad("Day", 14) + padL("Calls", 9) + padL("Cost", 12));
  console.log("-".repeat(35));
  for (const [day, v] of [...byDay].sort()) {
    console.log(pad(day, 14) + padL(v.calls, 9) + padL(v.cost > 0 ? money(v.cost) : "—", 12));
  }
}

console.log("\n" + "=".repeat(45));
console.log(`TOTAL for ${period}: ${money(knownCost)}`);
if (unpriced > 0) {
  console.log(`Plus ${unpriced} call(s) with no price — those are OpenAI on the subscription;`);
  console.log(`their exact amount is only visible in the OpenAI dashboard.`);
}
const days = new Set([...byDay.keys()]).size;
if (days > 1 && knownCost > 0) {
  console.log(`Average ${money(knownCost / days)} per day · 30-day projection ${money((knownCost / days) * 30)}`);
}
console.log();

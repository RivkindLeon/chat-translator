#!/usr/bin/env node
/**
 * Отчёт о расходах Hebrew Bridge.
 *
 *   node report.mjs              — текущий месяц
 *   node report.mjs 2026-08      — конкретный месяц
 *   node report.mjs all          — за всё время
 *   node report.mjs 2026-08 --days   — ещё и разбивка по дням
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const wantDays = args.includes("--days");
const periodArg = args.find((a) => !a.startsWith("--")) ?? new Date().toISOString().slice(0, 7);
const dataDir = process.env.HEBREW_BRIDGE_DIR ?? join(homedir(), ".openclaw", "hebrew-bridge");
const usageFile = join(dataDir, "usage.jsonl");

const money = (v) => `$${v.toFixed(v < 1 ? 4 : 2)}`;
const pad = (v, n) => String(v).padEnd(n);
const padL = (v, n) => String(v).padStart(n);

let raw;
try {
  raw = await readFile(usageFile, "utf8");
} catch {
  console.log(`Записей о расходах пока нет (${usageFile})`);
  process.exit(0);
}

const rows = raw
  .split("\n")
  .filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean)
  .filter((r) => periodArg === "all" || String(r.ts).startsWith(periodArg));

if (rows.length === 0) {
  console.log(`За период ${periodArg} записей нет.`);
  process.exit(0);
}

const KIND_LABEL = { translate: "перевод текста", stt: "расшифровка голоса", image: "чтение картинок" };

const byKind = new Map();
const byModel = new Map();
const byDay = new Map();
let knownCost = 0;
let unpriced = 0;

for (const r of rows) {
  const kind = r.kind ?? "прочее";
  const k = byKind.get(kind) ?? { calls: 0, inTok: 0, outTok: 0, cost: 0, unpriced: 0 };
  k.calls += 1;
  k.inTok += r.inputTokens ?? 0;
  k.outTok += r.outputTokens ?? 0;
  if (typeof r.costUsd === "number") k.cost += r.costUsd; else k.unpriced += 1;
  byKind.set(kind, k);

  const model = r.model ?? "(не указана)";
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

const period = periodArg === "all" ? "за всё время" : periodArg;
console.log(`\nHebrew Bridge — расходы, ${period}\n`);

console.log(pad("Что", 22) + padL("Вызовов", 9) + padL("Токенов вх.", 13) + padL("Токенов исх.", 13) + padL("Стоимость", 12));
console.log("-".repeat(69));
for (const [kind, v] of [...byKind].sort((a, b) => b[1].cost - a[1].cost)) {
  console.log(
    pad(KIND_LABEL[kind] ?? kind, 22) +
    padL(v.calls, 9) +
    padL(v.inTok || "—", 13) +
    padL(v.outTok || "—", 13) +
    padL(v.cost > 0 ? money(v.cost) : (v.unpriced ? "по подписке" : "—"), 12)
  );
}

console.log("\n" + pad("Модель", 40) + padL("Вызовов", 9) + padL("Стоимость", 12));
console.log("-".repeat(61));
for (const [model, v] of [...byModel].sort((a, b) => b[1].cost - a[1].cost)) {
  console.log(pad(model.slice(0, 39), 40) + padL(v.calls, 9) + padL(v.cost > 0 ? money(v.cost) : "по подписке", 12));
}

if (wantDays) {
  console.log("\n" + pad("День", 14) + padL("Вызовов", 9) + padL("Стоимость", 12));
  console.log("-".repeat(35));
  for (const [day, v] of [...byDay].sort()) {
    console.log(pad(day, 14) + padL(v.calls, 9) + padL(v.cost > 0 ? money(v.cost) : "—", 12));
  }
}

console.log("\n" + "=".repeat(45));
console.log(`ИТОГО за ${period}: ${money(knownCost)}`);
if (unpriced > 0) {
  console.log(`Плюс ${unpriced} вызов(ов) без цены — это OpenAI по подписке;`);
  console.log(`точная сумма по ним видна только в кабинете OpenAI.`);
}
const days = new Set([...byDay.keys()]).size;
if (days > 1 && knownCost > 0) {
  console.log(`В среднем ${money(knownCost / days)} в день · прогноз на 30 дней ${money((knownCost / days) * 30)}`);
}
console.log();

#!/usr/bin/env node
/**
 * Остаток квоты подписки и состояние моделей.
 *
 *   node limits.mjs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const cli = join(homedir(), "npm-global", "bin", "openclaw");

let out = "";
try {
  const res = await run(cli, ["models", "status"], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  out = res.stdout ?? "";
} catch (err) {
  console.error(`Не удалось получить статус: ${err?.message ?? err}`);
  process.exit(1);
}

const pick = (re) => (out.match(re) ?? [])[1]?.trim();

const primary = pick(/^Default\s*:\s*(.+)$/m);
const fallbacks = pick(/^Fallbacks \(\d+\)\s*:\s*(.+)$/m);

console.log("\nМодели\n" + "-".repeat(60));
console.log(`  основная : ${primary ?? "—"}`);
console.log(`  запасные : ${fallbacks ?? "—"}`);

console.log("\nКвота подписки\n" + "-".repeat(60));
const quotaLines = out.split("\n").filter((l) => /usage:/i.test(l));
if (quotaLines.length === 0) {
  console.log("  данных о квоте нет (провайдер их не сообщает)");
} else {
  for (const line of quotaLines) {
    const provider = (line.match(/-\s*(\w+)\s+usage:/) ?? [])[1] ?? "провайдер";
    const windows = [...line.matchAll(/([\w\s]{1,12}?)\s(\d{1,3})%\s*left(?:\s*⏱\s*([^·\n]+))?/g)];
    console.log(`  ${provider}:`);
    for (const w of windows) {
      const name = w[1].trim();
      const left = Number(w[2]);
      const resets = (w[3] ?? "").trim();
      const bar = "█".repeat(Math.round(left / 5)).padEnd(20, "░");
      const mark = left <= 20 ? "  ⚠️ мало" : "";
      console.log(`    ${name.padEnd(6)} ${bar} ${String(left).padStart(3)}%${resets ? `  сброс через ${resets}` : ""}${mark}`);
    }
  }
}

const expiring = out.match(/expiring expires in ([^\n]+)/);
if (expiring) console.log(`\n  ⚠️ токен доступа истекает через ${expiring[1].trim()}`);

const sessionModel = out.match(/Session selected:\s*(.+)/);
if (sessionModel) {
  const reason = (out.match(/Reason:\s*(.+)/) ?? [])[1] ?? "";
  console.log(`\nТекущая сессия: ${sessionModel[1].trim()}${reason ? ` (${reason.trim()})` : ""}`);
}
console.log();

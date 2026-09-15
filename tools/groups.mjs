#!/usr/bin/env node
/**
 * Какие беседы видел сервер.
 *
 * Мессенджер не сообщает названия групп, только идентификаторы, поэтому
 * опознавать их приходится по обрывкам сообщений. Сведения берутся из реестра,
 * который плагин копит сам — журнал шлюза живёт лишь пару суток.
 *
 *   node tools/groups.mjs
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG = join(homedir(), ".openclaw", "openclaw.json");

let cfg = {};
try {
  cfg = JSON.parse(await readFile(CONFIG, "utf8"));
} catch { /* конфиг может быть недоступен */ }

const pluginCfg = cfg?.plugins?.entries?.["hebrew-bridge"]?.config ?? {};
const dataDir = pluginCfg.dataDir ?? join(homedir(), ".openclaw", "hebrew-bridge");

const connected = new Map();
for (const r of pluginCfg.routes ?? []) if (r?.jid) connected.set(r.jid, r.name ?? "подключена");

let registry = {};
try {
  registry = JSON.parse(await readFile(join(dataDir, "groups-seen.json"), "utf8"));
} catch {
  console.log(`Реестр пока пуст (${join(dataDir, "groups-seen.json")}).`);
  console.log("Плагин обходит журнал раз в час — загляните позже.\n");
}

const rows = Object.entries(registry)
  .map(([jid, info]) => ({ jid, ...info }))
  .sort((a, b) => String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")));

if (rows.length === 0) process.exit(0);

const pad = (v, n) => String(v).padEnd(n);
const padL = (v, n) => String(v).padStart(n);

console.log(`\nБеседы, которые видел сервер (${rows.length})\n`);
console.log("  " + pad("Идентификатор", 32) + pad("состояние", 16) + padL("сообщ.", 7) + "  " + pad("последнее", 17) + "образцы");
console.log("  " + "-".repeat(104));

for (const r of rows) {
  const status = connected.has(r.jid) ? `✓ ${connected.get(r.jid)}`.slice(0, 15) : "—";
  const when = String(r.lastSeen ?? "").replace("T", " ").slice(0, 16) || "—";
  const sample = (r.samples ?? []).join(" · ").slice(0, 44) || "(только служебные записи)";
  console.log("  " + pad(r.jid, 32) + pad(status, 16) + padL(r.count ?? 0, 7) + "  " + pad(when, 17) + sample);
}

console.log(`
Подключить беседу:
  node tools/add-group.mjs <идентификатор> "Название" <адрес доставки>

Реестр пополняется сам. Если нужной беседы нет — в ней не было сообщений
с тех пор, как плагин начал наблюдение.
`);

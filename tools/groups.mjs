#!/usr/bin/env node
/**
 * Какие WhatsApp-группы видел сервер.
 * WhatsApp не сообщает названия групп, поэтому опознавать их приходится
 * по обрывкам сообщений — они показаны в последней колонке.
 *
 *   node groups.mjs
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = "/tmp/openclaw";
const CONFIG = join(homedir(), ".openclaw", "openclaw.json");

let known = new Set();
let routeNames = new Map();
try {
  const cfg = JSON.parse(await readFile(CONFIG, "utf8"));
  known = new Set(Object.keys(cfg?.channels?.whatsapp?.groups ?? {}));
  for (const r of cfg?.plugins?.entries?.["hebrew-bridge"]?.config?.routes ?? []) {
    if (r?.jid) routeNames.set(r.jid, r.name ?? "");
  }
} catch { /* конфиг может быть недоступен */ }

let files = [];
try {
  files = (await readdir(LOG_DIR)).filter((f) => f.startsWith("openclaw-")).sort();
} catch {
  console.error(`Логи не найдены в ${LOG_DIR}`);
  process.exit(1);
}

const groups = new Map();
for (const file of files) {
  let text = "";
  try { text = await readFile(join(LOG_DIR, file), "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    const jid = (line.match(/[0-9]{10,25}(?:-[0-9]+)?@g\.us/) ?? [])[0];
    if (!jid) continue;
    const g = groups.get(jid) ?? { count: 0, last: "", samples: [] };
    g.count += 1;
    const ts = (line.match(/"time":"([^"]+)"/) ?? [])[1];
    if (ts && ts > g.last) g.last = ts;
    let body = (line.match(/"body"\s*:\s*"((?:[^"\\]|\\.){3,80})"/) ?? [])[1];
    if (body) {
      body = body.replace(/\\n/g, " ").replace(/\\"/g, '"').trim();
      const asMedia = /^<media:(\w+)>$/.exec(body);
      if (asMedia) body = { image: "(фото)", audio: "(голосовое)", video: "(видео)", document: "(файл)" }[asMedia[1]] ?? "(вложение)";
      if (g.samples.length < 3 && !g.samples.includes(body)) g.samples.push(body);
    }
    groups.set(jid, g);
  }
}

if (groups.size === 0) {
  console.log("В логах не нашлось ни одной группы.");
  console.log("Возможно, лог только что обнулился — он живёт в /tmp.");
  process.exit(0);
}

const rows = [...groups].sort((a, b) => b[1].count - a[1].count);
console.log(`\nГруппы, замеченные в логах (${rows.length})\n`);
console.log("  " + "JID".padEnd(32) + "статус".padEnd(14) + "сообщ.".padStart(7) + "  последнее   образцы");
console.log("  " + "-".repeat(100));
for (const [jid, g] of rows) {
  const status = routeNames.has(jid)
    ? `✓ ${routeNames.get(jid) || "подключена"}`.slice(0, 13)
    : known.has(jid) ? "в канале" : "—";
  const when = g.last ? g.last.slice(11, 16) : "—";
  const sample = g.samples.join(" · ").slice(0, 46) || "(только служебные записи)";
  console.log("  " + jid.padEnd(32) + status.padEnd(14) + String(g.count).padStart(7) + "  " + when.padEnd(11) + sample);
}
console.log(`
Подключить группу:
  node add-group.mjs <JID> "Название" [chatId] [threadId]

Если нужной группы в списке нет — значит в ней не было сообщений с момента
последнего перезапуска сервера. Напишите в неё что-нибудь и повторите.
`);

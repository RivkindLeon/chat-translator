#!/usr/bin/env node
/**
 * Подключить WhatsApp-группу к переводчику одной командой.
 *
 *   node add-group.mjs <JID> "Название" [chatId] [threadId]
 *
 * Прописывает группу и в настройки канала, и в маршруты плагина,
 * затем перезапускает сервис. Без chatId переводы идут туда же,
 * куда и у остальных групп.
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";

const run = promisify(execFile);
const [jid, name, chatId, threadId] = process.argv.slice(2);

if (!jid || !/@g\.us$/.test(jid)) {
  console.error(`
Укажите JID группы. Посмотреть доступные:  node groups.mjs

  node add-group.mjs 120363000000000000@g.us "Дом" -1001234567890
`);
  process.exit(1);
}

const CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const cfg = JSON.parse(await readFile(CONFIG, "utf8"));

const backup = `${CONFIG}.before-add-group`;
await copyFile(CONFIG, backup);

// 1) канал должен пропускать сообщения этой группы
cfg.channels ??= {};
cfg.channels.whatsapp ??= {};
cfg.channels.whatsapp.groups ??= {};
cfg.channels.whatsapp.groups[jid] = { requireMention: false };

// 2) маршрут плагина
const entry = (cfg.plugins ??= {}).entries?.["hebrew-bridge"] ?? {};
cfg.plugins.entries ??= {};
cfg.plugins.entries["hebrew-bridge"] = entry;
entry.config ??= {};

// переводим старый формат настроек в маршруты, если он ещё используется
if (!Array.isArray(entry.config.routes)) {
  const legacy = [
    ...(entry.config.groupJid ? [entry.config.groupJid] : []),
    ...(entry.config.groupJids ?? []),
  ];
  entry.config.routes = legacy.map((j, i) => ({
    jid: j,
    name: i === 0 ? "основная" : `группа ${i + 1}`,
    chatId: entry.config.telegramChatId,
  }));
}

if (entry.config.routes.some((r) => r.jid === jid)) {
  console.log(`Группа ${jid} уже подключена — ничего не меняю.`);
  process.exit(0);
}

entry.config.routes.push({
  jid,
  name: name || jid.slice(0, 8),
  ...(chatId ? { chatId } : {}),
  ...(threadId ? { threadId } : {}),
});

await writeFile(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
console.log(`Добавлено: ${name || jid}`);
console.log(`  доставка: ${chatId ?? entry.config.telegramChatId ?? "(общая)"}${threadId ? ` · тема ${threadId}` : ""}`);
console.log(`  резервная копия конфига: ${backup}`);

console.log("\nПерезапускаю сервис…");
try {
  await run("systemctl", ["--user", "reset-failed", "openclaw-gateway"]).catch(() => {});
  await run("systemctl", ["--user", "restart", "openclaw-gateway"]);
} catch (err) {
  console.error(`Не удалось перезапустить: ${err?.message ?? err}`);
  console.error(`Верните конфиг из ${backup}, если что-то пошло не так.`);
  process.exit(1);
}

console.log("Готово. Проверьте через полминуты:");
console.log("  tail -3 ~/.openclaw/hebrew-bridge/logs/$(date -u +%F).log");

#!/usr/bin/env node
/**
 * Connect a WhatsApp group to the translator in one command.
 *
 *   node add-group.mjs <JID> "Name" [chatId] [threadId]
 *
 * Writes the group into both the channel settings and the plugin routes,
 * then restarts the service. Without a chatId the translations go wherever
 * the other groups go.
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
Pass the group JID. To list the ones already seen:  node groups.mjs

  node add-group.mjs 120363000000000000@g.us "Building" -1001234567890
`);
  process.exit(1);
}

const CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const cfg = JSON.parse(await readFile(CONFIG, "utf8"));

const backup = `${CONFIG}.before-add-group`;
await copyFile(CONFIG, backup);

// 1) the channel must let this group's messages through
cfg.channels ??= {};
cfg.channels.whatsapp ??= {};
cfg.channels.whatsapp.groups ??= {};
cfg.channels.whatsapp.groups[jid] = { requireMention: false };

// 2) the plugin route
const entry = (cfg.plugins ??= {}).entries?.["hebrew-bridge"] ?? {};
cfg.plugins.entries ??= {};
cfg.plugins.entries["hebrew-bridge"] = entry;
entry.config ??= {};

// migrate the legacy settings shape into routes if it is still in use
if (!Array.isArray(entry.config.routes)) {
  const legacy = [
    ...(entry.config.groupJid ? [entry.config.groupJid] : []),
    ...(entry.config.groupJids ?? []),
  ];
  entry.config.routes = legacy.map((j, i) => ({
    jid: j,
    name: i === 0 ? "main" : `group ${i + 1}`,
    chatId: entry.config.telegramChatId,
  }));
}

if (entry.config.routes.some((r) => r.jid === jid)) {
  console.log(`Group ${jid} is already connected — nothing to change.`);
  process.exit(0);
}

entry.config.routes.push({
  jid,
  name: name || jid.slice(0, 8),
  ...(chatId ? { chatId } : {}),
  ...(threadId ? { threadId } : {}),
});

await writeFile(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
console.log(`Added: ${name || jid}`);
console.log(`  delivery: ${chatId ?? entry.config.telegramChatId ?? "(shared)"}${threadId ? ` · thread ${threadId}` : ""}`);
console.log(`  config backup: ${backup}`);

console.log("\nRestarting the service…");
try {
  await run("systemctl", ["--user", "reset-failed", "openclaw-gateway"]).catch(() => {});
  await run("systemctl", ["--user", "restart", "openclaw-gateway"]);
} catch (err) {
  console.error(`Restart failed: ${err?.message ?? err}`);
  console.error(`Restore the config from ${backup} if something went wrong.`);
  process.exit(1);
}

console.log("Done. Check back in half a minute:");
console.log("  tail -3 ~/.openclaw/hebrew-bridge/logs/$(date -u +%F).log");

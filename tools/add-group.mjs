#!/usr/bin/env node
/**
 * Connect a chat to the translator in one command.
 *
 *   node add-group.mjs <conversation id> "Name" [address] [thread] [--source=…] [--delivery=…]
 *
 * Writes the chat into both the channel settings and the plugin routes, then
 * restarts the service. What a channel needs in order to pass its messages
 * through is the source adapter's business, so this tool asks the adapter
 * instead of knowing about any particular messenger itself.
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// The deploy puts this file both in tools/ and next to the plugin itself, so
// `src/` is either one level up or right here. Look for it rather than assume.
const here = dirname(fileURLToPath(import.meta.url));
const srcDir = [join(here, "..", "src"), join(here, "src")].find((d) => existsSync(join(d, "sources", "index.js")));
if (!srcDir) {
  console.error("Cannot find the plugin's src/ folder next to this script.");
  process.exit(1);
}
const { resolveSource, listSources } = await import(join(srcDir, "sources", "index.js"));
const { listDeliveries } = await import(join(srcDir, "delivery", "index.js"));

const run = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const positional = args.filter((a) => !a.startsWith("--"));
const [conversationId, name, chatId, threadId] = positional;

const sourceId = flag("source") ?? "whatsapp";
const deliveryId = flag("delivery") ?? "telegram";

const source = resolveSource(sourceId);
if (!source) {
  console.error(`Unknown source "${sourceId}". Available: ${listSources().join(", ")}`);
  process.exit(1);
}
if (!listDeliveries().includes(deliveryId)) {
  console.error(`Unknown delivery "${deliveryId}". Available: ${listDeliveries().join(", ")}`);
  process.exit(1);
}

if (!conversationId || (source.looksLikeConversationId && !source.looksLikeConversationId(conversationId))) {
  console.error(`
Pass the conversation id. To list the ones already seen:  node groups.mjs

  node add-group.mjs ${source.conversationIdExample ?? "<id>"} "Building" -1001234567890
  node add-group.mjs <id> "Building" <address> --source=${sourceId} --delivery=${deliveryId}
`);
  process.exit(1);
}

const CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const cfg = JSON.parse(await readFile(CONFIG, "utf8"));

const backup = `${CONFIG}.before-add-group`;
await copyFile(CONFIG, backup);

// 1) the channel must let this conversation's messages through — the adapter
//    knows what that means for its own messenger
if (typeof source.prepareChannel === "function") {
  source.prepareChannel(cfg, conversationId);
} else {
  console.warn(`Source "${sourceId}" cannot prepare its channel; do it by hand if messages do not arrive.`);
}

// 2) the plugin route
const entry = (cfg.plugins ??= {}).entries?.["chat-translator"] ?? {};
cfg.plugins.entries ??= {};
cfg.plugins.entries["chat-translator"] = entry;
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

if (entry.config.routes.some((r) => r.jid === conversationId)) {
  console.log(`${conversationId} is already connected — nothing to change.`);
  process.exit(0);
}

const defaultSource = entry.config.source ?? "whatsapp";
const defaultDelivery = entry.config.delivery ?? "telegram";

entry.config.routes.push({
  jid: conversationId,
  name: name || conversationId.slice(0, 8),
  ...(chatId ? { chatId } : {}),
  ...(threadId ? { threadId } : {}),
  // only write these down when they differ from what every other route uses
  ...(sourceId !== defaultSource ? { source: sourceId } : {}),
  ...(deliveryId !== defaultDelivery ? { delivery: deliveryId } : {}),
});

await writeFile(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
console.log(`Added: ${name || conversationId}`);
console.log(`  source: ${sourceId}  ·  delivery: ${deliveryId}`);
console.log(`  address: ${chatId ?? entry.config.telegramChatId ?? "(shared)"}${threadId ? ` · thread ${threadId}` : ""}`);
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
console.log("  tail -3 ~/.openclaw/chat-translator/logs/$(date -u +%F).log");

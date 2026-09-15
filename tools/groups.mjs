#!/usr/bin/env node
/**
 * Which conversations the server has seen.
 *
 * The messenger does not report group names, only identifiers, so they have to be
 * recognised from message fragments. The data comes from the registry the plugin
 * builds up itself — the gateway log only lives a couple of days.
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
} catch { /* the config may be unreadable */ }

const pluginCfg = cfg?.plugins?.entries?.["hebrew-bridge"]?.config ?? {};
const dataDir = pluginCfg.dataDir ?? join(homedir(), ".openclaw", "hebrew-bridge");

const connected = new Map();
for (const r of pluginCfg.routes ?? []) if (r?.jid) connected.set(r.jid, r.name ?? "connected");

let registry = {};
try {
  registry = JSON.parse(await readFile(join(dataDir, "groups-seen.json"), "utf8"));
} catch {
  console.log(`The registry is still empty (${join(dataDir, "groups-seen.json")}).`);
  console.log("The plugin scans the log once an hour — look again later.\n");
}

const rows = Object.entries(registry)
  .map(([jid, info]) => ({ jid, ...info }))
  .sort((a, b) => String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")));

if (rows.length === 0) process.exit(0);

const pad = (v, n) => String(v).padEnd(n);
const padL = (v, n) => String(v).padStart(n);

console.log(`\nConversations the server has seen (${rows.length})\n`);
console.log("  " + pad("Identifier", 32) + pad("state", 16) + padL("msgs", 7) + "  " + pad("last seen", 17) + "samples");
console.log("  " + "-".repeat(104));

for (const r of rows) {
  const status = connected.has(r.jid) ? `✓ ${connected.get(r.jid)}`.slice(0, 15) : "—";
  const when = String(r.lastSeen ?? "").replace("T", " ").slice(0, 16) || "—";
  const sample = (r.samples ?? []).join(" · ").slice(0, 44) || "(service entries only)";
  console.log("  " + pad(r.jid, 32) + pad(status, 16) + padL(r.count ?? 0, 7) + "  " + pad(when, 17) + sample);
}

console.log(`
Connect a conversation:
  node tools/add-group.mjs <identifier> "Name" <delivery address>

The registry fills itself in. If the chat you want is missing, nothing was posted
in it since the plugin started watching.
`);

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";

/**
 * Registry of conversations the server has seen.
 *
 * The gateway log only lives a couple of days, and with it goes every trace of
 * a group that rarely writes. The registry keeps that knowledge: without it a
 * quiet group cannot be connected at all — there is nothing to recognise it by.
 */
export async function loadRegistry(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

export async function saveRegistry(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

/** Folds fresh observations in without losing what was already known. */
export function mergeObservations(registry, observations, { source, now = new Date().toISOString() } = {}) {
  const next = { ...registry };
  for (const obs of observations) {
    const prev = next[obs.conversationId] ?? {};
    const samples = [...new Set([...(prev.samples ?? []), ...(obs.samples ?? [])])].slice(0, 5);
    next[obs.conversationId] = {
      source: source ?? prev.source ?? "whatsapp",
      firstSeen: prev.firstSeen ?? obs.lastSeen ?? now,
      lastSeen:
        obs.lastSeen && obs.lastSeen > (prev.lastSeen ?? "")
          ? obs.lastSeen
          : prev.lastSeen ?? obs.lastSeen ?? now,
      // the log only shows the last day or so, so keep the larger count
      count: Math.max(prev.count ?? 0, obs.count ?? 0),
      samples,
    };
  }
  return next;
}

export function registryPath(dataDir) {
  return join(dataDir, "groups-seen.json");
}

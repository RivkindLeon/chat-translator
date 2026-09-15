import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";

/**
 * Реестр увиденных бесед.
 *
 * Журнал шлюза живёт пару суток, и вместе с ним исчезает всякий след о группах,
 * которые редко пишут. Реестр копит это надолго: без него подключить молчащую
 * группу невозможно — её попросту не в чем опознать.
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

/** Вливает свежие наблюдения, не теряя того, что уже было известно. */
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
      // счётчик в журнале виден только за последние сутки, поэтому берём больший
      count: Math.max(prev.count ?? 0, obs.count ?? 0),
      samples,
    };
  }
  return next;
}

export function registryPath(dataDir) {
  return join(dataDir, "groups-seen.json");
}

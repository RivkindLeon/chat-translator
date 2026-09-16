import telegram from "./telegram.js";
import { splitForDelivery } from "../format.js";

/** Where translations go. Adding a recipient means dropping a file in here. */
const DELIVERIES = [telegram];

export function resolveDelivery(id) {
  return DELIVERIES.find((d) => d.id === (id ?? "telegram"));
}

export function listDeliveries() {
  return DELIVERIES.map((d) => d.id);
}

const RETRIABLE = /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|socket/i;

/**
 * Sends text along a route: splits it to the recipient's limit and retries on
 * network hiccups. The network blinks regularly, and losing a translation that
 * has already been paid for because of it would be careless.
 */
export async function deliverText({ text, route, gatewayConfig, log, journal }) {
  const adapter = resolveDelivery(route.delivery);
  if (!adapter) {
    throw new Error(`unknown recipient "${route.delivery}"; available: ${listDeliveries().join(", ")}`);
  }

  const auth = adapter.resolveAuth(gatewayConfig);
  const target = route.chatId;
  if (!target) throw new Error(`route "${route.name}" has no delivery address`);

  for (const chunk of splitForDelivery(text, adapter.limit)) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await adapter.sendChunk({ auth, target, thread: route.threadId, text: chunk });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        const retriable = err?.retriable === true || RETRIABLE.test(String(err?.message ?? err));
        if (!retriable || attempt === 3) break;
        log?.warn?.(`[hebrew-bridge] delivery attempt ${attempt} failed (${err?.message ?? err}), retrying`);
        void journal?.("warn", `delivery attempt ${attempt} failed, retrying`);
        await new Promise((r) => setTimeout(r, err?.retryAfterMs ?? attempt * 1500));
      }
    }
    if (lastErr) throw lastErr;
  }
}

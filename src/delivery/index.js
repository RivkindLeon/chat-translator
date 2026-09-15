import telegram from "./telegram.js";
import { splitForDelivery } from "../format.js";

/** Куда доставлять переводы. Добавить получателя — значит положить сюда файл. */
const DELIVERIES = [telegram];

export function resolveDelivery(id) {
  return DELIVERIES.find((d) => d.id === (id ?? "telegram"));
}

export function listDeliveries() {
  return DELIVERIES.map((d) => d.id);
}

const RETRIABLE = /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|socket/i;

/**
 * Отправляет текст по маршруту: режет под предел получателя и переспрашивает
 * при сетевых сбоях. Сеть моргает регулярно, и терять из-за этого перевод,
 * за который уже заплачено, незачем.
 */
export async function deliverText({ text, route, gatewayConfig, log, journal }) {
  const adapter = resolveDelivery(route.delivery);
  if (!adapter) {
    throw new Error(`получатель "${route.delivery}" неизвестен; доступные: ${listDeliveries().join(", ")}`);
  }

  const auth = adapter.resolveAuth(gatewayConfig);
  const target = route.chatId;
  if (!target) throw new Error(`для маршрута "${route.name}" не указан адрес доставки`);

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
        log?.warn?.(`[hebrew-bridge] доставка: попытка ${attempt} не удалась (${err?.message ?? err}), повтор`);
        void journal?.("warn", `доставка: попытка ${attempt} не удалась, повтор`);
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    if (lastErr) throw lastErr;
  }
}

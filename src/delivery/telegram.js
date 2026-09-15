/**
 * Доставка в Telegram.
 *
 * Знает две вещи, которых не должен знать остальной плагин: где взять доступ
 * к боту и как выглядит запрос на отправку.
 */
export default {
  id: "telegram",

  /** Предел длины одного сообщения. */
  limit: 4096,

  /** Токен живёт в настройках канала OpenClaw — своей копии не держим. */
  resolveAuth(gatewayConfig) {
    const token = gatewayConfig?.channels?.telegram?.botToken;
    if (!token) throw new Error("не настроен доступ к боту Telegram");
    return token;
  },

  /**
   * Отправляет один кусок текста. Бросает исключение при неудаче;
   * пометка retriable говорит вызывающему, что повтор имеет смысл.
   */
  async sendChunk({ auth, target, thread, text }) {
    const res = await fetch(`https://api.telegram.org/bot${auth}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: target,
        text,
        disable_web_page_preview: true,
        ...(thread ? { message_thread_id: Number(thread) } : {}),
      }),
    });
    if (res.ok) return;

    const body = await res.text().catch(() => "");
    const err = new Error(`Telegram ответил ${res.status}: ${body.slice(0, 200)}`);
    // 4xx — наша вина (неверный адрес, бота выкинули); повторять бессмысленно
    if (res.status >= 400 && res.status < 500) throw err;
    throw Object.assign(err, { retriable: true });
  },
};

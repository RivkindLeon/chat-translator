/**
 * Delivery to Telegram.
 *
 * Holds the two things the rest of the plugin should not know: where the bot
 * credentials come from, and what a send request looks like.
 */
export default {
  id: "telegram",

  /** Length limit of a single message. */
  limit: 4096,

  /** The token lives in the OpenClaw channel settings — we keep no copy. */
  resolveAuth(gatewayConfig) {
    const token = gatewayConfig?.channels?.telegram?.botToken;
    if (!token) throw new Error("Telegram bot credentials are not configured");
    return token;
  },

  /**
   * Sends one chunk of text. Throws on failure; the `retriable` flag tells the
   * caller that trying again is worth it.
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
    const err = new Error(`Telegram replied ${res.status}: ${body.slice(0, 200)}`);

    // 429 is a rate limit, not a mistake: it is exactly what a queue draining
    // after an outage runs into, and waiting is the correct answer.
    if (res.status === 429) {
      let retryAfterMs;
      try { retryAfterMs = (JSON.parse(body)?.parameters?.retry_after ?? 0) * 1000 || undefined; } catch { /* body is not JSON */ }
      throw Object.assign(err, { retriable: true, retryAfterMs });
    }

    // Any other 4xx is our own fault (wrong address, bot removed): retrying will
    // never help, so the caller must set the message aside instead of blocking on it.
    if (res.status >= 400 && res.status < 500) throw Object.assign(err, { permanent: true });

    throw Object.assign(err, { retriable: true });
  },
};

/**
 * Delivery to an HTTP webhook.
 *
 * The second recipient exists as much to prove the interface as to be useful:
 * it has no stored credentials, a different size limit and a different payload
 * from Telegram, so anything the engine assumed about Telegram shows up here.
 *
 * The route's address is the full URL, which is how Slack, Discord, n8n and
 * Zapier hand out incoming webhooks — the secret is already inside it, so
 * nothing extra has to be configured.
 */
export default {
  id: "webhook",

  /** Discord caps a message at 2000 characters; Slack allows far more. */
  limit: 2000,

  /** Nothing to resolve: the address carries whatever secret there is. */
  resolveAuth() {
    return null;
  },

  async sendChunk({ target, thread, text }) {
    if (!/^https:\/\//i.test(target)) {
      throw Object.assign(new Error("a webhook address must be an https:// URL"), { permanent: true });
    }

    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `text` is what Slack reads, `content` is what Discord reads; every
      // endpoint we know of ignores the field it does not use.
      body: JSON.stringify({ text, content: text, ...(thread ? { thread } : {}) }),
    });
    if (res.ok) return;

    const body = await res.text().catch(() => "");
    const err = new Error(`webhook replied ${res.status}: ${body.slice(0, 200)}`);

    if (res.status === 429) {
      const header = Number(res.headers?.get?.("retry-after"));
      throw Object.assign(err, { retriable: true, retryAfterMs: Number.isFinite(header) ? header * 1000 : undefined });
    }
    if (res.status >= 400 && res.status < 500) throw Object.assign(err, { permanent: true });
    throw Object.assign(err, { retriable: true });
  },
};

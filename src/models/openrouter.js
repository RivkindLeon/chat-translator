/**
 * Calling a model through OpenRouter directly.
 *
 * This exists so a route can pick its own model: translation and a reasoning
 * assistant are different jobs, and forcing one model on both is wrong.
 * Credentials come from OpenClaw itself — the plugin keeps no copy of the key.
 */
export default {
  id: "openrouter",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",

  async complete({ auth, model, systemPrompt, messages, maxTokens, temperature, timeoutMs = 120_000 }) {
    if (!auth?.apiKey) throw new Error("could not obtain OpenRouter credentials");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
            ...messages,
          ],
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`OpenRouter replied ${res.status}: ${body.slice(0, 200)}`);
        // 5xx and 429 are worth retrying; anything else is our own fault
        if (res.status >= 500 || res.status === 429) err.retriable = true;
        throw err;
      }

      const data = await res.json();
      const usage = data?.usage ?? {};
      return {
        text: data?.choices?.[0]?.message?.content ?? "",
        provider: "openrouter",
        model: data?.model ?? model,
        usage: {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

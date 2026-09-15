/** Prices in US dollars per million tokens. Overridden by the `prices` setting. */
export const DEFAULT_PRICES = {
  "google/gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "google/gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  "google/gemini-3.7-flash": { in: 0.75, out: 3.75 },
  "openai/gpt-5.4-mini": { in: 0.75, out: 4.5 },
  "anthropic/claude-sonnet-5": { in: 2.0, out: 10.0 },
  "deepseek/deepseek-v4-flash": { in: 0.0868, out: 0.1736 },
};

/** A model may arrive as "google/x" or "openrouter/google/x" — reduce to one shape. */
export function normalizeModelKey(model) {
  if (!model) return "";
  const parts = String(model).split("/");
  return parts.length > 2 ? parts.slice(1).join("/") : String(model);
}

export function estimateCostUsd(model, inputTokens, outputTokens, prices) {
  const table = { ...DEFAULT_PRICES, ...(prices ?? {}) };
  const rate = table[normalizeModelKey(model)];
  if (!rate) return undefined;
  const inCost = ((inputTokens ?? 0) / 1_000_000) * (rate.in ?? 0);
  const outCost = ((outputTokens ?? 0) / 1_000_000) * (rate.out ?? 0);
  return Number((inCost + outCost).toFixed(6));
}

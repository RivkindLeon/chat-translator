import openrouter from "./openrouter.js";

/** Providers the plugin can call directly. */
const PROVIDERS = [openrouter];

export function resolveProvider(id) {
  return PROVIDERS.find((p) => p.id === id);
}

export function listProviders() {
  return PROVIDERS.map((p) => p.id);
}

/**
 * Asks the model assigned to a route for a translation.
 *
 * With no explicit model it goes through OpenClaw, which picks whatever the
 * agent is configured with.
 *
 * With an explicit model there are two ways in, and the order matters. The host
 * is asked first: it is the only path that can reach subscription credentials
 * (a ChatGPT Plus login and the like), which a plugin has no way to use on its
 * own. That needs one line of operator consent in the config:
 *
 *   plugins.entries.<plugin-id>.llm.allowModelOverride: true
 *
 * Only if the host refuses do we call the provider ourselves with an API key —
 * which works for the handful of providers listed above, and costs money.
 */
export async function completeForRoute({ route, api, gatewayConfig, systemPrompt, messages, maxTokens, temperature, purpose }) {
  const ask = { systemPrompt, messages, maxTokens, temperature, purpose };
  if (!route.model) return api.runtime.llm.complete(ask);

  const slash = route.model.indexOf("/");
  if (slash < 1) {
    throw new Error(`model of route "${route.name}" must look like "provider/model"`);
  }
  const providerId = route.model.slice(0, slash);
  const modelId = route.model.slice(slash + 1);
  const provider = resolveProvider(providerId);

  let hostError;
  try {
    const hosted = await api.runtime.llm.complete({ ...ask, model: route.model });
    // An empty completion is how the host declines a model it will not run:
    // it answers, it just answers with nothing. Treating that as a result is
    // how a route ends up retrying for ever against a model that never replies.
    if ((hosted?.text ?? "").trim()) return hosted;
    hostError = new Error("the host accepted the request but returned nothing for this model");
  } catch (err) {
    hostError = err;
  }

  if (!provider) {
    throw new Error(
      `the plugin cannot call provider "${providerId}" itself, and OpenClaw would not use that model ` +
      `(${String(hostError?.message ?? hostError).slice(0, 120)}). ` +
      `Set plugins.entries.<plugin-id>.llm.allowModelOverride: true, or pick a provider the plugin can call directly: ${listProviders().join(", ")}`
    );
  }

  const auth = await api.runtime.modelAuth.getApiKeyForModel({
    model: { provider: providerId, model: modelId },
    cfg: gatewayConfig,
  });

  return provider.complete({ auth, model: modelId, systemPrompt, messages, maxTokens, temperature });
}

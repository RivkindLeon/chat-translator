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
 * agent is configured with. With an explicit model the plugin calls the
 * provider itself — there is no other way, since OpenClaw refuses to let a
 * plugin override the model.
 */
export async function completeForRoute({ route, api, gatewayConfig, systemPrompt, messages, maxTokens, temperature, purpose }) {
  if (!route.model) {
    return api.runtime.llm.complete({ systemPrompt, messages, maxTokens, temperature, purpose });
  }

  const slash = route.model.indexOf("/");
  if (slash < 1) {
    throw new Error(`model of route "${route.name}" must look like "provider/model"`);
  }
  const providerId = route.model.slice(0, slash);
  const modelId = route.model.slice(slash + 1);

  const provider = resolveProvider(providerId);
  if (!provider) {
    throw new Error(
      `the plugin cannot call provider "${providerId}"; available: ${listProviders().join(", ")}`
    );
  }

  const auth = await api.runtime.modelAuth.getApiKeyForModel({
    model: { provider: providerId, model: modelId },
    cfg: gatewayConfig,
  });

  return provider.complete({ auth, model: modelId, systemPrompt, messages, maxTokens, temperature });
}

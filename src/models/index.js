import openrouter from "./openrouter.js";

/** Провайдеры, к которым плагин умеет обращаться напрямую. */
const PROVIDERS = [openrouter];

export function resolveProvider(id) {
  return PROVIDERS.find((p) => p.id === id);
}

export function listProviders() {
  return PROVIDERS.map((p) => p.id);
}

/**
 * Просит перевод у модели, назначенной маршруту.
 *
 * Без явной модели работает через OpenClaw: тот сам выберет ту, на которой
 * настроен агент. С явной моделью плагин идёт к провайдеру напрямую — иначе
 * выбрать модель нельзя, OpenClaw переопределять её не даёт.
 */
export async function completeForRoute({ route, api, gatewayConfig, systemPrompt, messages, maxTokens, temperature, purpose }) {
  if (!route.model) {
    return api.runtime.llm.complete({ systemPrompt, messages, maxTokens, temperature, purpose });
  }

  const slash = route.model.indexOf("/");
  if (slash < 1) {
    throw new Error(`модель маршрута "${route.name}" должна выглядеть как "провайдер/модель"`);
  }
  const providerId = route.model.slice(0, slash);
  const modelId = route.model.slice(slash + 1);

  const provider = resolveProvider(providerId);
  if (!provider) {
    throw new Error(
      `к провайдеру "${providerId}" плагин обращаться не умеет; доступные: ${listProviders().join(", ")}`
    );
  }

  const auth = await api.runtime.modelAuth.getApiKeyForModel({
    model: { provider: providerId, model: modelId },
    cfg: gatewayConfig,
  });

  return provider.complete({ auth, model: modelId, systemPrompt, messages, maxTokens, temperature });
}

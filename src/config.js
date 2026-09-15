export const DEFAULTS = {
  targetLanguage: "русский",
  debounceMs: 20_000,
  maxWaitMs: 120_000,
  maxBatch: 15,
  contextSize: 10,
  model: "openrouter/google/gemini-3.7-flash",
};

/** Один маршрут — одна группа со своим буфером, контекстом, словарём и адресом доставки. */
export function resolveRoutes(cfg) {
  if (Array.isArray(cfg.routes) && cfg.routes.length > 0) {
    return cfg.routes
      .filter((r) => r && typeof r.jid === "string" && r.jid)
      .map((r, i) => ({
        jid: r.jid,
        source: r.source ?? cfg.source ?? "whatsapp",
        name: r.name ?? `группа ${i + 1}`,
        chatId: r.chatId ?? cfg.telegramChatId,
        threadId: r.threadId,
        targetLanguage: r.targetLanguage ?? cfg.targetLanguage ?? DEFAULTS.targetLanguage,
        glossary: { ...(cfg.glossary ?? {}), ...(r.glossary ?? {}) },
        debounceMs: r.debounceMs ?? cfg.debounceMs ?? DEFAULTS.debounceMs,
        maxWaitMs: r.maxWaitMs ?? cfg.maxWaitMs ?? DEFAULTS.maxWaitMs,
        maxBatch: r.maxBatch ?? cfg.maxBatch ?? DEFAULTS.maxBatch,
        contextSize: r.contextSize ?? cfg.contextSize ?? DEFAULTS.contextSize,
      }));
  }
  // старый формат конфига: одна группа плюс список дополнительных
  const legacy = [
    ...(cfg.groupJid ? [cfg.groupJid] : []),
    ...(Array.isArray(cfg.groupJids) ? cfg.groupJids : []),
  ];
  return legacy.map((jid, i) => ({
    jid,
    source: cfg.source ?? "whatsapp",
    name: i === 0 ? "основная группа" : `группа ${i + 1}`,
    chatId: cfg.telegramChatId,
    threadId: undefined,
    targetLanguage: cfg.targetLanguage ?? DEFAULTS.targetLanguage,
    glossary: cfg.glossary ?? {},
    debounceMs: cfg.debounceMs ?? DEFAULTS.debounceMs,
    maxWaitMs: cfg.maxWaitMs ?? DEFAULTS.maxWaitMs,
    maxBatch: cfg.maxBatch ?? DEFAULTS.maxBatch,
    contextSize: cfg.contextSize ?? DEFAULTS.contextSize,
  }));
}

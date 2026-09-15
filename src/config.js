export const DEFAULTS = {
  targetLanguage: "Russian",
  debounceMs: 20_000,
  maxWaitMs: 120_000,
  maxBatch: 15,
  contextSize: 10,
};

/**
 * One route is one conversation with its own buffer, context, glossary and
 * delivery address, so that separate chats never bleed into each other.
 */
export function resolveRoutes(cfg) {
  if (Array.isArray(cfg.routes) && cfg.routes.length > 0) {
    return cfg.routes
      .filter((r) => r && typeof r.jid === "string" && r.jid)
      .map((r, i) => ({
        jid: r.jid,
        source: r.source ?? cfg.source ?? "whatsapp",
        delivery: r.delivery ?? cfg.delivery ?? "telegram",
        model: r.model ?? cfg.routeModel,
        name: r.name ?? `conversation ${i + 1}`,
        chatId: r.chatId ?? cfg.telegramChatId,
        threadId: r.threadId,
        targetLanguage: r.targetLanguage ?? cfg.targetLanguage ?? DEFAULTS.targetLanguage,
        sourceLanguage: r.sourceLanguage ?? cfg.sourceLanguage,
        ownerName: r.ownerName ?? cfg.ownerName,
        timeZone: r.timeZone ?? cfg.timeZone,
        locale: r.locale ?? cfg.locale,
        labels: { ...(cfg.labels ?? {}), ...(r.labels ?? {}) },
        labelsPlural: { ...(cfg.labelsPlural ?? {}), ...(r.labelsPlural ?? {}) },
        glossary: { ...(cfg.glossary ?? {}), ...(r.glossary ?? {}) },
        debounceMs: r.debounceMs ?? cfg.debounceMs ?? DEFAULTS.debounceMs,
        maxWaitMs: r.maxWaitMs ?? cfg.maxWaitMs ?? DEFAULTS.maxWaitMs,
        maxBatch: r.maxBatch ?? cfg.maxBatch ?? DEFAULTS.maxBatch,
        contextSize: r.contextSize ?? cfg.contextSize ?? DEFAULTS.contextSize,
      }));
  }

  // older settings shape: one conversation plus a list of extra ones
  const legacy = [
    ...(cfg.groupJid ? [cfg.groupJid] : []),
    ...(Array.isArray(cfg.groupJids) ? cfg.groupJids : []),
  ];
  return legacy.map((jid, i) => ({
    jid,
    source: cfg.source ?? "whatsapp",
    delivery: cfg.delivery ?? "telegram",
    name: i === 0 ? "main conversation" : `conversation ${i + 1}`,
    chatId: cfg.telegramChatId,
    threadId: undefined,
    targetLanguage: cfg.targetLanguage ?? DEFAULTS.targetLanguage,
    sourceLanguage: cfg.sourceLanguage,
    ownerName: cfg.ownerName,
    timeZone: cfg.timeZone,
    locale: cfg.locale,
    labels: cfg.labels ?? {},
    labelsPlural: cfg.labelsPlural ?? {},
    glossary: cfg.glossary ?? {},
    debounceMs: cfg.debounceMs ?? DEFAULTS.debounceMs,
    maxWaitMs: cfg.maxWaitMs ?? DEFAULTS.maxWaitMs,
    maxBatch: cfg.maxBatch ?? DEFAULTS.maxBatch,
    contextSize: cfg.contextSize ?? DEFAULTS.contextSize,
  }));
}

const TELEGRAM_LIMIT = 4096;

/** Мягко режет длинный текст по границам строк под лимит мессенджера. */
export function splitForDelivery(text, limit = TELEGRAM_LIMIT) {
  if (text.length <= limit) return [text];
  const parts = [];
  let current = "";
  for (const line of text.split("\n")) {
    // одна строка длиннее лимита — режем жёстко
    if (line.length > limit) {
      if (current) { parts.push(current); current = ""; }
      for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
      continue;
    }
    if ((current ? current.length + 1 : 0) + line.length > limit) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Время сообщения в заголовке.
 *
 * Часовой пояс и формат берутся из настроек: сервер может стоять где угодно,
 * а читать переводы будут там, где живут участники чата. По умолчанию —
 * круглосуточный формат и часовой пояс машины.
 */
export function formatClock(timestamp, opts = {}) {
  const ms = typeof timestamp === "number"
    ? (timestamp > 1e12 ? timestamp : timestamp * 1000)
    : Date.now();

  try {
    return new Date(ms).toLocaleTimeString(opts.locale ?? "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    });
  } catch {
    // неверный часовой пояс или язык не должны ронять перевод
    return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
}

/** Человеческое имя отправителя: как его показал мессенджер → словарь → хвост адреса. */
export function resolveSenderLabel(msg, glossary) {
  const raw = msg.senderName ?? msg.senderId ?? "неизвестный";
  const bare = String(raw).split("@")[0].split(":")[0];
  return glossary?.[bare] ?? glossary?.[String(raw)] ?? bare;
}

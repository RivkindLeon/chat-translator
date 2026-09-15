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

export function formatClock(timestamp) {
  const ms = typeof timestamp === "number"
    ? (timestamp > 1e12 ? timestamp : timestamp * 1000)
    : Date.now();
  return new Date(ms).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });
}

/** Человеческое имя отправителя: pushName → глоссарий → хвост JID. */
export function resolveSenderLabel(event, glossary) {
  const meta = event.metadata ?? {};
  const raw =
    meta.pushName ??
    meta.senderName ??
    meta.notifyName ??
    event.senderId ??
    event.from ??
    "неизвестный";
  const bare = String(raw).split("@")[0].split(":")[0];
  return glossary?.[bare] ?? glossary?.[String(raw)] ?? bare;
}

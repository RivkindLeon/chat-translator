const TELEGRAM_LIMIT = 4096;

/** Splits long text on line boundaries so it fits the recipient's limit. */
export function splitForDelivery(text, limit = TELEGRAM_LIMIT) {
  if (text.length <= limit) return [text];
  const parts = [];
  let current = "";
  for (const line of text.split("\n")) {
    // a single line longer than the limit has to be cut mid-way
    if (line.length > limit) {
      if (current) { parts.push(current); current = ""; }
      // slice by code points, not UTF-16 units: cutting at the limit mid-emoji
      // would push a lone surrogate and the recipient would reject the message
      const chars = Array.from(line);
      for (let i = 0; i < chars.length; i += limit) parts.push(chars.slice(i, i + limit).join(""));
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
 * Message time for the header line.
 *
 * Time zone and format come from settings: the server may stand anywhere, while
 * translations are read where the chat participants live. Defaults to the
 * machine's own zone and a 24-hour clock.
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
    // a bad time zone or locale must not break the translation
    return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
}

/** Human name of the sender: what the messenger showed → glossary → tail of the address. */
export function resolveSenderLabel(msg, glossary) {
  const raw = msg.senderName ?? msg.senderId ?? "unknown";
  const bare = String(raw).split("@")[0].split(":")[0];
  return glossary?.[bare] ?? glossary?.[String(raw)] ?? bare;
}

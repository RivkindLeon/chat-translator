/** Медиа пока не расшифровываем — помечаем, чтобы не терялся факт сообщения. */
export const MEDIA_LABELS = {
  image: "📷 изображение",
  audio: "🎤 голосовое (не расшифровано)",
  video: "🎬 видео",
  document: "📎 документ",
  sticker: "🩹 стикер",
};

/** Как называть вложения, когда их несколько подряд. */
export const MEDIA_PLURAL = {
  image: { icon: "📷", word: "фото" },
  audio: { icon: "🎤", word: "голосовых" },
  video: { icon: "🎬", word: "видео" },
  document: { icon: "📎", word: "файлов" },
  sticker: { icon: "🩹", word: "стикеров" },
};

/**
 * Двенадцать фотографий с прогулки не должны занимать тридцать шесть строк.
 * Подряд идущие вложения одного типа от одного человека сворачиваем в строку.
 */
export function renderMediaNotes(items) {
  const groups = [];
  for (const m of items) {
    const last = groups[groups.length - 1];
    if (last && last.sender === m.sender && last.kind === m.mediaKind) {
      last.items.push(m);
    } else {
      groups.push({ sender: m.sender, kind: m.mediaKind, items: [m] });
    }
  }

  return groups.map((g) => {
    if (g.items.length === 1) {
      return `${g.sender} · ${g.items[0].clock}\n${MEDIA_LABELS[g.kind] ?? "📎 вложение"}`;
    }
    const first = g.items[0].clock;
    const last = g.items[g.items.length - 1].clock;
    const when = first === last ? first : `${first}–${last}`;
    const naming = MEDIA_PLURAL[g.kind] ?? { icon: "📎", word: "вложений" };
    return `${g.sender} · ${when}\n${naming.icon} ${g.items.length} ${naming.word}`;
  });
}

/** Канал кладёт скачанный файл на диск; путь приходит в метаданных по-разному. */
export function extractMediaFile(event) {
  const m = event.metadata ?? {};
  const first = Array.isArray(m.media) ? m.media[0] ?? {} : {};
  const path = [m.mediaPath, m.filePath, m.path, first.path, first.filePath, m.attachment?.path]
    .find((v) => typeof v === "string" && v.length > 0);
  const mime = [m.mediaType, m.mime, m.mimeType, first.mime, first.mimeType]
    .find((v) => typeof v === "string" && v.length > 0);
  return { path, mime };
}

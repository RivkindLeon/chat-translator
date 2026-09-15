/**
 * Подсказки модели.
 *
 * Написаны по-английски намеренно: модели следуют англоязычным инструкциям
 * заметнее точнее, а язык перевода подставляется параметром — плагин не должен
 * быть привязан к одной паре языков.
 */

/**
 * Снятие текста с изображения.
 *
 * Главная сложность — таблицы. Расписание или меню, разложенное по строкам
 * исходной таблицы, превращается в нечитаемую кашу: «все завтраки недели,
 * потом все обеды». Поэтому группировка по дням оговаривается отдельно и
 * показывается примером.
 */
export function buildImageTextPrompt(route = {}) {
  const unreadable = route.unreadableMark ?? "[unreadable]";
  return [
    "Extract all text from the image in its original language.",
    "",
    "HOW TO LAY OUT TABLES (this matters most):",
    "- If the table has weekdays or dates, group BY DAY, not by row type.",
    "  Put the day name on its own line, then everything belonging to that day.",
    "- Inside a day, put each category (breakfast, lunch, etc.) on its own line,",
    "  and each item on a separate line. Do not join items with semicolons.",
    "- Leave a blank line between days.",
    "",
    "Example of the expected shape:",
    "Sunday",
    "  Breakfast:",
    "    white bread",
    "    cottage cheese",
    "  Lunch:",
    "    lentil soup",
    "",
    "EVERYTHING ELSE:",
    "- Keep lists as lists and headings on their own lines.",
    "- Reproduce dates, numbers, names, phone numbers and addresses exactly.",
    "- Do not describe the image and do not comment. Only the text on it.",
    `- Mark anything you cannot read as ${unreadable}. Skip empty cells silently.`,
    "- If there is no readable text on the image, return exactly: NO_TEXT",
  ].join("\n");
}

/** Системная подсказка перевода: язык, регистр, разметка, словарь. */
export function buildTranslationPrompt(route) {
  const target = route.targetLanguage;
  const source = route.sourceLanguage;
  const owner = route.ownerName;

  const glossaryLines = Object.entries(route.glossary ?? {})
    .map(([from, to]) => `  ${from} → ${to}`)
    .join("\n");

  return [
    `You translate a stream of group-chat messages into ${target}.`,
    source
      ? `Messages are usually in ${source}, but other languages may appear — translate those too.`
      : "Messages may be in several languages — translate all of them.",
    "",
    "RULES",
    '- Keep the header line "Name · time" exactly as given; change nothing in it.',
    "- Keep the conversational register: render slang as slang, not as officialese.",
    "- Expand an abbreviation only when the meaning would otherwise be lost.",
    "- Never invent or complete anything. A fragment stays a fragment.",
    `- Mark a reply on its own line, written in ${target}: "↪ in reply to: <short gist>".`,
    owner
      ? `- If a message is addressed to ${owner} personally or asks something of them, start that line with "⚑".`
      : "",
    "- Answer with the translation only. No preamble, no explanations, no comments of your own.",
    "- Preserve the structure exactly: line breaks, indentation, grouping by day or section.",
    "  Do not merge lines and do not reorder anything.",
    `- Keep names of people, places and local realities recognisable: transliterate into ${target}`,
    "  when there is no established equivalent, rather than inventing a translation.",
    glossaryLines
      ? `\nGLOSSARY (write these names and terms exactly so)\n${glossaryLines}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Собирает пачку сообщений в текст для модели. */
export function renderMessagesForPrompt(items) {
  return items
    .map((m) => {
      const head = `${m.sender} · ${m.clock}${m.prefix ? ` ${m.prefix}` : ""}`;
      const quote = m.replyToBody ? `\n[re: ${m.replyToBody}]` : "";
      return `${head}${quote}\n${m.text}`;
    })
    .join("\n\n");
}

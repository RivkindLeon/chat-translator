/**
 * Prompts for the model.
 *
 * Written in English on purpose: models follow English instructions more
 * closely, and the languages are parameters — the plugin should not be tied to
 * one pair of them.
 */

/**
 * Reading text off an image.
 *
 * Tables are the hard part. A timetable or menu laid out row by row turns into
 * an unreadable mess — "every breakfast of the week, then every lunch" — so
 * grouping by day is spelled out separately and shown by example.
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

/** System prompt for translation: languages, register, layout, glossary. */
export function buildTranslationPrompt(route) {
  const target = route.targetLanguage;
  const source = route.sourceLanguage;
  const owner = route.ownerName;

  // A scratchpad conversation goes both ways: what arrives in the source
  // language comes back in the target one, and what you write in the target
  // language comes back in the source one, ready to forward on. It needs both
  // ends of the pair to be named — without that there is no "other" language.
  const twoWay = Boolean(route.twoWay && source);
  // Rules that name a language have to stay honest in both directions.
  const into = twoWay ? "the language that message is being translated into" : target;

  const glossaryLines = Object.entries(route.glossary ?? {})
    .map(([from, to]) => `  ${from} → ${to}`)
    .join("\n");

  return [
    twoWay
      ? `You translate messages between ${source} and ${target}, in both directions.`
      : `You translate a stream of group-chat messages into ${target}.`,
    twoWay
      ? `Translate each message into the other language of the pair: ${source} → ${target}, and ${target} → ${source}. Anything in a third language goes into ${target}.`
      : source
        ? `Messages are usually in ${source}, but other languages may appear — translate those too.`
        : "Messages may be in several languages — translate all of them.",
    "",
    "RULES",
    '- Keep the header line "Name · time" exactly as given; change nothing in it.',
    "- Keep the conversational register: render slang as slang, not as officialese.",
    "- Expand an abbreviation only when the meaning would otherwise be lost.",
    "- Never invent or complete anything. A fragment stays a fragment.",
    `- Mark a reply on its own line, written in ${into}: "↪ in reply to: <short gist>".`,
    owner
      ? `- If a message is addressed to ${owner} personally or asks something of them, start that line with "⚑".`
      : "",
    twoWay
      ? `- Never return a message in the language it arrived in. A ${source} message comes back in ${target}, a ${target} message comes back in ${source} — even when it already reads perfectly well.`
      : "",
    "- Answer with the translation only. No preamble, no explanations, no comments of your own.",
    "- Preserve the structure exactly: line breaks, indentation, grouping by day or section.",
    "  Do not merge lines and do not reorder anything.",
    `- Keep names of people, places and local realities recognisable: transliterate into ${into}`,
    "  when there is no established equivalent, rather than inventing a translation.",
    glossaryLines
      ? `\nGLOSSARY (write these names and terms exactly so)\n${glossaryLines}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Renders a batch of messages as text for the model. */
export function renderMessagesForPrompt(items) {
  return items
    .map((m) => {
      const head = `${m.sender} · ${m.clock}${m.prefix ? ` ${m.prefix}` : ""}`;
      const quote = m.replyToBody ? `\n[re: ${m.replyToBody}]` : "";
      return `${head}${quote}\n${m.text}`;
    })
    .join("\n\n");
}

/**
 * The line that introduces the batch itself. In a two-way conversation the
 * instruction is repeated here on purpose: it sits directly above the messages,
 * where the model is least likely to lose it behind the context block.
 */
export function buildBatchHeader(route = {}) {
  const target = route.targetLanguage;
  const source = route.sourceLanguage;
  if (!(route.twoWay && source)) return "TRANSLATE THESE MESSAGES";
  return `TRANSLATE EACH MESSAGE INTO THE OTHER LANGUAGE (${source} → ${target}, ${target} → ${source})`;
}

/**
 * Checking a translation you cannot read.
 *
 * The point of a scratchpad is to send a message in a language you do not
 * speak — which means you cannot tell whether what you are about to send says
 * what you meant. So the translation is rendered back into the language you do
 * read, and you compare that with what you wrote.
 *
 * It is deliberately a separate call on the translated text alone: the model
 * never sees the original, so it cannot quietly "correct" the rendering to
 * match what it knows you meant.
 */
export function buildBackTranslationPrompt(route = {}) {
  const target = route.targetLanguage;
  return [
    `Render the text below in ${target}, plainly and faithfully, so a reader can check what it actually says.`,
    `If the text is already in ${target}, reply with exactly: SAME`,
    "Do not explain, do not comment, do not improve the wording. The rendering only.",
  ].join("\n");
}

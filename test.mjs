import plugin from "./index.js";

const calls = { llm: [], log: [] };
let handler = null;

const TEST_DIR = `${process.env.TMPDIR ?? "/tmp"}/hebrew-bridge-test-${process.pid}`;

const pluginConfig = {
  dataDir: TEST_DIR,          // журнал и учёт теста — отдельно от боевых
  groupJid: "120363000000000000@g.us",
  telegramChatId: "123456",
  model: "test/model",
  debounceMs: 120,
  maxWaitMs: 400,
  maxBatch: 3,
  contextSize: 4,
  dryRun: true,
  glossary: { "972500000001": "Эйтан", "972500000002": "Мири" },
};

const api = {
  pluginConfig,
  on: (name, fn) => { if (name === "message_received") handler = fn; },
  runtime: {
    logging: { getChildLogger: () => ({
      info: (m) => calls.log.push(["info", m]),
      warn: (m) => calls.log.push(["warn", m]),
      error: (m) => calls.log.push(["error", m]),
    })},
    config: { current: () => ({ channels: { telegram: { botToken: "fake" } } }) },
    stt: { transcribeAudioFile: async () => ({ text: "" }) },
    mediaUnderstanding: {
      describeImageFile: async () => ({ text: "NO_TEXT" }),
      describeImageFileWithModel: async () => ({ text: "NO_TEXT" }),
    },
    llm: { complete: async (p) => {
      calls.llm.push(p);
      return { text: "[перевод пачки]", model: p.model, usage: { inputTokens: 100, outputTokens: 50 } };
    }},
  },
};

plugin.register(api);

const wa = (text, opts = {}) => handler(
  { content: text, senderId: opts.sender ?? "972500000001@s.whatsapp.net",
    messageId: opts.id ?? Math.random().toString(36).slice(2),
    timestamp: 1787856471, metadata: opts.metadata ?? { pushName: opts.push },
    replyToBody: opts.replyToBody },
  { channelId: "whatsapp", conversationId: opts.jid ?? pluginConfig.groupJid }
);

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => { console.log(`${cond ? "  ok  " : " FAIL "} ${name}`); if (!cond) failures++; };

console.log("\n— фильтры —");
await handler({ content: "чужой канал" }, { channelId: "telegram", conversationId: pluginConfig.groupJid });
await wa("чужая группа", { jid: "999@g.us" });
await wa("", {});
await wa("своё", { metadata: { fromMe: true } });
await wait(250);
check("посторонние сообщения не вызвали модель", calls.llm.length === 0);

console.log("\n— дедупликация —");
await wa("שלום", { id: "dup-1" });
await wa("שלום", { id: "dup-1" });
await wait(250);
check("дубль по messageId отброшен", calls.llm.length === 1);
const firstPrompt = calls.llm[0].messages[0].content;
check("в промпте одно сообщение", (firstPrompt.match(/שלום/g) || []).length === 1);

console.log("\n— дебаунс собирает пачку —");
calls.llm.length = 0;
await wa("раз", { id: "a" }); await wait(30);
await wa("два-от-Мири", { id: "b", sender: "972500000002@s.whatsapp.net" });
check("до паузы модель не вызвана", calls.llm.length === 0);
await wait(250);
check("после паузы ровно один вызов", calls.llm.length === 1);

console.log("\n— контекст и глоссарий —");
const p2 = calls.llm[0].messages[0].content;
check("предыдущая пачка попала в контекст", p2.includes("КОНТЕКСТ"));
check("имя из глоссария подставлено", p2.includes("Эйтан"));
check("второй участник распознан", p2.includes("Мири"));
check("системный промпт содержит правила", calls.llm[0].systemPrompt.includes("RULES"));
check("язык перевода подставлен", calls.llm[0].systemPrompt.includes(pluginConfig.targetLanguage ?? "Russian"));
check("модель не навязывается плагином", calls.llm[0].model === undefined);

console.log("\n— maxBatch режет пачку —");
calls.llm.length = 0;
for (const i of [1,2,3,4,5]) await wa(`msg${i}`, { id: `m${i}` });
await wait(400);
const payloadOf = (c) => c.messages[0].content.split("ПЕРЕВЕДИ ЭТИ СООБЩЕНИЯ")[1] ?? "";
const sizes = calls.llm.map(c => (payloadOf(c).match(/msg\d/g) || []).length);
check(`пачки не больше maxBatch=3 (получили ${JSON.stringify(sizes)})`, sizes.every(s => s <= 3));
check("все 5 сообщений переведены", sizes.reduce((a,b)=>a+b,0) === 5);

console.log("\n— ошибка модели не теряет сообщения —");
calls.llm.length = 0;
let boom = true;
api.runtime.llm.complete = async (p) => {
  calls.llm.push(p);
  if (boom) { boom = false; throw new Error("503 upstream"); }
  return { text: "ок", model: p.model, usage: {} };
};
await wa("важное", { id: "keep-1" });
await wait(500);
const retried = calls.llm.some(c => c.messages[0].content.includes("важное"));
check("сообщение переотправлено после сбоя", calls.llm.length >= 2 && retried);
check("ошибка залогирована", calls.log.some(([lvl, m]) => lvl === "error" && String(m).includes("503")));

console.log("\n— пачка фотографий не раздувает сообщение —");
calls.llm.length = 0; calls.log.length = 0;
pluginConfig.maxBatch = 20;              // 12 фото должны попасть в одну пачку
pluginConfig.labelsPlural = { image: { icon: "📷", word: "фото" } };   // подписи задаёт пользователь
for (let i = 0; i < 12; i += 1) {
  await wa("<media:image>", { id: `flood-${i}` });
}
await wait(400);
const note = calls.log.map(([, m]) => String(m)).join(" | ");
check("двенадцать фото свернулись в одну строку", note.includes("12 фото"));
check("не осталось повторяющихся блоков", !note.includes("📷 image"));
check("подпись взята из настроек, а не зашита", note.includes("фото") && !note.includes("photos"));
pluginConfig.maxBatch = 3;

console.log("\n— время берётся из настроек —");
{
  const { formatClock } = await import("./src/format.js");
  const t0 = 1788086845;
  check("часовой пояс применяется", formatClock(t0, { timeZone: "Asia/Jerusalem" }) !== formatClock(t0, { timeZone: "America/New_York" }));
  check("формат применяется", formatClock(t0, { timeZone: "UTC", locale: "en-US" }).includes("AM") || formatClock(t0, { timeZone: "UTC", locale: "en-US" }).includes("PM"));
  check("неверный пояс не роняет перевод", /^\d{2}:\d{2}$/.test(formatClock(t0, { timeZone: "Нет/Такого" })));
}

console.log("\n— реестр бесед —");
{
  const { mergeObservations } = await import("./src/registry.js");
  const first = mergeObservations({}, [
    { conversationId: "a@g.us", count: 3, lastSeen: "2026-09-01T10:00:00Z", samples: ["привет"] },
  ], { source: "whatsapp" });
  check("новая беседа попала в реестр", first["a@g.us"]?.count === 3);

  const later = mergeObservations(first, [
    { conversationId: "a@g.us", count: 1, lastSeen: "2026-09-10T10:00:00Z", samples: ["ещё"] },
  ], { source: "whatsapp" });
  check("старые образцы не потерялись", later["a@g.us"].samples.includes("привет") && later["a@g.us"].samples.includes("ещё"));
  check("счётчик не уменьшился при коротком журнале", later["a@g.us"].count === 3);
  check("дата последнего сообщения обновилась", later["a@g.us"].lastSeen.startsWith("2026-09-10"));
  check("первая встреча запомнена", later["a@g.us"].firstSeen.startsWith("2026-09-01"));
}

console.log(failures === 0 ? "\nвсе проверки пройдены\n" : `\nпровалено проверок: ${failures}\n`);
await (await import("node:fs/promises")).rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
process.exit(failures === 0 ? 0 : 1);

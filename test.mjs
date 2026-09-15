import plugin from "./index.js";

const calls = { llm: [], log: [], auth: [], stt: [], img: [] };
let sttReply = "";
let imgReply = "NO_TEXT";
let handler = null;
const handlers = {};

const TEST_DIR = `${process.env.TMPDIR ?? "/tmp"}/hebrew-bridge-test-${process.pid}`;

const MAIN_JID = "120363000000000000@g.us";

const pluginConfig = {
  dataDir: TEST_DIR,          // журнал и учёт теста — отдельно от боевых
  routes: [
    {
      jid: MAIN_JID,
      name: "Основная",
      chatId: "123456",
      glossary: { "972500000001": "Эйтан", "972500000002": "Мири" },
    },
  ],
  debounceMs: 120,
  maxWaitMs: 400,
  maxBatch: 3,
  contextSize: 4,
  dryRun: true,
};

const api = {
  pluginConfig,
  on: (name, fn) => { handlers[name] = fn; if (name === "message_received") handler = fn; },
  runtime: {
    logging: { getChildLogger: () => ({
      info: (m) => calls.log.push(["info", m]),
      warn: (m) => calls.log.push(["warn", m]),
      error: (m) => calls.log.push(["error", m]),
    })},
    config: { current: () => ({ channels: { telegram: { botToken: "fake" } } }) },
    stt: { transcribeAudioFile: async (p) => { calls.stt.push(p); return { text: sttReply }; } },
    mediaUnderstanding: {
      describeImageFile: async (p) => { calls.img.push(p); return { text: imgReply }; },
      describeImageFileWithModel: async (p) => { calls.img.push(p); return { text: imgReply }; },
    },
    modelAuth: { getApiKeyForModel: async (p) => { calls.auth.push(p); return { apiKey: "test-key", mode: "api-key" }; } },
    llm: { complete: async (p) => {
      calls.llm.push(p);
      return { text: "[перевод пачки]", model: p.model, usage: { inputTokens: 100, outputTokens: 50 } };
    }},
  },
};

plugin.register(api);

const wa = (text, opts = {}) => handler(
  {
    content: text,
    senderId: opts.sender ?? "972500000001@s.whatsapp.net",
    messageId: opts.id ?? Math.random().toString(36).slice(2),
    timestamp: 1787856471,
    sessionKey: opts.sessionKey,
    replyToBody: opts.replyToBody,
    metadata: opts.metadata ?? {
      pushName: opts.push,
      ...(opts.mediaPath ? { mediaPath: opts.mediaPath, mediaType: opts.mime } : {}),
    },
  },
  {
    channelId: "whatsapp",
    conversationId: opts.jid ?? MAIN_JID,
    sessionKey: opts.sessionKey,
  }
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

console.log("\n— своя модель на маршрут —");
{
  const { completeForRoute } = await import("./src/models/index.js");

  calls.llm.length = 0;
  await completeForRoute({ route: { name: "без модели" }, api, systemPrompt: "s", messages: [] });
  check("без указания модели идём через OpenClaw", calls.llm.length === 1);

  calls.auth.length = 0;
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: "перевод" } }], model: "m", usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  };
  const res = await completeForRoute({
    route: { name: "со своей", model: "openrouter/some/model" },
    api, systemPrompt: "s", messages: [{ role: "user", content: "x" }],
  });
  globalThis.fetch = origFetch;

  check("доступ запрошен у OpenClaw, а не хранится у нас", calls.auth[0]?.model?.provider === "openrouter");
  check("модель передана без имени провайдера", sent[0]?.body?.model === "some/model");
  check("перевод получен напрямую", res.text === "перевод");
  check("расход посчитан", res.usage.inputTokens === 10 && res.usage.outputTokens === 5);

  let failed;
  try {
    await completeForRoute({ route: { name: "кривая", model: "неизвестный/модель" }, api, messages: [] });
  } catch (err) { failed = err; }
  check("неизвестный провайдер даёт понятную ошибку", /обращаться не умеет/.test(String(failed?.message)));
}

console.log("\n— у каждой группы свой мир —");
{
  const second = "120363222222222222@g.us";
  pluginConfig.routes.push({ jid: second, name: "Вторая", chatId: "999" });
  pluginConfig.dryRun = false;
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, text: async () => "" }; };

  calls.llm.length = 0;
  await wa("сообщение первой", { id: "iso-1" });
  await wa("сообщение второй", { id: "iso-2", jid: second });
  await wait(400);

  check("две группы — два отдельных вызова модели", calls.llm.length === 2);
  const a = calls.llm.find((c) => c.messages[0].content.includes("первой"));
  const b = calls.llm.find((c) => c.messages[0].content.includes("второй"));
  check("сообщения групп не смешались в одной пачке", Boolean(a && b) && a !== b);
  check("словарь применился только к своей группе", a.systemPrompt.includes("Эйтан") && !b.systemPrompt.includes("Эйтан"));
  const chats = sent.map((s) => String(s.chat_id));
  check(`каждая группа ушла в свой чат (${chats.join(", ")})`, chats.includes("123456") && chats.includes("999"));

  globalThis.fetch = origFetch;
  pluginConfig.dryRun = true;
  pluginConfig.routes.pop();
}

console.log("\n— в читаемый мессенджер ничего не пишем —");
{
  const out = (target, channel = "whatsapp") =>
    handlers["message_sending"]({ to: target, content: "ответ ассистента" }, { channelId: channel, conversationId: target });
  check("ответ в читаемую группу отменён", (await out(MAIN_JID))?.cancel === true);
  check("личный чат тоже закрыт", (await out("972500000009@s.whatsapp.net"))?.cancel === true);
  check("посторонняя группа закрыта", (await out("120363999999999999@g.us"))?.cancel === true);
  check("доставка переводов не затронута", !(await out("-100123", "telegram"))?.cancel);
}

console.log("\n— ассистент не запускается на читаемых сообщениях —");
{
  const dispatch = (key) => handlers["before_dispatch"]({ sessionKey: key, content: "x" }, { sessionKey: key });
  await wa("шалом", { id: "agent-1", sessionKey: "wa:watched" });
  check("на читаемой беседе запуск подавлен", (await dispatch("wa:watched"))?.handled === true);
  check("чужие беседы не трогаем", !(await dispatch("wa:someone-else"))?.handled);
  await wait(300);
}

console.log("\n— голосовые и картинки —");
{
  calls.llm.length = 0; calls.stt.length = 0; calls.img.length = 0;
  sttReply = "שלום, נתראה מחר";
  await wa("<media:audio>", { id: "v-1", mediaPath: "/tmp/a.ogg", mime: "audio/ogg" });
  await wait(350);
  check("голосовое отправлено на расшифровку", calls.stt.length === 1);
  check("путь к файлу передан", calls.stt[0]?.filePath === "/tmp/a.ogg");
  const voiced = calls.llm[0]?.messages[0].content ?? "";
  check("расшифровка ушла в перевод", voiced.includes("נתראה מחר"));
  check("помечено как голосовое", voiced.includes("🎤"));

  calls.llm.length = 0; calls.img.length = 0;
  imgReply = "הודעה חשובה להורים";
  await wa("<media:image>", { id: "i-1", mediaPath: "/tmp/x.jpg", mime: "image/jpeg" });
  await wait(350);
  check("картинка отправлена на чтение", calls.img.length === 1);
  check("текст с картинки ушёл в перевод", (calls.llm[0]?.messages[0].content ?? "").includes("הודעה חשובה"));

  calls.llm.length = 0;
  imgReply = "NO_TEXT";
  await wa("<media:image>", { id: "i-2", mediaPath: "/tmp/kids.jpg" });
  await wait(350);
  check("фото без текста не идёт в модель", calls.llm.length === 0);

  calls.llm.length = 0;
  const brokenStt = api.runtime.stt.transcribeAudioFile;
  api.runtime.stt.transcribeAudioFile = async () => { throw new Error("stt недоступен"); };
  await wa("<media:audio>", { id: "v-2", mediaPath: "/tmp/b.ogg" });
  await wait(350);
  check("сбой распознавания не теряет сообщение", calls.log.some(([, m]) => String(m).includes("голосов")));
  check("причина сбоя записана", calls.log.some(([lvl, m]) => lvl === "warn" && String(m).includes("stt недоступен")));
  api.runtime.stt.transcribeAudioFile = brokenStt;
  sttReply = "";
}

console.log("\n— сбой сети не теряет перевод и не переводит заново —");
{
  pluginConfig.dryRun = false;
  calls.llm.length = 0;
  let fails = 2;
  const delivered = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (fails-- > 0) throw new Error("fetch failed");
    delivered.push(JSON.parse(init.body).text);
    return { ok: true, text: async () => "" };
  };
  await wa("סבבה", { id: "net-1" });
  await wait(6500);
  check("перевод запрошен один раз, несмотря на сбои", calls.llm.length === 1);
  check("сообщение всё-таки доставлено", delivered.length === 1);
  globalThis.fetch = origFetch;
  pluginConfig.dryRun = true;
}

console.log(failures === 0 ? "\nвсе проверки пройдены\n" : `\nпровалено проверок: ${failures}\n`);
await (await import("node:fs/promises")).rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
process.exit(failures === 0 ? 0 : 1);

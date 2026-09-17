import plugin from "./index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const calls = { llm: [], log: [], auth: [], stt: [], img: [] };
let sttReply = "";
let imgReply = "NO_TEXT";
let handler = null;
const handlers = {};
let onCalls = 0;

// Non-Latin text must survive the whole pipeline. Symbols rather than any
// real script: the plugin is not about one language and neither are its tests.
const NON_ASCII = "✦ ✧ ✶ — “…”";

const TEST_DIR = `${process.env.TMPDIR ?? "/tmp"}/chat-translator-test-${process.pid}`;

const MAIN_JID = "120363000000000000@g.us";

const pluginConfig = {
  dataDir: TEST_DIR,          // test journal and accounting — kept away from the live ones
  routes: [
    {
      jid: MAIN_JID,
      name: "Main",
      chatId: "123456",
      glossary: { "972500000001": "Eitan", "972500000002": "Miri" },
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
  on: (name, fn) => { onCalls += 1; handlers[name] = fn; if (name === "message_received") handler = fn; },
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
      return { text: "[batch translation]", model: p.model, usage: { inputTokens: 100, outputTokens: 50 } };
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

console.log("\n— filters —");
await handler({ content: "other channel" }, { channelId: "telegram", conversationId: pluginConfig.groupJid });
await wa("other group", { jid: "999@g.us" });
await wa("", {});
await wa("own message", { metadata: { fromMe: true } });
await wait(250);
check("unrelated messages never reached the model", calls.llm.length === 0);

console.log("\n— deduplication —");
await wa("msg-alpha", { id: "dup-1" });
await wa("msg-alpha", { id: "dup-1" });
await wait(250);
check("duplicate messageId dropped", calls.llm.length === 1);
const firstPrompt = calls.llm[0].messages[0].content;
check("prompt carries the message once", (firstPrompt.match(/msg-alpha/g) || []).length === 1);

console.log("\n— debounce collects a batch —");
calls.llm.length = 0;
await wa("one", { id: "a" }); await wait(30);
await wa("two-from-Miri", { id: "b", sender: "972500000002@s.whatsapp.net" });
check("model not called before the pause", calls.llm.length === 0);
await wait(250);
check("exactly one call after the pause", calls.llm.length === 1);

console.log("\n— context and glossary —");
const p2 = calls.llm[0].messages[0].content;
check("previous batch carried into the context", p2.includes("CONTEXT"));
check("glossary name substituted", p2.includes("Eitan"));
check("second participant recognised", p2.includes("Miri"));
check("system prompt carries the rules", calls.llm[0].systemPrompt.includes("RULES"));
check("target language substituted", calls.llm[0].systemPrompt.includes(pluginConfig.targetLanguage ?? "English"));
check("plugin does not force a model", calls.llm[0].model === undefined);

console.log("\n— maxBatch caps the batch —");
calls.llm.length = 0;
for (const i of [1,2,3,4,5]) await wa(`msg${i}`, { id: `m${i}` });
await wait(400);
const payloadOf = (c) => c.messages[0].content.split("TRANSLATE THESE MESSAGES")[1] ?? "";
const sizes = calls.llm.map(c => (payloadOf(c).match(/msg\d/g) || []).length);
check(`no batch exceeds maxBatch=3 (got ${JSON.stringify(sizes)})`, sizes.every(s => s <= 3));
check("all 5 messages translated", sizes.reduce((a,b)=>a+b,0) === 5);

console.log("\n— a model error must not lose messages —");
calls.llm.length = 0;
let boom = true;
api.runtime.llm.complete = async (p) => {
  calls.llm.push(p);
  if (boom) { boom = false; throw new Error("503 upstream"); }
  return { text: "ok", model: p.model, usage: {} };
};
await wa("important", { id: "keep-1" });
await wait(500);
const retried = calls.llm.some(c => c.messages[0].content.includes("important"));
check("message resent after the failure", calls.llm.length >= 2 && retried);
check("failure logged", calls.log.some(([lvl, m]) => lvl === "error" && String(m).includes("503")));

console.log("\n— a burst of photos must not bloat the message —");
calls.llm.length = 0; calls.log.length = 0;
pluginConfig.maxBatch = 20;              // all 12 photos must land in one batch
pluginConfig.labelsPlural = { image: { icon: "📷", word: "snapshots" } };   // captions come from the user
for (let i = 0; i < 12; i += 1) {
  await wa("<media:image>", { id: `flood-${i}` });
}
await wait(400);
const note = calls.log.map(([, m]) => String(m)).join(" | ");
check("twelve photos collapsed into one line", note.includes("12 snapshots"));
check("no repeated blocks left", !note.includes("📷 image"));
check("caption comes from config, not hardcoded", note.includes("snapshots") && !note.includes("photos"));
pluginConfig.maxBatch = 3;

console.log("\n— time comes from the settings —");
{
  const { formatClock } = await import("./src/format.js");
  const t0 = 1788086845;
  check("time zone is applied", formatClock(t0, { timeZone: "Asia/Jerusalem" }) !== formatClock(t0, { timeZone: "America/New_York" }));
  check("locale format is applied", formatClock(t0, { timeZone: "UTC", locale: "en-US" }).includes("AM") || formatClock(t0, { timeZone: "UTC", locale: "en-US" }).includes("PM"));
  check("a bogus time zone does not break translation", /^\d{2}:\d{2}$/.test(formatClock(t0, { timeZone: "No/Such" })));
}

console.log("\n— conversation registry —");
{
  const { mergeObservations } = await import("./src/registry.js");
  const first = mergeObservations({}, [
    { conversationId: "a@g.us", count: 3, lastSeen: "2026-09-01T10:00:00Z", samples: ["hello"] },
  ], { source: "whatsapp" });
  check("new conversation recorded", first["a@g.us"]?.count === 3);

  const later = mergeObservations(first, [
    { conversationId: "a@g.us", count: 1, lastSeen: "2026-09-10T10:00:00Z", samples: ["more"] },
  ], { source: "whatsapp" });
  check("old samples kept", later["a@g.us"].samples.includes("hello") && later["a@g.us"].samples.includes("more"));
  check("counter did not shrink on a short log", later["a@g.us"].count === 3);
  check("last-seen date updated", later["a@g.us"].lastSeen.startsWith("2026-09-10"));
  check("first-seen date remembered", later["a@g.us"].firstSeen.startsWith("2026-09-01"));
}

console.log("\n— per-route model —");
{
  const { completeForRoute } = await import("./src/models/index.js");

  calls.llm.length = 0;
  await completeForRoute({ route: { name: "no model" }, api, systemPrompt: "s", messages: [] });
  check("without a model we go through OpenClaw", calls.llm.length === 1);

  calls.auth.length = 0;
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: "translated" } }], model: "m", usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  };
  const res = await completeForRoute({
    route: { name: "own model", model: "openrouter/some/model" },
    api, systemPrompt: "s", messages: [{ role: "user", content: "x" }],
  });
  globalThis.fetch = origFetch;

  check("credentials asked from OpenClaw, never stored here", calls.auth[0]?.model?.provider === "openrouter");
  check("model sent without the provider prefix", sent[0]?.body?.model === "some/model");
  check("translation received directly", res.text === "translated");
  check("usage accounted", res.usage.inputTokens === 10 && res.usage.outputTokens === 5);

  let failed;
  try {
    await completeForRoute({ route: { name: "broken", model: "nosuch/model" }, api, messages: [] });
  } catch (err) { failed = err; }
  check("unknown provider yields a clear error", /cannot call provider/.test(String(failed?.message)));
}

console.log("\n— every chat gets its own world —");
{
  const second = "120363222222222222@g.us";
  pluginConfig.routes.push({ jid: second, name: "Second", chatId: "999" });
  pluginConfig.dryRun = false;
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, text: async () => "" }; };

  calls.llm.length = 0;
  await wa("message for the first", { id: "iso-1" });
  await wa("message for the second", { id: "iso-2", jid: second });
  await wait(400);

  check("two chats — two separate model calls", calls.llm.length === 2);
  const a = calls.llm.find((c) => c.messages[0].content.includes("the first"));
  const b = calls.llm.find((c) => c.messages[0].content.includes("the second"));
  check("chats never mixed into one batch", Boolean(a && b) && a !== b);
  check("glossary applied only to its own chat", a.systemPrompt.includes("Eitan") && !b.systemPrompt.includes("Eitan"));
  const chats = sent.map((s) => String(s.chat_id));
  check(`each chat went to its own destination (${chats.join(", ")})`, chats.includes("123456") && chats.includes("999"));

  globalThis.fetch = origFetch;
  pluginConfig.dryRun = true;
  pluginConfig.routes.pop();
}

console.log("\n— we never write back into the watched messenger —");
{
  const out = (target, channel = "whatsapp") =>
    handlers["message_sending"]({ to: target, content: "assistant reply" }, { channelId: channel, conversationId: target });
  check("reply into the watched group cancelled", (await out(MAIN_JID))?.cancel === true);
  check("direct chats blocked too", (await out("972500000009@s.whatsapp.net"))?.cancel === true);
  check("unrelated groups blocked", (await out("120363999999999999@g.us"))?.cancel === true);
  check("translation delivery untouched", !(await out("-100123", "telegram"))?.cancel);
}

console.log("\n— the assistant never runs on watched messages —");
{
  const dispatch = (key) => handlers["before_dispatch"]({ sessionKey: key, content: "x" }, { sessionKey: key });
  await wa("shalom", { id: "agent-1", sessionKey: "wa:watched" });
  check("dispatch suppressed on a watched conversation", (await dispatch("wa:watched"))?.handled === true);
  check("other conversations left alone", !(await dispatch("wa:someone-else"))?.handled);
  await wait(300);
}

console.log("\n— voice messages and images —");
{
  calls.llm.length = 0; calls.stt.length = 0; calls.img.length = 0;
  sttReply = "transcribed speech, second part";
  await wa("<media:audio>", { id: "v-1", mediaPath: "/tmp/a.ogg", mime: "audio/ogg" });
  await wait(350);
  check("voice message sent for transcription", calls.stt.length === 1);
  check("file path passed through", calls.stt[0]?.filePath === "/tmp/a.ogg");
  const voiced = calls.llm[0]?.messages[0].content ?? "";
  check("transcript went into the translation", voiced.includes("second part"));
  check("marked as a voice message", voiced.includes("🎤"));

  calls.llm.length = 0; calls.img.length = 0;
  imgReply = "text lifted off the image";
  await wa("<media:image>", { id: "i-1", mediaPath: "/tmp/x.jpg", mime: "image/jpeg" });
  await wait(350);
  check("image sent for reading", calls.img.length === 1);
  check("text from the image went into the translation", (calls.llm[0]?.messages[0].content ?? "").includes("lifted off the image"));

  calls.llm.length = 0;
  imgReply = "NO_TEXT";
  await wa("<media:image>", { id: "i-2", mediaPath: "/tmp/kids.jpg" });
  await wait(350);
  check("a textless photo never reaches the model", calls.llm.length === 0);

  calls.llm.length = 0;
  const brokenStt = api.runtime.stt.transcribeAudioFile;
  api.runtime.stt.transcribeAudioFile = async () => { throw new Error("stt unavailable"); };
  await wa("<media:audio>", { id: "v-2", mediaPath: "/tmp/b.ogg" });
  await wait(350);
  check("a transcription failure does not lose the message", calls.log.some(([, m]) => String(m).includes("voice message")));
  check("failure reason recorded", calls.log.some(([lvl, m]) => lvl === "warn" && String(m).includes("stt unavailable")));
  api.runtime.stt.transcribeAudioFile = brokenStt;
  sttReply = "";
}

console.log("\n— a network failure loses nothing and never re-translates —");
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
  await wa("net-payload", { id: "net-1" });
  await wait(6500);
  check("translation requested once despite the failures", calls.llm.length === 1);
  check("message delivered in the end", delivered.length === 1);
  globalThis.fetch = origFetch;
  pluginConfig.dryRun = true;
}


console.log("\n— an empty answer from the model must not swallow the batch —");
{
  calls.llm.length = 0;
  const realComplete = api.runtime.llm.complete;
  let firstCall = true;
  api.runtime.llm.complete = async (par) => {
    calls.llm.push(par);
    if (firstCall) { firstCall = false; return { text: "   ", model: par.model, usage: {} }; }
    return { text: "[batch translation]", model: par.model, usage: {} };
  };

  await wa("important-message", { id: "empty-1" });
  await wait(900);

  check("the batch was translated again, not dropped", calls.llm.length === 2);
  check("the original message survived", (calls.llm[1]?.messages[0].content ?? "").includes("lifted off the image"));
  api.runtime.llm.complete = realComplete;
}

console.log("\n— an undelivered translation leaves without waiting for new messages —");
{
  pluginConfig.dryRun = false;
  const delivered = [];
  const origFetch = globalThis.fetch;
  let offline = true;
  globalThis.fetch = async (url, init) => {
    if (offline) throw new Error("telegram is down");   // not retriable: straight to the queue
    delivered.push(JSON.parse(init.body).text);
    return { ok: true, text: async () => "" };
  };

  await wa("queued-message", { id: "queue-1" });
  await wait(500);
  check("the failed delivery went into the queue", delivered.length === 0);

  offline = false;                       // nobody writes in the group any more
  await wait(900);
  check("the queue drained on its own", delivered.length === 1);

  globalThis.fetch = origFetch;
  pluginConfig.dryRun = true;
}

console.log("\n— a permanently rejected message does not wedge the queue —");
{
  pluginConfig.dryRun = false;
  const delivered = [];
  const origFetch = globalThis.fetch;
  const realComplete = api.runtime.llm.complete;
  let answer = "STUCK-A";
  api.runtime.llm.complete = async (par) => { calls.llm.push(par); return { text: answer, model: par.model, usage: {} }; };

  globalThis.fetch = async (url, init) => {
    const text = JSON.parse(init.body).text;
    if (text.includes("STUCK")) return { ok: false, status: 403, text: async () => '{"description":"bot was kicked"}' };
    delivered.push(text);
    return { ok: true, text: async () => "" };
  };

  await wa("aleph", { id: "stuck-1" });
  await wait(500);
  answer = "GOOD-B";
  await wa("bet", { id: "stuck-2" });
  await wait(900);

  check("the message behind the stuck one got through", delivered.some((t) => t.includes("GOOD-B")));
  const setAside = await readFile(join(TEST_DIR, "undeliverable.jsonl"), "utf8").catch(() => "");
  check("the rejected message was set aside, not destroyed", setAside.includes("STUCK-A"));

  api.runtime.llm.complete = realComplete;
  globalThis.fetch = origFetch;
  pluginConfig.dryRun = true;
}

console.log("\n— delivery adapter tells apart a rate limit from a mistake —");
{
  const telegram = (await import("./src/delivery/telegram.js")).default;
  const origFetch = globalThis.fetch;

  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => '{"parameters":{"retry_after":7}}' });
  let rateLimited;
  try { await telegram.sendChunk({ auth: "x", target: "1", text: "y" }); } catch (err) { rateLimited = err; }
  check("429 counts as temporary", rateLimited?.retriable === true);
  check("retry_after is honoured", rateLimited?.retryAfterMs === 7000);

  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "" });
  let rejected;
  try { await telegram.sendChunk({ auth: "x", target: "1", text: "y" }); } catch (err) { rejected = err; }
  check("403 counts as permanent", rejected?.permanent === true);
  check("403 is not retried", rejected?.retriable !== true);

  globalThis.fetch = origFetch;
}

console.log("\n— long text is never cut through a character —");
{
  const { splitForDelivery } = await import("./src/format.js");
  const line = "🎉".repeat(40);
  const parts = splitForDelivery(line, 10);
  const lone = (t) => /[\uD800-\uDBFF]$/.test(t) || /^[\uDC00-\uDFFF]/.test(t);
  check("nothing was lost when splitting", parts.join("") === line);
  check("no piece ends in half a character", !parts.some(lone));
}

console.log("\n— the plugin registers once per process —");
{
  const before = onCalls;
  plugin.register(api);
  check("the second registration is ignored", onCalls === before);
}


console.log("\n— the source adapter owns its channel setup —");
{
  const { resolveSource } = await import("./src/sources/index.js");
  const wa = resolveSource("whatsapp");
  check("the adapter knows how to open its channel", typeof wa.prepareChannel === "function");

  const gatewayCfg = {};
  wa.prepareChannel(gatewayCfg, "120363111111111111@g.us");
  check("the conversation was written into the channel settings",
    gatewayCfg.channels?.whatsapp?.groups?.["120363111111111111@g.us"]?.requireMention === false);

  wa.prepareChannel(gatewayCfg, "120363222222222222@g.us");
  check("an existing conversation is not wiped by the next one",
    Object.keys(gatewayCfg.channels.whatsapp.groups).length === 2);

  check("a bad identifier is recognised", wa.looksLikeConversationId("not-an-id") === false);
}


console.log("\n— a second recipient keeps the same contract —");
{
  const { resolveDelivery, listDeliveries } = await import("./src/delivery/index.js");
  check("two recipients ship", listDeliveries().includes("telegram") && listDeliveries().includes("webhook"));

  const hook = resolveDelivery("webhook");
  check("this one stores no credentials", hook.resolveAuth() === null);
  check("it carries its own size limit", hook.limit !== 4096);

  const origFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true }; };
  await hook.sendChunk({ target: "https://example.com/hook", text: NON_ASCII });
  check("the route address is the URL itself", sent.url === "https://example.com/hook");
  check("Slack and Discord field names both go out", sent.body.text === NON_ASCII && sent.body.content === NON_ASCII);

  let refused;
  try { await hook.sendChunk({ target: "http://insecure.example", text: "x" }); } catch (err) { refused = err; }
  check("a non-https address is refused for good", refused?.permanent === true);

  globalThis.fetch = async () => ({ ok: false, status: 429, headers: { get: () => "3" }, text: async () => "" });
  let limited;
  try { await hook.sendChunk({ target: "https://example.com/hook", text: "x" }); } catch (err) { limited = err; }
  check("429 is temporary here too", limited?.retriable === true && limited?.retryAfterMs === 3000);

  globalThis.fetch = origFetch;
}

console.log("\n— dispose lets the plugin start over —");
{
  plugin.dispose();
  const before = onCalls;
  plugin.register(api);
  check("registration works again after dispose", onCalls > before);
  plugin.dispose();
}

console.log(failures === 0 ? "\nall checks passed\n" : `\nfailed checks: ${failures}\n`);
await (await import("node:fs/promises")).rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
process.exit(failures === 0 ? 0 : 1);

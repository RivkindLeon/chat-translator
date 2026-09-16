# Hebrew Bridge

A translator for chats you cannot read. It watches selected groups in one
messenger, translates the messages and sends them on to another messenger —
each group to its own chat.

It runs as an OpenClaw plugin on your own server. The only thing that leaves the
machine is the request to the model: the conversations themselves, the keys and
the journals stay on the server.

---

## What it does

**Text** — messages pile up in batches and are translated in a single request:
cheaper, fewer notifications, and the model understands better who is replying
to whom.

**Voice messages** — transcribed and translated just like text.

**Photos with text** — announcements, schedules, menus. The text is lifted off
the image and translated with its structure intact: a table stays a table,
grouped by day, instead of collapsing into one run-on line.

**Photos without text** — marked with a line like “📷 image”; the model is not
called.

## What it deliberately does not do

The plugin **never writes anything** back into the watched messenger — not into
groups, not into direct chats. Every attempt to send is cancelled and logged.

The assistant is **never started** on messages from watched groups: only the
translator sees them. So an instruction planted in a chat cannot execute
anything on the server, and no tokens are spent on other people's conversations.

---

## Routes

Every source chat is bound to its own delivery chat: it has its own buffer, its
own context and its own glossary of names, so conversations never mix. The list
of routes lives in the settings, not in the repository.

## What it costs

Practically nothing. Translation, voice transcription and image recognition all
go through a ChatGPT Plus subscription: its tokens are not billed, only the
quota is consumed. After dozens of translations it still shows a full 100%.

Paid models remain the fallback: if the quota runs out, translation does not
stop — it continues through them for a few cents.

Over the whole lifetime of the project less than a tenth of a cent was spent —
on the very first translation, before the switch to the subscription.

---

## Commands

All of them run on the server, in the plugin directory
`~/.openclaw/extensions/hebrew-bridge/`.

```bash
node groups.mjs        # which groups the server has seen, with message fragments
node add-group.mjs <id> "Name" [address] [thread] [--source=… --delivery=…]
node limits.mjs        # remaining subscription quota and the current models
node report.mjs        # spending for the month (2026-09 · all · --days)
node test.mjs          # 53 logic checks
```

Journal: `~/.openclaw/hebrew-bridge/logs/YYYY-MM-DD.log`
Call accounting: `~/.openclaw/hebrew-bridge/usage.jsonl`

---

## Connecting a new group

1. `node groups.mjs` — find the group by its message fragments.
   WhatsApp does not report group names, only identifiers, so they have to be
   recognised by content.
2. Create a chat in Telegram, add the bot to it, and post a message mentioning
   the bot.
3. Find the chat id:
   `grep "skipping group message" /tmp/openclaw/openclaw-*.log`
4. `node add-group.mjs <id> "Name" <address>` — adds it and restarts.
   For a different messenger or destination add `--source=` / `--delivery=`;
   the tool asks the adapter what its channel needs instead of assuming WhatsApp.

If a group is connected after the fact, its recent messages can be caught up on:
temporarily set `replay: {jid, minutes}` in the settings, restart, then remove
it. The depth is limited by the gateway journal, which only lives two days.

---

## Settings

They live in `~/.openclaw/openclaw.json`, section
`plugins.entries.hebrew-bridge.config`.

| Option | Meaning |
|---|---|
| `routes` | the list of routes: `{jid, name, chatId, threadId?, glossary?, ...}` |
| `debounceMs` | silence before a batch is sent, 20 seconds by default |
| `maxWaitMs` | the ceiling on waiting when a chat will not go quiet |
| `maxBatch` | maximum messages in one batch |
| `contextSize` | how many past messages go into the context |
| `glossary` | how to spell names and terms; can be set globally and per route |
| `targetLanguage` | the language to translate into, written in English |
| `sourceLanguage` | the language of the source messages (optional) |
| `source` / `delivery` | which source and delivery adapter to use |
| `model` | a dedicated model, as `provider/model`; without it the agent model is used |
| `timeZone` / `locale` | time zone and format for the message headers |
| `imageProvider` / `imageModel` | what reads text off images |
| `quotaThreshold` | at what remaining quota to warn (percent) |
| `alertChatId` | where to send technical warnings |
| `logTexts` | keep the texts for quality review — for debugging only |

Any route setting overrides the global one: a chatty group can have its own
delay, a work group its own glossary.

---

## Where it stands

The plugin started out written for a single case: WhatsApp in, Telegram out,
Russian hardcoded into the model prompts. Those assumptions have since been
lifted:

1. **Any source** — a “source” layer instead of a hard binding to WhatsApp. The
   most substantial change; it set the shape of everything else.
2. **Any destination** — delivery sits behind its own interface.
3. **Any language pair** — the prompts are generated with the languages
   substituted in.
4. **Settings instead of hardcoded values** — time zone, attachment captions,
   time format.
5. **A persistent group registry** — recognition no longer depends on a journal
   that only lives two days.
6. **A per-route model** — a route can use its own model instead of the one the
   main agent runs on.

Only one source (WhatsApp) and one delivery (Telegram) adapter ship today; the
registries are there so adding another is a new file, not a rewrite.

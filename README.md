# Chat Translator

An [OpenClaw](https://openclaw.ai) plugin that translates chats written in a
language you do not read. It watches selected groups in one messenger, translates
the messages and delivers them to another messenger — each group to its own chat.

It was written for a specific problem: living somewhere whose language you have
not learned, while the chats that actually matter — the parents' group at your
child's school, the building's residents, the municipality, work — all happen in
it. Hence the shape of it: it does not try to be a general-purpose bot, it does
one job.

## What it does

- **text** — messages pile up in batches and are translated in a single request:
  cheaper, fewer notifications, and the model understands better who is replying
  to whom;
- **voice messages** — transcribed and translated just like text;
- **photos with text** — announcements, schedules, menus: the text is lifted off
  the image and translated with its structure intact;
- **photos without text** — collapsed into a line like “12 photos” instead of
  taking up a dozen blocks.

## What it deliberately does not do

The plugin **never writes anything** back into the watched messenger — every
attempt to send is cancelled. The assistant is not started on messages from
watched groups: only the translator sees them. So an instruction planted in a
chat cannot execute anything, and no tokens are spent on other people's
conversations.

## Before you install

This is a plugin, not an app. It needs an [OpenClaw](https://openclaw.ai) gateway
already running on a machine of your own, with the messenger you want to read
linked to it. Four things are easy to get wrong, and each one fails silently:

1. **The source messenger must be linked as a device.** For WhatsApp that means
   pairing a linked device from your phone — the plugin reads what that device
   sees. It never sends anything back.
2. **The channel must hand group messages to plugins.** By default a gateway only
   reacts when it is addressed by name; a group you are merely reading never
   mentions it. `tools/add-group.mjs` sets `requireMention: false` for you.
3. **Turn off automatic replies to strangers.** If your gateway answers unpaired
   senders (`dmPolicy: "pairing"` and the like), it will reply to people in the
   chats you are only translating. Set `dmPolicy: "disabled"` on the source
   channel. This is the most expensive of the four to get wrong: strangers get
   answered on your behalf.
4. **A destination that accepts messages.** Either a Telegram bot plus the chat
   id you want the translations in, or any `https://` webhook URL (Slack,
   Discord, n8n — the address carries its own secret).

If translations never arrive, it is almost always 2 or 3.

## Install

```bash
git clone https://github.com/RivkindLeon/chat-translator ~/projects/chat-translator
cd ~/projects/chat-translator
./deploy.sh
```

`deploy.sh` runs the tests, copies the plugin into the gateway's extensions
folder, restarts it, and rolls back if the plugin does not load. It assumes a
systemd user service; every path and the restart command can be overridden:

```bash
OPENCLAW_EXTENSIONS=~/.openclaw/extensions \
OPENCLAW_RESTART_CMD="pm2 restart openclaw" \
OPENCLAW_LOG_DIR=/var/log/openclaw \
./deploy.sh
```

Then connect a chat:

```bash
node tools/groups.mjs                              # what the server has seen
node tools/add-group.mjs <id> "Name" <address>     # connect one
```

Set the language once, in the plugin config:

```json
{ "targetLanguage": "English", "sourceLanguage": "Portuguese", "ownerName": "Sam" }
```

## Tools

```bash
node tools/groups.mjs     # which groups the server has seen, with message fragments
node tools/add-group.mjs <id> "Name" <address> [--source=… --delivery=…]
node tools/limits.mjs     # remaining subscription quota
node tools/report.mjs     # spending for the month
```

## Documentation

- `DOC.md` — how it works, settings, connecting new groups.

## Status

Running in a personal setup across several groups.

The decoupling work is done: the messenger it reads, the place it delivers to,
the language pair and the presentation all come from settings rather than from
the code. One source adapter (WhatsApp) and two delivery adapters (Telegram and a generic
webhook) ship today — adding another means writing a file in `src/sources/` or
`src/delivery/`, not editing the engine.

What that does not yet cover: only one source adapter exists, so the input side
of the interface is reasonable rather than proven, and the install still assumes
an OpenClaw gateway you run yourself.

## License

MIT — see `LICENSE`.

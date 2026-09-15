# Hebrew Bridge

An [OpenClaw](https://openclaw.ai) plugin that translates chats written in a
language you do not read. It watches selected groups in one messenger, translates
the messages and delivers them to another messenger — each group to its own chat.

It was written for a specific problem: kindergarten parent chats, building chats
and municipal announcements in Hebrew that the owner cannot read. Hence the shape
of it: it does not try to be a general-purpose bot, it does one job.

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

## Install

```bash
git clone <repository> ~/projects/hebrew-bridge
cd ~/projects/hebrew-bridge
./deploy.sh
```

`deploy.sh` runs the tests, copies the plugin into `~/.openclaw/extensions/` and
restarts the gateway.

## Tools

```bash
node tools/groups.mjs     # which groups the server has seen, with message fragments
node tools/add-group.mjs <JID> "Name" <chatId>
node tools/limits.mjs     # remaining subscription quota
node tools/report.mjs     # spending for the month
```

## Documentation

- `DOC.md` — how it works, settings, connecting new groups.

## Status

Running in a personal setup across several groups. Work is under way to make it
usable by other people: decoupling from a specific messenger on both the input
and the output side, an arbitrary language pair, settings instead of hardcoded
values.

## License

MIT — see `LICENSE`.

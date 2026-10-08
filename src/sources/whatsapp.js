import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { extractMediaFile } from "../media.js";

/**
 * The WhatsApp source.
 *
 * Holds the three things the rest of the plugin should not know: how to
 * subscribe to this channel's incoming messages, what its attachments look
 * like, and how to forbid writing into it.
 */
/** The line OpenClaw 2026.9 puts in front of a media message instead of a placeholder. */
const ENVELOPE = /^\[WhatsApp [^\]\n]*\][^\n:]*:\s*/;

export default {
  id: "whatsapp",
  channelId: "whatsapp",

  /** What a conversation identifier looks like here, for the sake of typos. */
  looksLikeConversationId: (id) => /@g\.us$/.test(id),

  /** An example to print when the identifier does not look right. */
  conversationIdExample: "120363000000000000@g.us",

  /**
   * Makes the gateway hand this conversation's messages to plugins at all.
   * Every messenger gates that differently, so the knowledge belongs here and
   * not in the tool that connects a chat.
   */
  prepareChannel(gatewayConfig, conversationId) {
    gatewayConfig.channels ??= {};
    gatewayConfig.channels.whatsapp ??= {};
    gatewayConfig.channels.whatsapp.groups ??= {};
    gatewayConfig.channels.whatsapp.groups[conversationId] = { requireMention: false };
  },

  /**
   * Subscribes to incoming messages and hands them over in a normalised shape.
   *
   * @param api        the OpenClaw plugin object
   * @param isWatched  (conversationId) => boolean — do we read this conversation
   * @param wantsOwnMessages (conversationId) => boolean — does it also want ours
   * @param onMessage  (msg) => void — a normalised message
   * @param log,journal,debug — output
   */
  attach({ api, isWatched, wantsOwnMessages, onMessage, log, journal, debug }) {
    api.on("message_received", async (event, ctx) => {
      try {
        if (debug?.()) {
          log.info?.(
            `[chat-translator][hook:message_received] channel=${ctx?.channelId} ` +
            `conv=${ctx?.conversationId} from=${event?.from} len=${(event?.content ?? "").length}`
          );
        }
        if (ctx.channelId !== "whatsapp") return;

        const conversationId = ctx.conversationId ?? event.from ?? "";
        if (!isWatched(conversationId)) return;

        // In a chat we only read, our own messages are noise. In a scratchpad
        // conversation they are the whole point — that is what gets forwarded there.
        if (event.metadata?.fromMe === true && !wantsOwnMessages?.(conversationId)) return;

        const text = (event.content ?? "").trim();
        if (!text) return;

        // OpenClaw 2026.9 hands a photo or a video over as an envelope line —
        // "[WhatsApp <group> +4h Thu 2026-10-08 11:56:50 UTC] Name (+972…):" —
        // with the caption, if there is one, after it. Nobody wrote the envelope:
        // translated, it reached the family as a sender's phone number.
        const body = text.replace(ENVELOPE, "").trim();
        // older hosts substitute a placeholder like <media:image> for the payload
        const media = /^<media:([a-z]+)>\s*/i.exec(body);
        const caption = media ? body.slice(media[0].length).trim() : body;
        const attachment = extractMediaFile(event);
        const mimeKind = /^(audio|image|video)\//i.exec(attachment.mime ?? "")?.[1]?.toLowerCase();
        const mediaKind = media?.[1]?.toLowerCase() ?? attachment.kind ?? mimeKind;
        if (!mediaKind && !caption) return;

        onMessage({
          conversationId,
          sessionKey: ctx.sessionKey ?? event.sessionKey,
          messageId: event.messageId ?? ctx.messageId,
          timestamp: event.timestamp,
          senderId: event.senderId ?? event.from,
          senderName:
            event.metadata?.pushName ??
            event.metadata?.senderName ??
            event.metadata?.notifyName,
          replyToBody: event.replyToBody,
          // A caption is what the sender wrote — it gets translated; the
          // attachment without one becomes a short note ("📷 3 photos").
          // A voice note never has a caption, so whatever text came with it is
          // envelope we failed to recognise — it must not shadow the recording.
          ...(mediaKind && (!caption || mediaKind === "audio")
            ? { kind: "media", mediaKind, mediaPath: attachment.path, mime: attachment.mime }
            : { kind: "text", text: caption, ...(mediaKind ? { captionOf: mediaKind } : {}) }),
        });
      } catch (err) {
        log.error?.(`[chat-translator] handler failed: ${err?.message ?? err}`);
        void journal("error", `handler failed: ${err?.message ?? err}`);
      }
    });
  },

  /**
   * Guard rails: we only ever read from here.
   *
   * The plugin cancels every outgoing message to this channel and keeps the
   * assistant from running on watched conversations — otherwise it answers
   * strangers on behalf of the number's owner and spends tokens on other
   * people's chatter.
   */
  guard({ api, isWatchedSession, muteOutbound, blockAgent, log, journal }) {
    api.on("before_dispatch", async (event, ctx) => {
      try {
        if (!blockAgent()) return;
        const key = event?.sessionKey ?? ctx?.sessionKey;
        if (!key || !isWatchedSession(key)) return;
        log.info?.("[chat-translator] agent run suppressed for a watched conversation");
        return { handled: true };
      } catch (err) {
        log.error?.(`[chat-translator] agent guard failed: ${err?.message ?? err}`);
        void journal("error", `agent guard failed: ${err?.message ?? err}`);
      }
    });

    api.on("message_sending", async (event, ctx) => {
      try {
        if (ctx.channelId !== "whatsapp") return;
        if (!muteOutbound()) return;
        const target = ctx.conversationId ?? event.to ?? "(unknown)";
        const preview = String(event.content ?? "").slice(0, 80).replace(/\s+/g, " ");
        log.info?.(`[chat-translator] outgoing WhatsApp message cancelled: ${target}`);
        void journal("warn", `cancelled outgoing WhatsApp message → ${target}: "${preview}"`);
        return { cancel: true, cancelReason: "chat-translator: read-only" };
      } catch (err) {
        log.error?.(`[chat-translator] outbound guard failed: ${err?.message ?? err}`);
        void journal("error", `outbound guard failed: ${err?.message ?? err}`);
      }
    });
  },

  /**
   * Finds this messenger's conversations in the gateway log.
   *
   * This is the only way to learn which groups exist at all: the messenger
   * reports no names, and events from unconnected conversations never reach
   * the plugin. The gateway log lives a couple of days, so what is seen is
   * copied into our own registry.
   */
  async discover({ logDir = "/tmp/openclaw", maxFiles = 3 } = {}) {
    let files = [];
    try {
      files = (await readdir(logDir))
        .filter((f) => f.startsWith("openclaw-") && f.endsWith(".log"))
        .sort()
        .slice(-maxFiles);
    } catch {
      return [];
    }

    const found = new Map();
    for (const file of files) {
      let text = "";
      try {
        text = await readFile(join(logDir, file), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.includes("@g.us")) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const info = row?.["1"];
        const from = typeof info === "object" ? info?.from : undefined;
        if (typeof from !== "string" || !from.endsWith("@g.us")) continue;

        const seen = found.get(from) ?? { conversationId: from, count: 0, lastSeen: "", samples: [] };
        seen.count += 1;
        const at = row?.time ?? "";
        if (at > seen.lastSeen) seen.lastSeen = at;

        // the snippet only exists so a human can recognise their own group
        let body = String(info?.body ?? "").replace(/\s+/g, " ").trim();
        // the gateway's own wrappers are no help in recognising anything
        if (/^\[[A-Za-z]+\s/.test(body)) body = "";
        const media = /^<media:(\w+)>$/.exec(body);
        if (media) body = `(${media[1]})`;
        if (body && seen.samples.length < 3 && !seen.samples.includes(body)) {
          seen.samples.push(body.slice(0, 60));
        }
        found.set(from, seen);
      }
    }
    return [...found.values()];
  },
};

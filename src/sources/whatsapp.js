import { extractMediaFile } from "../media.js";

/**
 * Источник «WhatsApp».
 *
 * Знает три вещи, которых не должен знать остальной плагин: как подписаться на
 * входящие этого канала, как выглядят его вложения и как запретить запись в него.
 */
export default {
  id: "whatsapp",
  channelId: "whatsapp",

  /**
   * Подписывается на входящие и отдаёт их в нормализованном виде.
   *
   * @param api        объект плагина OpenClaw
   * @param isWatched  (conversationId) => boolean — читаем ли эту беседу
   * @param onMessage  (msg) => void — нормализованное сообщение
   * @param log,journal,debug — вывод
   */
  attach({ api, isWatched, onMessage, log, journal, debug }) {
    api.on("message_received", async (event, ctx) => {
      try {
        if (debug?.()) {
          log.info?.(
            `[hebrew-bridge][hook:message_received] channel=${ctx?.channelId} ` +
            `conv=${ctx?.conversationId} from=${event?.from} len=${(event?.content ?? "").length}`
          );
        }
        if (ctx.channelId !== "whatsapp") return;

        const conversationId = ctx.conversationId ?? event.from ?? "";
        if (!isWatched(conversationId)) return;

        // свои же сообщения переводить незачем
        if (event.metadata?.fromMe === true) return;

        const text = (event.content ?? "").trim();
        if (!text) return;

        // канал подставляет заглушку вида <media:image> вместо содержимого
        const media = /^<media:([a-z]+)>$/i.exec(text);
        const attachment = media ? extractMediaFile(event) : {};

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
          ...(media
            ? { kind: "media", mediaKind: media[1].toLowerCase(), mediaPath: attachment.path, mime: attachment.mime }
            : { kind: "text", text }),
        });
      } catch (err) {
        log.error?.(`[hebrew-bridge] сбой в обработчике: ${err?.message ?? err}`);
        void journal("error", `сбой в обработчике: ${err?.message ?? err}`);
      }
    });
  },

  /**
   * Защита: мы отсюда только читаем.
   *
   * Плагин отменяет любое исходящее в этот канал и не даёт ассистенту
   * запускаться на сообщениях читаемых бесед — иначе он отвечает незнакомым
   * людям от имени владельца номера и тратит токены на чужую переписку.
   */
  guard({ api, isWatchedSession, muteOutbound, blockAgent, log, journal }) {
    api.on("before_dispatch", async (event, ctx) => {
      try {
        if (!blockAgent()) return;
        const key = event?.sessionKey ?? ctx?.sessionKey;
        if (!key || !isWatchedSession(key)) return;
        log.info?.("[hebrew-bridge] запуск агента подавлен для наблюдаемой сессии");
        return { handled: true };
      } catch (err) {
        log.error?.(`[hebrew-bridge] сбой блокировки агента: ${err?.message ?? err}`);
        void journal("error", `сбой блокировки агента: ${err?.message ?? err}`);
      }
    });

    api.on("message_sending", async (event, ctx) => {
      try {
        if (ctx.channelId !== "whatsapp") return;
        if (!muteOutbound()) return;
        const target = ctx.conversationId ?? event.to ?? "(неизвестно)";
        const preview = String(event.content ?? "").slice(0, 80).replace(/\s+/g, " ");
        log.info?.(`[hebrew-bridge] исходящее в WhatsApp отменено: ${target}`);
        void journal("warn", `отменено исходящее в WhatsApp → ${target}: "${preview}"`);
        return { cancel: true, cancelReason: "hebrew-bridge: только чтение" };
      } catch (err) {
        log.error?.(`[hebrew-bridge] сбой глушилки: ${err?.message ?? err}`);
        void journal("error", `сбой глушилки: ${err?.message ?? err}`);
      }
    });
  },
};

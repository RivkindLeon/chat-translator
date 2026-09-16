import { appendFile, mkdir, readdir, unlink, stat, readFile, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

/**
 * Hebrew Bridge — an OpenClaw plugin.
 *
 * Reads chosen conversations, accumulates messages into batches, translates a
 * batch with a single model call and delivers the result elsewhere.
 *
 * Principles:
 *  - never write into the source messenger, only read;
 *  - deliver strictly to addresses named in the settings;
 *  - batch rather than message-by-message: cheaper, better, quieter.
 */

import { DEFAULTS, resolveRoutes } from "./src/config.js";
import { DEFAULT_PRICES, estimateCostUsd, normalizeModelKey } from "./src/pricing.js";
import { buildImageTextPrompt, buildTranslationPrompt, renderMessagesForPrompt } from "./src/prompts.js";
import { MEDIA_LABELS, MEDIA_PLURAL, renderMediaNotes, extractMediaFile } from "./src/media.js";
import { splitForDelivery, formatClock, resolveSenderLabel } from "./src/format.js";
import { resolveSource, listSources } from "./src/sources/index.js";
import { loadRegistry, saveRegistry, mergeObservations, registryPath } from "./src/registry.js";
import { deliverText } from "./src/delivery/index.js";
import { completeForRoute } from "./src/models/index.js";

// The gateway registers the plugin twice on a restart. Module scope is shared
// between those calls (ESM caches the module), so a flag here is what stops the
// second copy from raising its own timers, hooks and buffers — two independent
// deduplicators cannot see each other, and every message goes out twice.
let registered = false;

export default {
  id: "hebrew-bridge",
  name: "Hebrew Bridge",
  description: "Translates a watched chat into your language and forwards it to a destination",

  register(api) {
    if (registered) {
      try {
        api.runtime.logging.getChildLogger({ plugin: "hebrew-bridge" })
          .warn?.("[hebrew-bridge] register() called twice in one process — ignoring the second call");
      } catch { /* logging is optional */ }
      return;
    }
    registered = true;

    let log;
    try {
      log = api.runtime.logging.getChildLogger({ plugin: "hebrew-bridge" });
    } catch {
      log = console;
    }

    const dataDir = () =>
      readConfig().dataDir ?? join(homedir(), ".openclaw", "hebrew-bridge");

    let dirsReady = false;
    const ensureDirs = async () => {
      if (dirsReady) return;
      await mkdir(join(dataDir(), "logs"), { recursive: true });
      await mkdir(join(dataDir(), "samples"), { recursive: true });
      dirsReady = true;
    };

    /** Our own journal: a lasting folder, one file per day, old ones pruned. */
    const journal = async (level, message) => {
      try {
        await ensureDirs();
        const now = new Date();
        const day = now.toISOString().slice(0, 10);
        const line = `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`;
        await appendFile(join(dataDir(), "logs", `${day}.log`), line, "utf8");
      } catch {
        // journalling must never break a translation
      }
    };

    /** Text samples, so translation quality can be judged rather than guessed. */
    const sample = async (label, text) => {
      if (readConfig().logTexts !== true) return;
      try {
        await ensureDirs();
        const day = new Date().toISOString().slice(0, 10);
        const body = `\n===== ${new Date().toISOString()} · ${label} =====\n${text}\n`;
        await appendFile(join(dataDir(), "samples", `${day}.log`), body, "utf8");
      } catch {
        // samples are not critical
      }
    };

    /** One line per paid call — the monthly bill is added up from these. */
    const recordUsage = async (entry) => {
      try {
        await ensureDirs();
        const row = { ts: new Date().toISOString(), ...entry };
        await appendFile(join(dataDir(), "usage.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
      } catch (err) {
        void journal("warn", `could not record usage: ${err?.message ?? err}`);
      }
    };

    /**
     * Prunes old journals; usage records stay, they are the accounting trail.
     * `samples/` is pruned on a much shorter clock: it holds other people's
     * conversations verbatim, so it is the one folder that must not accumulate.
     */
    const pruneLogs = async () => {
      const cfg = readConfig();
      const sweep = async (folder, days) => {
        try {
          const dir = join(dataDir(), folder);
          const cutoff = Date.now() - days * 86_400_000;
          for (const name of await readdir(dir)) {
            const file = join(dir, name);
            const info = await stat(file);
            if (info.mtimeMs < cutoff) await unlink(file);
          }
        } catch {
          // the folder may not exist yet
        }
      };
      await sweep("logs", cfg.logRetentionDays ?? 60);
      await sweep("samples", cfg.sampleRetentionDays ?? 7);
    };

    const readConfig = () => {
      const raw = (api.pluginConfig && typeof api.pluginConfig === "object") ? api.pluginConfig : {};
      return { ...DEFAULTS, ...raw };
    };

    const readGatewayConfig = () => {
      try {
        return api.runtime.config?.current?.() ?? {};
      } catch {
        return {};
      }
    };

    // ---- in-memory state ----------------------------------------------------

    const observedSessions = new Set();  // sessionKeys of conversations we watch

    /** Every conversation gets its own world: buffer, context and timers. */
    const worlds = new Map();
    const worldOf = (jid) => {
      let w = worlds.get(jid);
      if (!w) {
        w = {
          pending: [],
          recentContext: [],
          seenIds: new Set(),
          undelivered: [],
          failures: 0,          // consecutive failed flushes — drives the backoff
          debounceTimer: null,
          hardTimer: null,
          flushing: false,
        };
        worlds.set(jid, w);
      }
      return w;
    };

    // ---- the buffer survives a restart ----------------------------------
    const stateFile = () => join(dataDir(), "pending.json");
    let saveTimer = null;

    /** Written atomically: to a temporary file first, then renamed. */
    const saveState = async () => {
      try {
        await ensureDirs();
        const dump = {};
        for (const [jid, w] of worlds) {
          if (w.pending.length === 0 && w.undelivered.length === 0) continue;
          dump[jid] = {
            pending: w.pending,
            undelivered: w.undelivered,
            recentContext: w.recentContext.slice(-10),
          };
        }
        const tmp = `${stateFile()}.tmp`;
        await writeFile(tmp, JSON.stringify(dump), "utf8");
        await rename(tmp, stateFile());
      } catch (err) {
        void journal("warn", `could not save the buffer: ${err?.message ?? err}`);
      }
    };

    /** At most once a second — no reason to touch the disk per message. */
    const scheduleSave = () => {
      if (saveTimer) return;
      saveTimer = setTimeout(() => { saveTimer = null; void saveState(); }, 1000);
      if (typeof saveTimer.unref === "function") saveTimer.unref();
    };

    /** On startup, pick up whatever was left unprocessed before the restart. */
    const restoreState = async () => {
      let dump;
      try {
        dump = JSON.parse(await readFile(stateFile(), "utf8"));
      } catch {
        return;   // no file is the normal case
      }
      const routes = resolveRoutes(readConfig());
      let restored = 0;
      for (const [jid, saved] of Object.entries(dump ?? {})) {
        const route = routes.find((r) => r.jid === jid);
        if (!route) continue;   // the conversation was disconnected while we were down
        const w = worldOf(jid);
        w.pending.push(...(saved.pending ?? []));
        w.undelivered.push(...(saved.undelivered ?? []));
        w.recentContext.push(...(saved.recentContext ?? []));
        restored += (saved.pending?.length ?? 0) + (saved.undelivered?.length ?? 0);
        if (w.pending.length > 0 || w.undelivered.length > 0) scheduleFlush(route);
      }
      if (restored > 0) void journal("info", `restored ${restored} message(s) after restart`);
    };

    /** Re-sends what was translated but never delivered; the model is not called again. */
    const flushUndelivered = async (route, w) => {
      while (w.undelivered.length > 0) {
        try {
          await deliver(w.undelivered[0], route);
          w.undelivered.shift();
        } catch (err) {
          // A permanent rejection (bot removed, address changed) would otherwise
          // wedge the head of the queue forever and everything behind it with it.
          // Set that one message aside on disk and carry on with the rest.
          if (err?.permanent === true) {
            const dropped = w.undelivered.shift();
            await setAside(route, dropped, err);
            continue;
          }
          void journal("warn", `[${route.name}] delivery queue waiting (${w.undelivered.length}): ${err?.message ?? err}`);
          return;
        }
      }
    };

    /** Nothing paid for is ever destroyed: it goes to a file we can read later. */
    const setAside = async (route, text, err) => {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        route: route.name,
        chatId: route.chatId ?? null,
        reason: String(err?.message ?? err).slice(0, 300),
        text,
      });
      try {
        await ensureDirs();
        await appendFile(join(dataDir(), "undeliverable.jsonl"), `${line}\n`, "utf8");
      } catch (writeErr) {
        void journal("error", `could not set the message aside: ${writeErr?.message ?? writeErr}`);
      }
      const msg = `[${route.name}] delivery permanently rejected, message set aside in undeliverable.jsonl: ${String(err?.message ?? err).slice(0, 120)}`;
      log.error?.(`[hebrew-bridge] ${msg}`);
      void journal("error", msg);
    };

    const clearTimers = (w) => {
      if (w.debounceTimer) { clearTimeout(w.debounceTimer); w.debounceTimer = null; }
      if (w.hardTimer) { clearTimeout(w.hardTimer); w.hardTimer = null; }
    };

    /** Delivers a translation along its route; in dry-run mode only journals it. */
    async function deliver(text, route) {
      const cfg = readConfig();
      if (cfg.dryRun) {
        log.info?.(`[hebrew-bridge] dry run, delivery skipped:\n${text}`);
        return;
      }
      await deliverText({ text, route, gatewayConfig: readGatewayConfig(), log, journal });
    }

    async function enrichMedia(items, route) {
      const cfg = readConfig();
      const gatewayCfg = readGatewayConfig();
      const mediaModel = (provider, model) =>
        provider ? { activeModel: { provider, ...(model ? { model } : {}) } } : {};

      for (const item of items) {
        if (item.kind !== "media" || !item.mediaPath) continue;

        try {
          if (item.mediaKind === "audio" && cfg.transcribeVoice !== false) {
            const res = await api.runtime.stt.transcribeAudioFile({
              filePath: item.mediaPath,
              cfg: gatewayCfg,
              ...(item.mime ? { mime: item.mime } : {}),
              ...mediaModel(cfg.audioProvider, cfg.audioModel),
              language: cfg.audioLanguage ?? "he",
            });
            const text = (res?.text ?? "").trim();
            const u = res?.usage ?? {};
            void recordUsage({
              kind: "stt",
              route: route.name,
              provider: res?.provider ?? cfg.audioProvider ?? null,
              model: res?.model ?? cfg.audioModel ?? null,
              inputTokens: u.inputTokens ?? null,
              outputTokens: u.outputTokens ?? null,
              costUsd: estimateCostUsd(res?.model, u.inputTokens, u.outputTokens, cfg.prices) ?? null,
              chars: text.length,
              ok: Boolean(text),
            });
            if (text) {
              item.kind = "text";
              item.text = text;
              item.prefix = "🎤";
              const msg = `[${route.name}] voice transcribed (${text.length} chars), provider=${res?.provider ?? "?"} model=${res?.model ?? "?"}`;
              log.info?.(`[hebrew-bridge] ${msg}`);
              void journal("info", msg);
              void sample("voice transcript", text);
            }
          } else if (item.mediaKind === "image" && cfg.readImages !== false) {
            // describeImageFile skips the job on its own ("primary model supports vision
            // natively"), so with an explicit model we call the forcing variant.
            const res = (cfg.imageProvider && cfg.imageModel)
              ? await api.runtime.mediaUnderstanding.describeImageFileWithModel({
                  filePath: item.mediaPath,
                  cfg: gatewayCfg,
                  ...(item.mime ? { mime: item.mime } : {}),
                  provider: cfg.imageProvider,
                  model: cfg.imageModel,
                  prompt: buildImageTextPrompt(route),
                  maxTokens: 1500,
                  timeoutMs: cfg.imageTimeoutMs ?? 120_000,
                })
              : await api.runtime.mediaUnderstanding.describeImageFile({
                  filePath: item.mediaPath,
                  cfg: gatewayCfg,
                  ...(item.mime ? { mime: item.mime } : {}),
                  prompt: buildImageTextPrompt(route),
                });
            const text = (res?.text ?? "").trim();
            const iu = res?.usage ?? {};
            void recordUsage({
              kind: "image",
              route: route.name,
              provider: res?.provider ?? cfg.imageProvider ?? null,
              model: res?.model ?? cfg.imageModel ?? null,
              inputTokens: iu.inputTokens ?? null,
              outputTokens: iu.outputTokens ?? null,
              costUsd: estimateCostUsd(res?.model ?? cfg.imageModel, iu.inputTokens, iu.outputTokens, cfg.prices) ?? null,
              chars: text.length,
              ok: Boolean(text) && !/^NO_TEXT$/i.test(text),
            });
            if (text && !/^NO_TEXT$/i.test(text)) {
              item.kind = "text";
              item.text = text;
              item.prefix = "📷";
              const msg = `[${route.name}] text read from image (${text.length} chars), provider=${res?.provider ?? "?"} model=${res?.model ?? cfg.imageModel ?? "?"}`;
              log.info?.(`[hebrew-bridge] ${msg}`);
              void journal("info", msg);
              void sample(`image text · ${res?.model ?? cfg.imageModel}`, text);
            } else {
              // usually this means the model cannot read images at all
              const miss =
                `[${route.name}] no text read from image: reply="${String(res?.text ?? "").slice(0, 60)}" ` +
                `provider=${res?.provider ?? "?"} model=${res?.model ?? cfg.imageModel ?? "?"}`;
              log.warn?.(`[hebrew-bridge] ${miss}`);
              void journal("warn", miss);
            }
          }
        } catch (err) {
          // if it fails, the plain marker remains and nothing is lost
          const msg = `[${route.name}] ${item.mediaKind}: processing failed (${err?.message ?? err})`;
          log.warn?.(`[hebrew-bridge] ${msg}`);
          void journal("warn", msg);
        }
      }
    }

    async function flush(route) {
      const w = worldOf(route.jid);
      if (w.flushing) return;
      // Undelivered translations are already paid for. Leaving them behind an
      // "is there anything new?" check meant they sat on disk until someone
      // happened to write in the group again.
      if (w.pending.length === 0 && w.undelivered.length === 0) return;
      w.flushing = true;
      clearTimers(w);

      const cfg = readConfig();

      await flushUndelivered(route, w);

      if (w.pending.length === 0) {
        w.flushing = false;
        void saveState();
        if (w.undelivered.length > 0) scheduleFlush(route);
        return;
      }

      const batch = w.pending.splice(0, route.maxBatch);
      await enrichMedia(batch, route);

      const textItems = batch.filter((m) => m.kind !== "media");
      const mediaItems = batch.filter((m) => m.kind === "media");
      const mediaLines = renderMediaNotes(mediaItems, route.labels, route.labelsPlural);

      try {
        if (textItems.length === 0) {
          if (mediaLines.length > 0) {
            try {
              await deliver(mediaLines.join("\n\n"), route);
            } catch (err) {
              w.undelivered.push(mediaLines.join("\n\n"));
              void journal("error", `[${route.name}] delivery failed: ${err?.message ?? err}`);
            }
          }
          w.recentContext.push(...batch);
          while (w.recentContext.length > route.contextSize) w.recentContext.shift();
          return;
        }

        const contextBlock = w.recentContext.length
          ? `CONTEXT (already translated messages, earlier in the feed)\n${renderMessagesForPrompt(w.recentContext)}\n\n`
          : "";
        const userContent = `${contextBlock}TRANSLATE THESE MESSAGES\n${renderMessagesForPrompt(textItems)}`;

        const result = await completeForRoute({
          route,
          api,
          gatewayConfig: readGatewayConfig(),
          systemPrompt: buildTranslationPrompt(route),
          messages: [{ role: "user", content: userContent }],
          maxTokens: 2000,
          temperature: 0.2,
          purpose: `hebrew-bridge: batch translation (${route.name})`,
        });

        const translated = (result?.text ?? "").trim();
        if (!translated) {
          // The batch was already cut out of the queue. Without putting it back
          // the messages are gone for good — and an empty answer is routine
          // (a max_tokens cut-off, a refusal, a content filter).
          w.pending.unshift(...batch);
          w.failures += 1;
          void journal("warn", `[${route.name}] the model returned nothing, batch put back (attempt ${w.failures})`);
          return;
        }

        void sample(
          `translation · ${route.name} · ${result?.model ?? "?"}`,
          `--- SOURCE ---\n${renderMessagesForPrompt(textItems)}\n\n--- TRANSLATION ---\n${translated}`
        );

        const payload = [translated, ...mediaLines].join("\n\n");
        try {
          await deliver(payload, route);
        } catch (err) {
          w.undelivered.push(payload);
          void journal("error", `[${route.name}] delivery failed, queued: ${err?.message ?? err}`);
        }

        w.failures = 0;
        w.recentContext.push(...batch);
        while (w.recentContext.length > route.contextSize) w.recentContext.shift();

        const usage = result?.usage ?? {};
        const inTok = usage.inputTokens ?? usage.promptTokens;
        const outTok = usage.outputTokens ?? usage.completionTokens;
        const cost = estimateCostUsd(result?.model, inTok, outTok, cfg.prices);
        const summary =
          `[${route.name}] translated ${textItems.length} message(s) (+${mediaItems.length} attachment notes), ` +
          `model ${result?.model ?? "?"}, tokens in=${inTok ?? "?"} out=${outTok ?? "?"}` +
          (cost !== undefined ? `, ≈$${cost.toFixed(6)}` : "");
        log.info?.(`[hebrew-bridge] ${summary}`);
        void journal("info", summary);
        void recordUsage({
          kind: "translate",
          route: route.name,
          provider: result?.provider,
          model: result?.model,
          inputTokens: inTok ?? null,
          outputTokens: outTok ?? null,
          costUsd: cost ?? null,
          messages: textItems.length,
          mediaNotes: mediaItems.length,
        });
      } catch (err) {
        w.pending.unshift(...batch);
        w.failures += 1;
        log.error?.(`[hebrew-bridge] [${route.name}] translation failed: ${err?.message ?? err}`);
        void journal("error", `[${route.name}] translation failed: ${err?.message ?? err}`);
      } finally {
        w.flushing = false;
        void saveState();
        if (w.pending.length > 0 || w.undelivered.length > 0) scheduleFlush(route);
      }
    }

    const MAX_RETRY_DELAY_MS = 30 * 60_000;

    /**
     * Normally the batch leaves after a pause in the conversation. After a
     * failure the pause doubles each time, up to half an hour: a provider that
     * is down for an hour used to mean ~180 identical attempts, each of which
     * re-ran the transcription of whatever voice message failed with it.
     */
    function retryDelay(route, w) {
      if (w.failures === 0) return route.debounceMs;
      return Math.min(route.debounceMs * 2 ** Math.min(w.failures, 8), MAX_RETRY_DELAY_MS);
    }

    function scheduleFlush(route) {
      const w = worldOf(route.jid);
      const delay = retryDelay(route, w);
      if (w.debounceTimer) clearTimeout(w.debounceTimer);
      w.debounceTimer = setTimeout(() => { void flush(route); }, delay);
      if (!w.hardTimer && w.failures === 0) {
        w.hardTimer = setTimeout(() => { void flush(route); }, route.maxWaitMs);
      }
      // A full batch normally goes out at once — but not while we are backing off.
      if (w.failures === 0 && w.pending.length >= route.maxBatch) void flush(route);
    }

    // ---- message intake ------------------------------------------------------
    /** A message arrived from a watched conversation — put it into that world's buffer. */
    function handleIncoming(msg) {
      try {
        const cfg = readConfig();
        const route = resolveRoutes(cfg).find((r) => r.jid === msg.conversationId);
        if (!route) return;

        if (msg.sessionKey) {
          observedSessions.add(msg.sessionKey);
          if (observedSessions.size > 200) {
            observedSessions.delete(observedSessions.values().next().value);
          }
        }

        const w = worldOf(route.jid);
        if (msg.messageId) {
          if (w.seenIds.has(msg.messageId)) return;
          w.seenIds.add(msg.messageId);
          if (w.seenIds.size > 500) w.seenIds.delete(w.seenIds.values().next().value);
        }

        const base = {
          sender: resolveSenderLabel(msg, route.glossary),
          clock: formatClock(msg.timestamp, { timeZone: route.timeZone, locale: route.locale }),
          replyToBody: msg.replyToBody ? String(msg.replyToBody).slice(0, 120) : "",
        };

        if (msg.kind === "media") {
          w.pending.push({ ...base, kind: "media", mediaKind: msg.mediaKind, mediaPath: msg.mediaPath, mime: msg.mime, text: "" });
          if (!msg.mediaPath) {
            const miss = `[${route.name}] attachment without a file path (${msg.mediaKind})`;
            log.warn?.(`[hebrew-bridge] ${miss}`);
            void journal("warn", miss);
          } else {
            void journal("info", `[${route.name}] media received ${msg.mediaKind}: ${msg.mediaPath}`);
          }
        } else {
          w.pending.push({ ...base, kind: "text", text: msg.text });
        }

        scheduleFlush(route);
        scheduleSave();
      } catch (err) {
        log.error?.(`[hebrew-bridge] intake failed: ${err?.message ?? err}`);
        void journal("error", `intake failed: ${err?.message ?? err}`);
      }
    }

    // Attach the sources named by the routes: each one knows how to listen to its
    // own messenger, what its attachments look like and how to keep us read-only.
    {
      const cfg = readConfig();
      const ids = [...new Set(resolveRoutes(cfg).map((r) => r.source ?? "whatsapp"))];
      const watchedJids = () => new Set(resolveRoutes(readConfig()).map((r) => r.jid));
      for (const id of ids) {
        const source = resolveSource(id);
        if (!source) {
          void journal("error", `unknown source "${id}"; available: ${listSources().join(", ")}`);
          continue;
        }
        source.attach({
          api,
          isWatched: (conversationId) => watchedJids().has(conversationId),
          onMessage: handleIncoming,
          log,
          journal,
          debug: () => readConfig().debugHooks === true,
        });
        source.guard({
          api,
          isWatchedSession: (key) => observedSessions.has(key),
          muteOutbound: () => readConfig().muteWhatsAppOutbound !== false,
          blockAgent: () => readConfig().blockAgent !== false,
          log,
          journal,
        });
        void journal("info", `source attached: ${source.id}`);
      }
    }

    // --- temporary diagnostics: which hook actually fires on the group path ---
    if (readConfig().debugHooks) {
      for (const name of ["inbound_claim", "before_dispatch", "reply_dispatch", "message_sending", "message_sent", "session_start"]) {
        try {
          api.on(name, async (event, ctx) => {
            log.info?.(`[hebrew-bridge][hook:${name}] channel=${ctx?.channelId ?? "-"} conv=${ctx?.conversationId ?? "-"} from=${event?.from ?? "-"}`);
          });
        } catch (err) {
          log.warn?.(`[hebrew-bridge] hook ${name} unavailable: ${err?.message ?? err}`);
        }
      }
    }

    // Image-reading self-check: the file path comes from the config, runs once at startup.
    const selfTestImage = readConfig().selfTestImage;
    if (selfTestImage) {
      setTimeout(async () => {
        const cfg = readConfig();
        // `route` is not in scope here — the self-check threw ReferenceError on
        // every run and reported it as "the model cannot read images".
        const probeRoute = resolveRoutes(cfg)[0] ?? {};
        const attempts = [
          { label: "forced model", forced: true },
        ];
        for (const attempt of attempts) {
          try {
            const res = attempt.forced
              ? await api.runtime.mediaUnderstanding.describeImageFileWithModel({
                  filePath: selfTestImage,
                  cfg: readGatewayConfig(),
                  mime: "image/jpeg",
                  provider: cfg.imageProvider ?? "openai",
                  model: cfg.imageModel ?? "gpt-5.4-mini",
                  prompt: buildImageTextPrompt(probeRoute),
                  maxTokens: 1500,
                  timeoutMs: cfg.imageTimeoutMs ?? 120_000,
                })
              : await api.runtime.mediaUnderstanding.describeImageFile({
                  filePath: selfTestImage,
                  cfg: readGatewayConfig(),
                  mime: "image/jpeg",
                  prompt: buildImageTextPrompt(probeRoute),
                });
            log.info?.(
              `[hebrew-bridge][self-test] ${attempt.label}: ` +
              `text=${JSON.stringify(String(res?.text ?? "").slice(0, 120))} ` +
              `provider=${res?.provider ?? "-"} model=${res?.model ?? "-"} ` +
              `decision=${JSON.stringify(res?.decision ?? null).slice(0, 300)} ` +
              `output=${JSON.stringify(res?.output ?? null).slice(0, 200)}`
            );
          } catch (err) {
            log.warn?.(`[hebrew-bridge][self-test] ${attempt.label}: exception ${err?.message ?? err}`);
          }
        }
      }, 8000);
    }

    // ---- subscription quota watch --------------------------------------------
    const quotaStateFile = () => join(dataDir(), "quota-state.json");

    /** Warning state on disk: a service restart must not re-send everything. */
    const readQuotaState = async () => {
      try {
        return JSON.parse(await readFile(quotaStateFile(), "utf8"));
      } catch {
        return {};
      }
    };
    const writeQuotaState = async (state) => {
      try {
        await ensureDirs();
        await writeFile(quotaStateFile(), JSON.stringify(state, null, 2), "utf8");
      } catch (err) {
        void journal("warn", `could not save quota state: ${err?.message ?? err}`);
      }
    };

    /** Pull the remaining percentages out of the gateway reply or text like "5h 12% left". */
    function parseQuota(raw) {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
      const found = [];
      for (const m of text.matchAll(/(\b[\w\s]{1,12}?)\s(\d{1,3})%\s*left/gi)) {
        found.push({ window: m[1].trim(), left: Number(m[2]) });
      }
      return found;
    }

    async function checkQuota() {
      const cfg = readConfig();
      if (cfg.quotaWatch === false) return;
      const threshold = cfg.quotaThreshold ?? 20;

      // gateway.request is off limits for third-party plugins, so ask through the CLI
      let raw;
      try {
        const cli = cfg.cliPath ?? join(homedir(), "npm-global", "bin", "openclaw");
        const res = await execFileAsync(cli, ["models", "status"], {
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        raw = res.stdout ?? "";
      } catch (err) {
        void journal("warn", `could not read quota status: ${err?.message ?? err}`);
        return;
      }

      const windows = parseQuota(raw);
      if (windows.length === 0) {
        void journal("warn", `quota status received but no percentages parsed: ${JSON.stringify(raw).slice(0, 300)}`);
        return;
      }

      void journal("info", `quota: ${windows.map((w) => `${w.window} ${w.left}%`).join(" · ")}`);

      const state = await readQuotaState();
      const repeatMs = (cfg.quotaRepeatHours ?? 6) * 3_600_000;
      const now = Date.now();
      const alertTarget = cfg.alertChatId ?? cfg.telegramChatId;
      let changed = false;
      const low = [];

      for (const w of windows) {
        const prev = state[w.window] ?? {};
        if (w.left > threshold + 10) {
          // quota recovered — forget it so the next drop warns again
          if (prev.warnedAt) { delete state[w.window]; changed = true; }
          continue;
        }
        if (w.left > threshold) continue;
        const fresh = !prev.warnedAt || now - prev.warnedAt > repeatMs;
        if (!fresh) continue;
        low.push(w);
        state[w.window] = { warnedAt: now, left: w.left };
        changed = true;
      }

      if (changed) await writeQuotaState(state);
      if (low.length === 0) return;

      // one message covering all windows at once, not one per window
      const msg =
        `⚠️ ChatGPT quota is running out\n\n` +
        low.map((w) => `• ${w.window}: ${w.left}% left`).join("\n") +
        `\n\nVoice transcription and image reading may stop working. ` +
        `Text translation will keep going through the fallback models.`;
      try {
        const fallbackRoute = resolveRoutes(cfg)[0] ?? { delivery: "telegram" };
        // alertTarget may well be unset; writing it in blindly used to overwrite
        // the working address from the route with undefined.
        await deliver(msg, { ...fallbackRoute, chatId: alertTarget ?? fallbackRoute.chatId, name: "service", threadId: undefined });
        void journal("warn", `quota warning sent (${low.map((w) => `${w.window}:${w.left}%`).join(", ")})`);
      } catch (err) {
        void journal("error", `could not send the quota warning: ${err?.message ?? err}`);
      }
    }

    const quotaTimer = setInterval(() => { void checkQuota(); }, (readConfig().quotaCheckMinutes ?? 30) * 60_000);
    if (typeof quotaTimer.unref === "function") quotaTimer.unref();
    setTimeout(() => { void checkQuota(); }, 120_000);  // not right after startup: restarts should not trigger the check

    {
      const rs = resolveRoutes(readConfig());
      void journal("info",
        `plugin started · routes: ${rs.length}` +
        (rs.length ? " · " + rs.map((r) => `${r.name} → ${r.chatId ?? "?"}${r.threadId ? `#${r.threadId}` : ""}`).join(", ") : "")
      );
    }
    /**
     * Catch up on what was missed: take the conversation's messages from the gateway
     * log and push them through the normal pipeline. Needed when a chat is connected
     * after the fact, or when the service was down for a while.
     */
    async function replayFromLog() {
      const cfg = readConfig();
      const plan = cfg.replay;
      if (!plan?.jid) return;
      try {
        void journal("info", `replay: looking for ${plan.jid} messages over the last ${plan.minutes ?? 120} min`);

        const route = resolveRoutes(cfg).find((r) => r.jid === plan.jid);
        if (!route) {
          void journal("warn", `cannot replay: no route configured for ${plan.jid}`);
          return;
        }

        // watermark of how far we already replayed — otherwise every restart re-sends
        const markFile = join(dataDir(), "replay-state.json");
        let marks = {};
        try { marks = JSON.parse(await readFile(markFile, "utf8")); } catch { /* no first run yet */ }

        // on restart the plugin registers twice almost simultaneously:
        // claim the watermark IMMEDIATELY, or both copies send the same thing
        const prev = marks[plan.jid] ?? {};
        if (prev.runAt && Date.now() - prev.runAt < 120_000) {
          void journal("info", "replay already ran a moment ago — skipping");
          return;
        }
        marks[plan.jid] = { ...prev, runAt: Date.now() };
        try {
          await ensureDirs();
          await writeFile(markFile, JSON.stringify(marks, null, 2), "utf8");
        } catch { /* not critical */ }

        const windowStart = Date.now() - (plan.minutes ?? 120) * 60_000;
        const sinceMs = Math.max(windowStart, prev.lastTs ?? 0);
        const dir = plan.logDir ?? "/tmp/openclaw";
        const files = (await readdir(dir)).filter((f) => f.startsWith("openclaw-")).sort().slice(-2);

        const found = [];
        for (const file of files) {
          let text = "";
          try { text = await readFile(join(dir, file), "utf8"); } catch { continue; }
          for (const line of text.split("\n")) {
            if (!line.includes(plan.jid) || !line.includes("inbound message")) continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            const info = row?.["1"];
            if (!info || info.from !== plan.jid) continue;
            const ts = Date.parse(row?.time ?? "");
            if (!Number.isFinite(ts) || ts < sinceMs) continue;
            found.push({ ts, body: String(info.body ?? ""), mediaPath: info.mediaPath, mime: info.mediaType });
          }
        }

        if (found.length === 0) {
          void journal("info", `nothing to replay: no matching messages found`);
          return;
        }

        const w = worldOf(route.jid);
        for (const m of found) {
          const base = { sender: plan.sender ?? "—", clock: formatClock(m.ts, { timeZone: route.timeZone, locale: route.locale }), replyToBody: "" };
          const media = /^<media:([a-z]+)>$/i.exec(m.body);
          if (media) {
            w.pending.push({ ...base, kind: "media", mediaKind: media[1].toLowerCase(), mediaPath: m.mediaPath, mime: m.mime, text: "" });
          } else if (m.body.trim()) {
            w.pending.push({ ...base, kind: "text", text: m.body.trim() });
          }
        }
        marks[plan.jid] = { runAt: Date.now(), lastTs: Math.max(...found.map((m) => m.ts)) };
        try {
          await ensureDirs();
          await writeFile(markFile, JSON.stringify(marks, null, 2), "utf8");
        } catch (err) {
          void journal("warn", `could not persist the replay watermark: ${err?.message ?? err}`);
        }

        void journal("info", `[${route.name}] replaying ${w.pending.length} message(s) from the log`);
        scheduleFlush(route);
      } catch (err) {
        void journal("error", `replay failed: ${err?.message ?? err}`);
      }
    }

    setTimeout(() => { void replayFromLog(); }, 15_000);

    // Probe: can the plugin reach the provider on its own, so it can pick a model
    // independently of the agent. Keys are never logged.
    if (readConfig().authProbe) {
      setTimeout(async () => {
        const cfg = readGatewayConfig();
        const targets = [
          { provider: "openrouter", model: "google/gemini-3.7-flash" },
          { provider: "openai", model: "gpt-5.6-luna" },
        ];
        for (const t of targets) {
          for (const [label, fn] of [
            ["getApiKeyForModel", api.runtime.modelAuth?.getApiKeyForModel],
            ["getRuntimeAuthForModel", api.runtime.modelAuth?.getRuntimeAuthForModel],
            ["resolveApiKeyForProvider", api.runtime.modelAuth?.resolveApiKeyForProvider],
          ]) {
            if (typeof fn !== "function") { void journal("info", `[probe] ${label}: method missing`); continue; }
            try {
              const params = label === "resolveApiKeyForProvider"
                ? { provider: t.provider, cfg }
                : { model: t, cfg };
              const res = await fn(params);
              const keys = res && typeof res === "object" ? Object.keys(res) : [];
              void journal("info",
                `[probe] ${t.provider}/${t.model} · ${label}: mode=${res?.mode ?? "-"} ` +
                `key=${res?.apiKey ? `present (${String(res.apiKey).length} chars)` : "none"} ` +
                `fields=[${keys.join(",")}]`
              );
            } catch (err) {
              void journal("warn", `[probe] ${t.provider}/${t.model} · ${label}: ${String(err?.message ?? err).slice(0, 120)}`);
            }
          }
        }
      }, 12_000);
    }

    /**
     * Tops up the registry of seen conversations. The gateway log only lives a couple
     * of days, so without this a chat that last spoke a week ago cannot be identified.
     */
    async function scanForGroups() {
      const cfg = readConfig();
      if (cfg.groupRegistry === false) return;
      try {
        const file = registryPath(dataDir());
        let registry = await loadRegistry(file);
        let added = 0;

        for (const id of listSources()) {
          const source = resolveSource(id);
          if (typeof source?.discover !== "function") continue;
          const seen = await source.discover({ logDir: cfg.logDir });
          const before = Object.keys(registry).length;
          registry = mergeObservations(registry, seen, { source: id });
          added += Object.keys(registry).length - before;
        }

        await saveRegistry(file, registry);
        if (added > 0) {
          void journal("info", `conversation registry updated: +${added}, total ${Object.keys(registry).length}`);
        }
      } catch (err) {
        void journal("warn", `could not update the conversation registry: ${err?.message ?? err}`);
      }
    }

    {
      const everyMinutes = readConfig().groupScanMinutes ?? 60;
      const timer = setInterval(() => { void scanForGroups(); }, everyMinutes * 60_000);
      if (typeof timer.unref === "function") timer.unref();
      setTimeout(() => { void scanForGroups(); }, 45_000);
    }

    void pruneLogs();
    void restoreState();

    log.info?.("[hebrew-bridge] plugin registered");
  },
};

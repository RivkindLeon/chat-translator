import { appendFile, mkdir, readdir, unlink, stat, readFile, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

/**
 * Hebrew Bridge — плагин OpenClaw.
 *
 * Слушает одну WhatsApp-группу, копит сообщения пачками, переводит их
 * одним запросом к модели и доставляет перевод отдельным каналом.
 *
 * Принципы:
 *  - в исходную группу не пишем никогда, только читаем;
 *  - доставка идёт по жёсткому whitelist адресатов из конфига;
 *  - пачка вместо сообщения-за-сообщением: дешевле, качественнее, тише.
 */

import { DEFAULTS, resolveRoutes } from "./src/config.js";
import { DEFAULT_PRICES, estimateCostUsd, normalizeModelKey } from "./src/pricing.js";
import { IMAGE_TEXT_PROMPT, buildSystemPrompt, renderMessagesForPrompt } from "./src/prompts.js";
import { MEDIA_LABELS, MEDIA_PLURAL, renderMediaNotes, extractMediaFile } from "./src/media.js";
import { splitForDelivery, formatClock, resolveSenderLabel } from "./src/format.js";
import { resolveSource, listSources } from "./src/sources/index.js";
import { deliverText } from "./src/delivery/index.js";

export default {
  id: "hebrew-bridge",
  name: "Hebrew Bridge",
  description: "Переводит ивритскую WhatsApp-группу на русский",

  register(api) {
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

    /** Свой журнал: постоянная папка, файл на день, старые удаляются. */
    const journal = async (level, message) => {
      try {
        await ensureDirs();
        const now = new Date();
        const day = now.toISOString().slice(0, 10);
        const line = `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`;
        await appendFile(join(dataDir(), "logs", `${day}.log`), line, "utf8");
      } catch {
        // журнал не должен ломать перевод
      }
    };

    /** Образцы текста — чтобы можно было оценивать качество перевода, а не гадать. */
    const sample = async (label, text) => {
      if (readConfig().logTexts !== true) return;
      try {
        await ensureDirs();
        const day = new Date().toISOString().slice(0, 10);
        const body = `\n===== ${new Date().toISOString()} · ${label} =====\n${text}\n`;
        await appendFile(join(dataDir(), "samples", `${day}.log`), body, "utf8");
      } catch {
        // образцы не критичны
      }
    };

    /** Одна строка на каждый платный вызов — из этого потом считается счёт за месяц. */
    const recordUsage = async (entry) => {
      try {
        await ensureDirs();
        const row = { ts: new Date().toISOString(), ...entry };
        await appendFile(join(dataDir(), "usage.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
      } catch (err) {
        void journal("warn", `не удалось записать расход: ${err?.message ?? err}`);
      }
    };

    /** Чистка старых журналов (расходы не трогаем — они нужны для отчётности). */
    const pruneLogs = async () => {
      try {
        const days = readConfig().logRetentionDays ?? 60;
        const dir = join(dataDir(), "logs");
        const cutoff = Date.now() - days * 86_400_000;
        for (const name of await readdir(dir)) {
          const file = join(dir, name);
          const info = await stat(file);
          if (info.mtimeMs < cutoff) await unlink(file);
        }
      } catch {
        // папки может ещё не быть
      }
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

    // ---- состояние в памяти -------------------------------------------------
    const pending = [];            // накопленные, ещё не переведённые
    const recentContext = [];      // последние переведённые — контекст для модели
    const seenIds = new Set();     // защита от дублей
    let debounceTimer = null;
    let hardTimer = null;
    let flushing = false;

    const observedSessions = new Set();  // sessionKey разговоров, которые мы читаем

    /** У каждой группы свой мир: свои накопленные сообщения, свой контекст, свои таймеры. */
    const worlds = new Map();
    const worldOf = (jid) => {
      let w = worlds.get(jid);
      if (!w) {
        w = {
          pending: [],
          recentContext: [],
          seenIds: new Set(),
          undelivered: [],
          debounceTimer: null,
          hardTimer: null,
          flushing: false,
        };
        worlds.set(jid, w);
      }
      return w;
    };

    // ---- буфер переживает перезапуск ------------------------------------
    const stateFile = () => join(dataDir(), "pending.json");
    let saveTimer = null;

    /** Пишем атомарно: сначала во временный файл, потом переименовываем. */
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
        void journal("warn", `не удалось сохранить буфер: ${err?.message ?? err}`);
      }
    };

    /** Пишем не чаще раза в секунду — на каждое сообщение диск дёргать незачем. */
    const scheduleSave = () => {
      if (saveTimer) return;
      saveTimer = setTimeout(() => { saveTimer = null; void saveState(); }, 1000);
      if (typeof saveTimer.unref === "function") saveTimer.unref();
    };

    /** При старте поднимаем то, что не успели обработать до перезапуска. */
    const restoreState = async () => {
      let dump;
      try {
        dump = JSON.parse(await readFile(stateFile(), "utf8"));
      } catch {
        return;   // файла нет — обычная ситуация
      }
      const routes = resolveRoutes(readConfig());
      let restored = 0;
      for (const [jid, saved] of Object.entries(dump ?? {})) {
        const route = routes.find((r) => r.jid === jid);
        if (!route) continue;   // группу отключили, пока сервис лежал
        const w = worldOf(jid);
        w.pending.push(...(saved.pending ?? []));
        w.undelivered.push(...(saved.undelivered ?? []));
        w.recentContext.push(...(saved.recentContext ?? []));
        restored += (saved.pending?.length ?? 0) + (saved.undelivered?.length ?? 0);
        if (w.pending.length > 0 || w.undelivered.length > 0) scheduleFlush(route);
      }
      if (restored > 0) void journal("info", `после перезапуска восстановлено ${restored} сообщ.`);
    };

    /** Досылаем то, что уже переведено, но не ушло: модель повторно не зовём. */
    const flushUndelivered = async (route, w) => {
      while (w.undelivered.length > 0) {
        try {
          await deliver(w.undelivered[0], route);
          w.undelivered.shift();
        } catch (err) {
          void journal("warn", `[${route.name}] очередь доставки ждёт (${w.undelivered.length} шт.): ${err?.message ?? err}`);
          return;
        }
      }
    };

    const clearTimers = (w) => {
      if (w.debounceTimer) { clearTimeout(w.debounceTimer); w.debounceTimer = null; }
      if (w.hardTimer) { clearTimeout(w.hardTimer); w.hardTimer = null; }
    };

    /** Доставка перевода по маршруту; в тестовом режиме только пишем в журнал. */
    async function deliver(text, route) {
      const cfg = readConfig();
      if (cfg.dryRun) {
        log.info?.(`[hebrew-bridge] dry-run, доставка пропущена:\n${text}`);
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
              const msg = `[${route.name}] голосовое расшифровано (${text.length} симв.), провайдер=${res?.provider ?? "?"} модель=${res?.model ?? "?"}`;
              log.info?.(`[hebrew-bridge] ${msg}`);
              void journal("info", msg);
              void sample("расшифровка голоса", text);
            }
          } else if (item.mediaKind === "image" && cfg.readImages !== false) {
            // describeImageFile сам пропускает работу ("primary model supports vision natively"),
            // поэтому при заданной модели зовём вариант с принудительным выбором.
            const res = (cfg.imageProvider && cfg.imageModel)
              ? await api.runtime.mediaUnderstanding.describeImageFileWithModel({
                  filePath: item.mediaPath,
                  cfg: gatewayCfg,
                  ...(item.mime ? { mime: item.mime } : {}),
                  provider: cfg.imageProvider,
                  model: cfg.imageModel,
                  prompt: IMAGE_TEXT_PROMPT,
                  maxTokens: 1500,
                  timeoutMs: cfg.imageTimeoutMs ?? 120_000,
                })
              : await api.runtime.mediaUnderstanding.describeImageFile({
                  filePath: item.mediaPath,
                  cfg: gatewayCfg,
                  ...(item.mime ? { mime: item.mime } : {}),
                  prompt: IMAGE_TEXT_PROMPT,
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
              const msg = `[${route.name}] с картинки снят текст (${text.length} симв.), провайдер=${res?.provider ?? "?"} модель=${res?.model ?? cfg.imageModel ?? "?"}`;
              log.info?.(`[hebrew-bridge] ${msg}`);
              void journal("info", msg);
              void sample(`OCR картинки · ${res?.model ?? cfg.imageModel}`, text);
            } else {
              // чаще всего это значит, что модель не умеет читать изображения
              const miss =
                `[${route.name}] с картинки текст не снят: ответ="${String(res?.text ?? "").slice(0, 60)}" ` +
                `провайдер=${res?.provider ?? "?"} модель=${res?.model ?? cfg.imageModel ?? "?"}`;
              log.warn?.(`[hebrew-bridge] ${miss}`);
              void journal("warn", miss);
            }
          }
        } catch (err) {
          // не смогли — остаётся обычная пометка, сообщение не теряется
          const msg = `[${route.name}] ${item.mediaKind}: обработка не удалась (${err?.message ?? err})`;
          log.warn?.(`[hebrew-bridge] ${msg}`);
          void journal("warn", msg);
        }
      }
    }

    async function flush(route) {
      const w = worldOf(route.jid);
      if (w.flushing || w.pending.length === 0) return;
      w.flushing = true;
      clearTimers(w);

      const cfg = readConfig();
      const batch = w.pending.splice(0, route.maxBatch);

      await flushUndelivered(route, w);
      await enrichMedia(batch, route);

      const textItems = batch.filter((m) => m.kind !== "media");
      const mediaItems = batch.filter((m) => m.kind === "media");
      const mediaLines = renderMediaNotes(mediaItems);

      try {
        if (textItems.length === 0) {
          if (mediaLines.length > 0) {
            try {
              await deliver(mediaLines.join("\n\n"), route);
            } catch (err) {
              w.undelivered.push(mediaLines.join("\n\n"));
              void journal("error", `[${route.name}] доставка не удалась: ${err?.message ?? err}`);
            }
          }
          w.recentContext.push(...batch);
          while (w.recentContext.length > route.contextSize) w.recentContext.shift();
          return;
        }

        const contextBlock = w.recentContext.length
          ? `КОНТЕКСТ (уже переведённые сообщения выше по ленте)\n${renderMessagesForPrompt(w.recentContext)}\n\n`
          : "";
        const userContent = `${contextBlock}ПЕРЕВЕДИ ЭТИ СООБЩЕНИЯ\n${renderMessagesForPrompt(textItems)}`;

        const result = await api.runtime.llm.complete({
          systemPrompt: buildSystemPrompt(route),
          messages: [{ role: "user", content: userContent }],
          maxTokens: 2000,
          temperature: 0.2,
          purpose: `hebrew-bridge: перевод пачки (${route.name})`,
        });

        const translated = (result?.text ?? "").trim();
        if (!translated) {
          void journal("warn", `[${route.name}] модель вернула пустой ответ, пачка пропущена`);
          return;
        }

        void sample(
          `перевод · ${route.name} · ${result?.model ?? "?"}`,
          `--- ИСХОДНИК ---\n${renderMessagesForPrompt(textItems)}\n\n--- ПЕРЕВОД ---\n${translated}`
        );

        const payload = [translated, ...mediaLines].join("\n\n");
        try {
          await deliver(payload, route);
        } catch (err) {
          w.undelivered.push(payload);
          void journal("error", `[${route.name}] доставка не удалась, поставлено в очередь: ${err?.message ?? err}`);
        }

        w.recentContext.push(...batch);
        while (w.recentContext.length > route.contextSize) w.recentContext.shift();

        const usage = result?.usage ?? {};
        const inTok = usage.inputTokens ?? usage.promptTokens;
        const outTok = usage.outputTokens ?? usage.completionTokens;
        const cost = estimateCostUsd(result?.model, inTok, outTok, cfg.prices);
        const summary =
          `[${route.name}] переведено ${textItems.length} сообщ. (+${mediaItems.length} медиа), ` +
          `модель ${result?.model ?? "?"}, токены in=${inTok ?? "?"} out=${outTok ?? "?"}` +
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
        log.error?.(`[hebrew-bridge] [${route.name}] ошибка перевода: ${err?.message ?? err}`);
        void journal("error", `[${route.name}] ошибка перевода: ${err?.message ?? err}`);
      } finally {
        w.flushing = false;
        void saveState();
        if (w.pending.length > 0) scheduleFlush(route);
      }
    }

    function scheduleFlush(route) {
      const w = worldOf(route.jid);
      if (w.debounceTimer) clearTimeout(w.debounceTimer);
      w.debounceTimer = setTimeout(() => { void flush(route); }, route.debounceMs);
      if (!w.hardTimer) {
        w.hardTimer = setTimeout(() => { void flush(route); }, route.maxWaitMs);
      }
      if (w.pending.length >= route.maxBatch) void flush(route);
    }

    // ---- приём сообщений ----------------------------------------------------
    /** Пришло сообщение из наблюдаемой беседы — кладём в её накопитель. */
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
          clock: formatClock(msg.timestamp),
          replyToBody: msg.replyToBody ? String(msg.replyToBody).slice(0, 120) : "",
        };

        if (msg.kind === "media") {
          w.pending.push({ ...base, kind: "media", mediaKind: msg.mediaKind, mediaPath: msg.mediaPath, mime: msg.mime, text: "" });
          if (!msg.mediaPath) {
            const miss = `[${route.name}] вложение без пути к файлу (${msg.mediaKind})`;
            log.warn?.(`[hebrew-bridge] ${miss}`);
            void journal("warn", miss);
          } else {
            void journal("info", `[${route.name}] принято медиа ${msg.mediaKind}: ${msg.mediaPath}`);
          }
        } else {
          w.pending.push({ ...base, kind: "text", text: msg.text });
        }

        scheduleFlush(route);
        scheduleSave();
      } catch (err) {
        log.error?.(`[hebrew-bridge] сбой приёма: ${err?.message ?? err}`);
        void journal("error", `сбой приёма: ${err?.message ?? err}`);
      }
    }

    // Подключаем источники, указанные в маршрутах: они знают, как слушать свой
    // мессенджер, как выглядят его вложения и как запретить запись в него.
    {
      const cfg = readConfig();
      const ids = [...new Set(resolveRoutes(cfg).map((r) => r.source ?? "whatsapp"))];
      const watchedJids = () => new Set(resolveRoutes(readConfig()).map((r) => r.jid));
      for (const id of ids) {
        const source = resolveSource(id);
        if (!source) {
          void journal("error", `источник "${id}" неизвестен; доступные: ${listSources().join(", ")}`);
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
        void journal("info", `источник подключён: ${source.id}`);
      }
    }

    // --- временная диагностика: какой хук реально срабатывает на пути группы ---
    if (readConfig().debugHooks) {
      for (const name of ["inbound_claim", "before_dispatch", "reply_dispatch", "message_sending", "message_sent", "session_start"]) {
        try {
          api.on(name, async (event, ctx) => {
            log.info?.(`[hebrew-bridge][hook:${name}] channel=${ctx?.channelId ?? "-"} conv=${ctx?.conversationId ?? "-"} from=${event?.from ?? "-"}`);
          });
        } catch (err) {
          log.warn?.(`[hebrew-bridge] хук ${name} недоступен: ${err?.message ?? err}`);
        }
      }
    }

    // Самодиагностика чтения картинок: путь к файлу задаётся в конфиге, срабатывает один раз при старте.
    const selfTestImage = readConfig().selfTestImage;
    if (selfTestImage) {
      setTimeout(async () => {
        const cfg = readConfig();
        const attempts = [
          { label: "forced-модель", forced: true },
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
                  prompt: IMAGE_TEXT_PROMPT,
                  maxTokens: 1500,
                  timeoutMs: cfg.imageTimeoutMs ?? 120_000,
                })
              : await api.runtime.mediaUnderstanding.describeImageFile({
                  filePath: selfTestImage,
                  cfg: readGatewayConfig(),
                  mime: "image/jpeg",
                  prompt: IMAGE_TEXT_PROMPT,
                });
            log.info?.(
              `[hebrew-bridge][самотест] ${attempt.label}: ` +
              `text=${JSON.stringify(String(res?.text ?? "").slice(0, 120))} ` +
              `provider=${res?.provider ?? "-"} model=${res?.model ?? "-"} ` +
              `decision=${JSON.stringify(res?.decision ?? null).slice(0, 300)} ` +
              `output=${JSON.stringify(res?.output ?? null).slice(0, 200)}`
            );
          } catch (err) {
            log.warn?.(`[hebrew-bridge][самотест] ${attempt.label}: исключение ${err?.message ?? err}`);
          }
        }
      }, 8000);
    }

    // ---- слежение за квотой подписки -------------------------------------
    const quotaStateFile = () => join(dataDir(), "quota-state.json");

    /** Состояние предупреждений на диске: перезапуск сервиса не должен слать всё заново. */
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
        void journal("warn", `не удалось сохранить состояние квоты: ${err?.message ?? err}`);
      }
    };

    /** Достаём проценты остатка из ответа gateway или из текста вида "5h 12% left". */
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

      // gateway.request сторонним плагинам запрещён, поэтому спрашиваем через CLI
      let raw;
      try {
        const cli = cfg.cliPath ?? join(homedir(), "npm-global", "bin", "openclaw");
        const res = await execFileAsync(cli, ["models", "status"], {
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        raw = res.stdout ?? "";
      } catch (err) {
        void journal("warn", `не удалось получить статус квоты: ${err?.message ?? err}`);
        return;
      }

      const windows = parseQuota(raw);
      if (windows.length === 0) {
        void journal("warn", `статус квоты получен, но проценты не распознаны: ${JSON.stringify(raw).slice(0, 300)}`);
        return;
      }

      void journal("info", `квота: ${windows.map((w) => `${w.window} ${w.left}%`).join(" · ")}`);

      const state = await readQuotaState();
      const repeatMs = (cfg.quotaRepeatHours ?? 6) * 3_600_000;
      const now = Date.now();
      const alertTarget = cfg.alertChatId ?? cfg.telegramChatId;
      let changed = false;
      const low = [];

      for (const w of windows) {
        const prev = state[w.window] ?? {};
        if (w.left > threshold + 10) {
          // квота восстановилась — забываем, чтобы предупредить снова при следующем падении
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

      // одно сообщение на все окна сразу, а не по штуке на каждое
      const msg =
        `⚠️ Заканчивается квота ChatGPT\n\n` +
        low.map((w) => `• ${w.window}: осталось ${w.left}%`).join("\n") +
        `\n\nРасшифровка голосовых и чтение картинок могут перестать работать. ` +
        `Перевод текста продолжит идти через запасные модели.`;
      try {
        await deliver(msg, { ...(resolveRoutes(cfg)[0] ?? { delivery: "telegram" }), chatId: alertTarget, name: "служебное", threadId: undefined });
        void journal("warn", `предупреждение о квоте отправлено (${low.map((w) => `${w.window}:${w.left}%`).join(", ")})`);
      } catch (err) {
        void journal("error", `не удалось отправить предупреждение о квоте: ${err?.message ?? err}`);
      }
    }

    const quotaTimer = setInterval(() => { void checkQuota(); }, (readConfig().quotaCheckMinutes ?? 30) * 60_000);
    if (typeof quotaTimer.unref === "function") quotaTimer.unref();
    setTimeout(() => { void checkQuota(); }, 120_000);  // не сразу после старта: рестарты не должны дёргать проверку

    {
      const rs = resolveRoutes(readConfig());
      void journal("info",
        `плагин запущен · маршрутов: ${rs.length}` +
        (rs.length ? " · " + rs.map((r) => `${r.name} → ${r.chatId ?? "?"}${r.threadId ? `#${r.threadId}` : ""}`).join(", ") : "")
      );
    }
    /**
     * Догнать пропущенное: берём сообщения группы из лога шлюза и прогоняем
     * через обычный конвейер. Нужно, когда группу подключили задним числом
     * или сервис какое-то время лежал.
     */
    async function replayFromLog() {
      const cfg = readConfig();
      const plan = cfg.replay;
      if (!plan?.jid) return;
      try {
        void journal("info", `догонялка: ищу сообщения ${plan.jid} за ${plan.minutes ?? 120} мин`);

        const route = resolveRoutes(cfg).find((r) => r.jid === plan.jid);
        if (!route) {
          void journal("warn", `догнать не могу: маршрут ${plan.jid} не настроен`);
          return;
        }

        // отметка, до какого момента уже догоняли — иначе каждый перезапуск шлёт заново
        const markFile = join(dataDir(), "replay-state.json");
        let marks = {};
        try { marks = JSON.parse(await readFile(markFile, "utf8")); } catch { /* первого раза ещё не было */ }

        // при перезапуске плагин регистрируется дважды почти одновременно:
        // занимаем отметку СРАЗУ, иначе обе копии отправят одно и то же
        const prev = marks[plan.jid] ?? {};
        if (prev.runAt && Date.now() - prev.runAt < 120_000) {
          void journal("info", "догонялка уже отработала только что — пропускаю");
          return;
        }
        marks[plan.jid] = { ...prev, runAt: Date.now() };
        try {
          await ensureDirs();
          await writeFile(markFile, JSON.stringify(marks, null, 2), "utf8");
        } catch { /* не критично */ }

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
          void journal("info", `догонять нечего: подходящих сообщений не нашлось`);
          return;
        }

        const w = worldOf(route.jid);
        for (const m of found) {
          const base = { sender: plan.sender ?? "—", clock: formatClock(m.ts), replyToBody: "" };
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
          void journal("warn", `не удалось запомнить отметку догонялки: ${err?.message ?? err}`);
        }

        void journal("info", `[${route.name}] догоняем ${w.pending.length} сообщ. из лога`);
        scheduleFlush(route);
      } catch (err) {
        void journal("error", `догонялка упала: ${err?.message ?? err}`);
      }
    }

    setTimeout(() => { void replayFromLog(); }, 15_000);

    // Разведка: может ли плагин получить доступ к провайдеру сам,
    // чтобы выбирать модель независимо от агента. Ключи не логируем.
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
            if (typeof fn !== "function") { void journal("info", `[проба] ${label}: метода нет`); continue; }
            try {
              const params = label === "resolveApiKeyForProvider"
                ? { provider: t.provider, cfg }
                : { model: t, cfg };
              const res = await fn(params);
              const keys = res && typeof res === "object" ? Object.keys(res) : [];
              void journal("info",
                `[проба] ${t.provider}/${t.model} · ${label}: mode=${res?.mode ?? "-"} ` +
                `ключ=${res?.apiKey ? `есть (${String(res.apiKey).length} симв.)` : "нет"} ` +
                `поля=[${keys.join(",")}]`
              );
            } catch (err) {
              void journal("warn", `[проба] ${t.provider}/${t.model} · ${label}: ${String(err?.message ?? err).slice(0, 120)}`);
            }
          }
        }
      }, 12_000);
    }

    void pruneLogs();
    void restoreState();

    log.info?.("[hebrew-bridge] плагин зарегистрирован");
  },
};

import whatsapp from "./whatsapp.js";

/** Источники сообщений. Добавить новый мессенджер — значит положить сюда файл. */
const SOURCES = [whatsapp];

export function resolveSource(id) {
  return SOURCES.find((s) => s.id === (id ?? "whatsapp"));
}

export function listSources() {
  return SOURCES.map((s) => s.id);
}

import whatsapp from "./whatsapp.js";

/** Message sources. Adding a messenger means dropping a file in here. */
const SOURCES = [whatsapp];

export function resolveSource(id) {
  return SOURCES.find((s) => s.id === (id ?? "whatsapp"));
}

export function listSources() {
  return SOURCES.map((s) => s.id);
}

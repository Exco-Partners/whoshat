// Shared persona helpers for extension pages (popup) and the service worker.
// NOTE: the content script cannot import modules, so it carries its own copy
// of `readableTextColor`. Keep the two in sync.

export const PERSONAS_KEY = 'personas';
export const TAB_MAP_KEY = 'tabPersona';

export const SWATCHES = [
  '#e11d48', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
  '#64748b', '#0f172a'
];

export function newId() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function getPersonas() {
  const { [PERSONAS_KEY]: personas } = await chrome.storage.local.get(PERSONAS_KEY);
  return Array.isArray(personas) ? personas : [];
}

export async function savePersonas(personas) {
  await chrome.storage.local.set({ [PERSONAS_KEY]: personas });
}

export async function getPersona(id) {
  if (!id) return null;
  const personas = await getPersonas();
  return personas.find((p) => p.id === id) || null;
}

export async function upsertPersona(persona) {
  const personas = await getPersonas();
  const i = personas.findIndex((p) => p.id === persona.id);
  if (i === -1) personas.push(persona);
  else personas[i] = persona;
  await savePersonas(personas);
  return persona;
}

// --- tab assignments ---------------------------------------------------------
// Kept in session storage: survives the service worker sleeping, cleared when
// Chrome restarts. Readable from any trusted context (popup + worker), which is
// why the popup can render without waking the worker.

export async function getTabMap() {
  const { [TAB_MAP_KEY]: map } = await chrome.storage.session.get(TAB_MAP_KEY);
  return map && typeof map === 'object' ? map : {};
}

export async function setTabMap(map) {
  await chrome.storage.session.set({ [TAB_MAP_KEY]: map });
}

export async function assignTab(tabId, personaId) {
  const map = await getTabMap();
  if (personaId) map[tabId] = personaId;
  else delete map[tabId];
  await setTabMap(map);
}

export async function deletePersona(id) {
  const personas = await getPersonas();
  await savePersonas(personas.filter((p) => p.id !== id));
}

// Pick black or white text for a given background so the notch label stays legible.
export function readableTextColor(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#ffffff';
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const channel = (v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const L =
    0.2126 * channel(h.slice(0, 2)) +
    0.7152 * channel(h.slice(2, 4)) +
    0.0722 * channel(h.slice(4, 6));
  return L > 0.45 ? '#111111' : '#ffffff';
}

export function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase() || '?';
}

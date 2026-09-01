// Who's Hat service worker.
//
// Owns the tabId -> personaId mapping. It lives in chrome.storage.session so it
// survives the service worker being torn down but is thrown away when the
// browser restarts (a demo persona should never outlive the demo).

import {
  TAB_MAP_KEY,
  getPersona,
  getPersonas,
  getTabMap,
  setTabMap,
  assignTab
} from '../shared/personas.js';

async function getTabPersona(tabId) {
  const map = await getTabMap();
  return getPersona(map[tabId]);
}

// --- talking to the page -----------------------------------------------------

async function pushToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    // No live content script in this tab. Normal right after the extension is
    // installed or reloaded: tabs that were already open keep running the old,
    // orphaned script until they navigate. Inject a fresh one and retry, so
    // activating works without the user having to reload the page first.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/overlay.js']
      });
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch {
      // chrome:// page, Web Store, PDF viewer, or the tab went away.
      return false;
    }
  }
}

async function paintTab(tabId, persona) {
  const [applied] = await Promise.all([
    pushToTab(tabId, persona ? { type: 'APPLY', persona } : { type: 'CLEAR' }),
    paintBadge(tabId, persona)
  ]);
  return applied;
}

async function paintBadge(tabId, persona) {
  try {
    if (persona) {
      await chrome.action.setBadgeText({ tabId, text: ' ' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: persona.color });
      await chrome.action.setTitle({
        tabId,
        title: `Who's Hat - ${persona.name}${persona.role ? ' (' + persona.role + ')' : ''}`
      });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: "Who's Hat" });
    }
  } catch {
    // Tab went away mid-update.
  }
}

// --- messages ----------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      // Content script booting (first load or after a navigation).
      case 'GET_STATE': {
        const tabId = sender.tab?.id;
        const persona = tabId == null ? null : await getTabPersona(tabId);
        if (tabId != null) await paintBadge(tabId, persona);
        sendResponse({ persona });
        return;
      }

      case 'ACTIVATE': {
        await assignTab(msg.tabId, msg.personaId);
        const persona = await getPersona(msg.personaId);
        const applied = await paintTab(msg.tabId, persona);
        sendResponse({ persona, applied });
        return;
      }

      case 'DEACTIVATE': {
        await assignTab(msg.tabId, null);
        await paintTab(msg.tabId, null);
        sendResponse({ persona: null });
        return;
      }

      default:
        sendResponse({});
    }
  })();
  return true; // keep the message channel open for the async work above
});

// --- keeping tabs in sync ----------------------------------------------------

// A tab closed: drop its assignment so ids are not reused by a future tab.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const map = await getTabMap();
  if (map[tabId]) {
    delete map[tabId];
    await setTabMap(map);
  }
});

// Per-tab badges are cleared by Chrome on navigation, so repaint them. The
// overlay itself is restored by the content script asking for GET_STATE.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  await paintBadge(tabId, await getTabPersona(tabId));
});

// Persona edited or deleted in the popup: repaint every tab wearing it.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.personas) return;
  const personas = await getPersonas();
  const byId = new Map(personas.map((p) => [p.id, p]));
  const map = await getTabMap();
  let mapChanged = false;

  for (const [tabId, personaId] of Object.entries(map)) {
    const persona = byId.get(personaId) || null;
    if (!persona) {
      delete map[tabId];
      mapChanged = true;
    }
    await paintTab(Number(tabId), persona);
  }
  if (mapChanged) await setTabMap(map);
});

// Nothing carries over from a previous browser session.
chrome.runtime.onStartup.addListener(() => chrome.storage.session.remove(TAB_MAP_KEY));

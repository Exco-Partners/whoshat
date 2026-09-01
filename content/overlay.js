/**
 * Who's Hat overlay.
 *
 * Draws a coloured frame around the viewport plus a notch at top centre naming
 * the persona this tab represents.
 *
 * Getting on top of arbitrary pages is the whole difficulty here:
 *
 *  - The overlay lives in a closed shadow root, so page CSS cannot restyle it
 *    and page scripts cannot see it.
 *  - The host is promoted to the browser's TOP LAYER via the popover API. Top
 *    layer paints above every normal page element whatever its z-index, which a
 *    plain high z-index cannot guarantee: the host is position:fixed, and fixed
 *    elements always create their own stacking context, so a z-index on the
 *    frame inside would be trapped in it. The host also carries a max z-index
 *    as a fallback for when showPopover() is unavailable.
 *  - Everything is pointer-events:none, so it never swallows a click -- which
 *    matters, because the frame covers the scrollbar.
 */
(() => {
  // chrome.runtime is undefined in a content script whose extension context has
  // been invalidated (the extension was reloaded or updated under us), and the
  // page's own window.chrome stub has no runtime either. Touching it would
  // throw an uncaught TypeError, so check before doing anything.
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;

  // A previous instance may still be live -- either this script was injected on
  // top of itself, or an older, now-orphaned copy is still holding listeners.
  // Tear it down and take over, so there is never more than one overlay.
  try {
    window.__whosHat?.destroy();
  } catch {
    // Orphaned instance; its listeners are dead anyway.
  }

  const BORDER = 6; // px, per spec

  let host = null;
  let shadow = null;
  let els = null;
  let current = null;
  let observer = null;

  // Mirror of readableTextColor() in shared/personas.js -- content scripts
  // cannot import modules, so keep the two in sync.
  function readableTextColor(hex) {
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

  function initials(name) {
    return (
      String(name || '?')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0] || '')
        .join('')
        .toUpperCase() || '?'
    );
  }

  const CSS = `
    /* display:block is declared unconditionally so the overlay still renders
       if showPopover() is unavailable -- it then falls back to the z-index. */
    :host {
      all: initial;
      display: block;
      position: fixed;
      inset: 0;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      overflow: visible;
      pointer-events: none;
      z-index: 2147483647;
    }

    * { box-sizing: border-box; }

    .frame {
      position: absolute;
      inset: 0;
      border: ${BORDER}px solid var(--wh-color);
      pointer-events: none;
    }

    .notch {
      position: absolute;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: min(60vw, 520px);
      padding: 5px 16px 6px 10px;
      background: var(--wh-color);
      color: var(--wh-text);
      border-radius: 0 0 10px 10px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
      font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      pointer-events: none;
    }

    .avatar {
      flex: none;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      object-fit: cover;
      background: rgba(255, 255, 255, 0.22);
      display: grid;
      place-items: center;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
      overflow: hidden;
    }
    img.avatar { display: block; }

    .text { min-width: 0; line-height: 1.15; }

    .name {
      font-size: 14px;
      font-weight: 650;
      letter-spacing: 0.01em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .role {
      font-size: 11px;
      font-weight: 500;
      opacity: 0.82;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .role:empty { display: none; }

    @media print { :host { display: none; } }
  `;

  function build() {
    host = document.createElement('div');
    host.id = 'whos-hat-overlay-host';
    host.setAttribute('aria-hidden', 'true');
    // "manual" so Escape and outside clicks cannot dismiss it.
    host.setAttribute('popover', 'manual');

    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const frame = document.createElement('div');
    frame.className = 'frame';

    const notch = document.createElement('div');
    notch.className = 'notch';

    const avatar = document.createElement('span');
    avatar.className = 'avatar';

    const text = document.createElement('div');
    text.className = 'text';
    const name = document.createElement('div');
    name.className = 'name';
    const role = document.createElement('div');
    role.className = 'role';
    text.append(name, role);

    notch.append(avatar, text);
    shadow.append(style, frame, notch);

    els = { frame, notch, avatar, name, role };
    watchForRemoval();
    watchFullscreen();
  }

  // Attach to <html> and promote into the top layer.
  function attach() {
    const root = document.documentElement;
    if (!root || !host) return;
    if (host.parentNode !== root) root.appendChild(host);
    promote();
  }

  function promote() {
    try {
      // Re-showing moves the host to the end of the top layer, so it stays
      // above anything added there after us (a fullscreen element, a <dialog>).
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // Popover unsupported or host not connected -- the z-index fallback in
      // the shadow CSS still applies.
    }
  }

  // Some sites rewrite <html>'s children (SPA boot, document.write). If our
  // host gets detached, put it straight back.
  function watchForRemoval() {
    const root = document.documentElement;
    if (!root) return;
    observer = new MutationObserver(() => {
      if (current && host && !host.isConnected) attach();
    });
    observer.observe(root, { childList: true });
  }

  // Entering fullscreen pushes that element into the top layer above us, so
  // re-promote to get back on top.
  function watchFullscreen() {
    document.addEventListener('fullscreenchange', onFullscreen);
  }

  function onFullscreen() {
    if (current && host?.isConnected) promote();
  }

  function renderAvatar(persona) {
    const next = document.createElement(persona.avatar ? 'img' : 'span');
    next.className = 'avatar';
    if (persona.avatar) {
      next.src = persona.avatar;
      next.alt = '';
    } else {
      next.textContent = initials(persona.name);
    }
    els.avatar.replaceWith(next);
    els.avatar = next;
  }

  function apply(persona) {
    if (!persona) return clear();
    if (!host) build();

    current = persona;
    const color = persona.color || '#3b82f6';
    host.style.setProperty('--wh-color', color);
    host.style.setProperty('--wh-text', readableTextColor(color));

    els.name.textContent = persona.name || '';
    els.role.textContent = persona.role || '';
    renderAvatar(persona);

    attach();
  }

  function clear() {
    current = null;
    if (!host) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
    } catch {
      /* not open */
    }
    host.remove();
  }

  function onMessage(msg) {
    if (msg?.type === 'APPLY') apply(msg.persona);
    else if (msg?.type === 'CLEAR') clear();
  }

  function destroy() {
    clear();
    observer?.disconnect();
    document.removeEventListener('fullscreenchange', onFullscreen);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Context already invalidated.
    }
    host = null;
    els = null;
  }

  window.__whosHat = { destroy };
  chrome.runtime.onMessage.addListener(onMessage);

  // Ask the service worker what this tab is wearing. Runs on every page load,
  // so the overlay survives navigation within an activated tab.
  chrome.runtime
    .sendMessage({ type: 'GET_STATE' })
    .then((res) => {
      if (res?.persona) apply(res.persona);
    })
    .catch(() => {});
})();

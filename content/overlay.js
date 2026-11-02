/**
 * Who's Hat overlay.
 *
 * Draws a coloured frame around the viewport plus a notch at top centre naming
 * the persona this tab represents, and an optional narrative bar along the
 * bottom edge.
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
 *  - The narrative bar cannot shrink the viewport, so the page is made to end
 *    above it instead. See reserveSpace() for how.
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
  let barObserver = null;
  let reserved = null; // { px, shell, saved, observer } while space is held

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
      max-width: min(70vw, 720px);
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

    .narrative {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 6px 16px ${BORDER + 2}px;
      background: var(--wh-color);
      color: var(--wh-text);
      box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.28);
      font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.35;
      text-align: center;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
      pointer-events: none;
    }
    .narrative:empty { display: none; }

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

    const narrative = document.createElement('div');
    narrative.className = 'narrative';

    shadow.append(style, frame, notch, narrative);

    els = { frame, notch, avatar, name, role, narrative };
    watchForRemoval();
    watchNarrativeHeight();
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

  // Reserve room at the foot of the page for the narrative bar. Re-measured
  // whenever the bar resizes (text wraps differently, the window narrows, the
  // narrative is cleared), and dropped to nothing when the bar is hidden.
  function watchNarrativeHeight() {
    document.addEventListener('DOMContentLoaded', recheckSpace);
    window.addEventListener('load', recheckSpace);
    if (typeof ResizeObserver === 'undefined') return;
    barObserver = new ResizeObserver(() => reserveSpace(els?.narrative.offsetHeight || 0));
    barObserver.observe(els.narrative);
  }

  // Two kinds of page need different treatment:
  //
  //  - Ordinary documents scroll the viewport. Padding the bottom of <html> by
  //    the bar's height lets the last of the content scroll clear of the bar.
  //  - App shells (Dynamics 365, Power Apps, most SPAs) pin <html>/<body> to
  //    the window height with overflow hidden and scroll inside a panel. Padding
  //    does nothing there, so instead <html> and <body> are cut down to end at
  //    the top of the bar, and the app lays itself out in the smaller box.
  //    They are also made position:relative: Dynamics' #shell-container is
  //    absolutely positioned with no positioned ancestor, so it sizes itself
  //    to the window and would ignore the shorter <body> otherwise.
  //
  // Styles are set inline with !important so no page stylesheet can beat them.
  // An observer watches the style attributes of <html> and <body> (and <body>
  // arriving): it puts our styles back if the page rewrites them, and catches
  // a page turning itself into an app shell after load -- Dynamics only sets
  // overflow:hidden on <body> from script once the app has booted, well after
  // DOMContentLoaded. The page's own inline values are restored on release.
  function isAppShell() {
    const hidden = (el) => el && /hidden|clip/.test(getComputedStyle(el).overflowY);
    return hidden(document.documentElement) || hidden(document.body);
  }

  function spaceRules(px) {
    const h = `calc(100vh - ${px}px)`;
    return reserved.shell
      ? [
          [document.documentElement, 'height', h],
          [document.documentElement, 'max-height', h],
          [document.documentElement, 'position', 'relative'],
          [document.body, 'height', h],
          [document.body, 'max-height', h],
          [document.body, 'position', 'relative']
        ]
      : [[document.documentElement, 'padding-bottom', `${px}px`]];
  }

  function applyReserved() {
    for (const [el, prop, value] of spaceRules(reserved.px)) {
      if (!el) continue;
      const key = el === document.body ? 'body' : 'html';
      const saved = (reserved.saved[key] ||= {});
      if (!(prop in saved)) {
        saved[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
      }
      // Only write when different, so our own writes don't re-trigger the
      // observer in reserveSpace() in a loop.
      if (el.style.getPropertyValue(prop) !== value || el.style.getPropertyPriority(prop) !== 'important') {
        el.style.setProperty(prop, value, 'important');
      }
    }
  }

  function reserveSpace(px) {
    if (!px) return releaseSpace();
    if (!document.documentElement) return;
    if (!reserved) {
      reserved = { px, shell: false, saved: {}, observer: null };
      reserved.observer = new MutationObserver(() => reserved && reserveSpace(reserved.px));
    }
    reserved.px = px;
    // Our own rules never change overflow, so re-detecting with them in place
    // is safe. A page can only move from ordinary to shell (once its CSS or
    // <body> arrives), never back, so there is no flapping.
    if (!reserved.shell && isAppShell()) {
      restoreSaved();
      reserved.shell = true;
    }
    applyReserved();
    reserved.observer.disconnect();
    reserved.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true
    });
    if (document.body) {
      reserved.observer.observe(document.body, { attributes: true, attributeFilter: ['style'] });
    }
  }

  // At document_start there is no <body> or page CSS yet, so the first check
  // can't spot an app shell. Look again once the page has loaded.
  function recheckSpace() {
    if (reserved) reserveSpace(reserved.px);
  }

  function restoreSaved() {
    for (const [key, props] of Object.entries(reserved.saved)) {
      const el = key === 'body' ? document.body : document.documentElement;
      if (!el) continue;
      for (const [prop, [value, priority]] of Object.entries(props)) {
        if (value) el.style.setProperty(prop, value, priority);
        else el.style.removeProperty(prop);
      }
    }
    reserved.saved = {};
  }

  function releaseSpace() {
    if (!reserved) return;
    reserved.observer.disconnect();
    restoreSaved();
    reserved = null;
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
    els.narrative.textContent = persona.narrative || '';
    renderAvatar(persona);

    attach();
  }

  function clear() {
    current = null;
    releaseSpace();
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
    barObserver?.disconnect();
    document.removeEventListener('DOMContentLoaded', recheckSpace);
    window.removeEventListener('load', recheckSpace);
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

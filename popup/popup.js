import {
  SWATCHES,
  newId,
  getPersonas,
  getTabMap,
  upsertPersona,
  deletePersona,
  readableTextColor,
  initials
} from '../shared/personas.js';

const $ = (id) => document.getElementById(id);

const views = { list: $('view-list'), edit: $('view-edit') };

let tab = null;          // the tab the popup was opened over
let activePersonaId = null;
let personas = [];
let draft = null;        // persona being added/edited

// --- boot --------------------------------------------------------------------

init();

async function init() {
  // Synchronous setup first, so nothing below delays the first paint.
  buildSwatches();
  wire();

  // All three reads are independent and all hit storage or the tab list
  // directly -- deliberately no message to the service worker, which would
  // otherwise have to cold-start before the menu could render.
  const t0 = performance.now();

  // Settled, not all: one failing read must not leave the menu blank forever.
  const [tabs, storedPersonas, tabMap] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
    getPersonas().catch(() => []),
    getTabMap().catch(() => ({}))
  ]);

  tab = tabs[0] || null;
  personas = storedPersonas;

  const assigned = tab ? tabMap[tab.id] : null;
  // Ignore a stale assignment pointing at a persona that has since been deleted.
  activePersonaId = personas.some((p) => p.id === assigned) ? assigned : null;

  if (tab && !canInject(tab.url)) $('unsupported').hidden = false;
  renderList();

  // Right-click the popup -> Inspect to see this. If it reads a few ms but the
  // menu still feels slow, the delay is Chrome opening the popup, not our code.
  console.log(`[WhosHat] menu ready in ${Math.round(performance.now() - t0)}ms`);
}

function canInject(url = '') {
  return /^(https?|file|ftp):/i.test(url) && !/^https:\/\/chromewebstore\.google\.com/i.test(url);
}

function show(name) {
  views.list.hidden = name !== 'list';
  views.edit.hidden = name !== 'edit';
}

// --- list view ---------------------------------------------------------------

function renderList() {
  const list = $('personas');
  list.replaceChildren();

  for (const p of personas) {
    const li = document.createElement('li');
    li.className = 'row' + (p.id === activePersonaId ? ' active' : '');

    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.title = p.id === activePersonaId ? 'Active on this tab' : `Activate ${p.name} on this tab`;
    pick.append(avatarNode(p), metaNode(p));
    pick.addEventListener('click', () => activate(p));

    const edit = document.createElement('button');
    edit.className = 'icon-btn';
    edit.title = `Edit ${p.name}`;
    edit.setAttribute('aria-label', `Edit ${p.name}`);
    edit.textContent = '✎';
    edit.addEventListener('click', () => openEditor(p));

    li.append(pick, edit);
    list.append(li);
  }

  $('empty').hidden = personas.length > 0;
  $('deactivate').disabled = !activePersonaId;

  const status = $('status');
  const active = personas.find((p) => p.id === activePersonaId);
  status.textContent = active ? `This tab: ${active.name}` : 'No persona';
  status.classList.toggle('on', Boolean(active));
}

function avatarNode(p) {
  if (p.avatar) {
    const img = document.createElement('img');
    img.className = 'dot';
    img.src = p.avatar;
    img.alt = '';
    return img;
  }
  const span = document.createElement('span');
  span.className = 'dot';
  span.style.background = p.color;
  span.style.color = readableTextColor(p.color);
  span.textContent = initials(p.name);
  return span;
}

function metaNode(p) {
  const meta = document.createElement('span');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = p.name;
  const role = document.createElement('div');
  role.className = 'role';
  role.textContent = p.role || '';
  meta.append(name, role);
  return meta;
}

async function activate(p) {
  if (!tab) return;
  // Clicking the persona already on this tab toggles it off.
  const next = p.id === activePersonaId ? null : p.id;
  const res = await chrome.runtime.sendMessage(
    next
      ? { type: 'ACTIVATE', tabId: tab.id, personaId: next }
      : { type: 'DEACTIVATE', tabId: tab.id }
  );
  activePersonaId = res?.persona?.id || null;
  renderList();

  if (next && res && res.applied === false) {
    const s = $('status');
    s.textContent = "Couldn't mark this page";
    s.classList.remove('on');
  }
}

// --- edit view ---------------------------------------------------------------

function buildSwatches() {
  const wrap = $('swatches');
  wrap.replaceChildren();
  for (const c of SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.title = c;
    b.setAttribute('aria-label', `Colour ${c}`);
    b.addEventListener('click', () => setColour(c));
    wrap.append(b);
  }
}

function setColour(c) {
  draft.color = c;
  $('f-colour').value = c;
  $('colour-hex').textContent = c;
  for (const b of $('swatches').children) {
    b.setAttribute('aria-pressed', String(b.style.background === hexToRgb(c)));
  }
  renderAvatarPreview();
}

// style.background round-trips through rgb(), so compare in that space.
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function openEditor(persona) {
  draft = persona
    ? { ...persona }
    : { id: newId(), name: '', role: '', color: SWATCHES[Math.floor(Math.random() * SWATCHES.length)], avatar: null };

  $('edit-title').textContent = persona ? 'Edit persona' : 'New persona';
  $('f-name').value = draft.name;
  $('f-role').value = draft.role || '';
  $('delete').hidden = !persona;
  $('confirm-delete').hidden = true;
  $('avatar-error').hidden = true;
  setColour(draft.color);
  renderAvatarPreview();
  show('edit');
  $('f-name').focus();
}

function renderAvatarPreview() {
  const box = $('avatar-preview');
  box.replaceChildren();
  box.style.background = draft.avatar ? 'transparent' : draft.color;
  box.style.color = readableTextColor(draft.color);
  if (draft.avatar) {
    const img = document.createElement('img');
    img.src = draft.avatar;
    img.alt = '';
    box.append(img);
  } else {
    box.textContent = initials($('f-name').value || draft.name);
  }
  $('clear-avatar').hidden = !draft.avatar;
}

// Downscale to a small square so avatars stay well inside the storage quota.
async function toAvatarDataUrl(file, size = 128) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size
  );
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.9);
}

// --- wiring ------------------------------------------------------------------

function wire() {
  $('add').addEventListener('click', () => openEditor(null));
  $('back').addEventListener('click', () => show('list'));
  $('cancel').addEventListener('click', () => show('list'));

  $('deactivate').addEventListener('click', async () => {
    if (!tab) return;
    await chrome.runtime.sendMessage({ type: 'DEACTIVATE', tabId: tab.id });
    activePersonaId = null;
    renderList();
  });

  $('f-colour').addEventListener('input', (e) => setColour(e.target.value));
  $('f-name').addEventListener('input', () => {
    if (!draft.avatar) renderAvatarPreview();
  });

  $('choose-avatar').addEventListener('click', () => $('f-avatar').click());
  $('f-avatar').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const err = $('avatar-error');
    err.hidden = true;
    try {
      draft.avatar = await toAvatarDataUrl(file);
      renderAvatarPreview();
    } catch {
      err.textContent = "That image couldn't be read. Try a PNG or JPEG.";
      err.hidden = false;
    }
  });

  $('clear-avatar').addEventListener('click', () => {
    draft.avatar = null;
    renderAvatarPreview();
  });

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    draft.name = $('f-name').value.trim();
    draft.role = $('f-role').value.trim();
    if (!draft.name) return;

    await upsertPersona(draft);
    personas = await getPersonas();
    renderList();
    show('list');
  });

  $('delete').addEventListener('click', () => {
    $('confirm-delete').hidden = false;
  });
  $('confirm-no').addEventListener('click', () => {
    $('confirm-delete').hidden = true;
  });
  $('confirm-yes').addEventListener('click', async () => {
    await deletePersona(draft.id);
    if (activePersonaId === draft.id) activePersonaId = null;
    personas = await getPersonas();
    renderList();
    show('list');
  });
}

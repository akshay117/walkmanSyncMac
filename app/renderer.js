/* WalkSync renderer: library view, edit drawer, tools. Talks to the engine via window.walksync. */
const api = window.walksync;
const $ = (id) => document.getElementById(id);

const state = {
  device: null,                    // { name, path }
  folder: load('folder', null),
  target: load('target', 'device'),
  tracks: new Map(),               // path -> record
  root: null,                      // folder the current list came from
  filter: 'all',
  query: '',
  sort: { key: 'artist', dir: 1 },
  view: [],                        // filtered + sorted paths
  selected: new Set(),
  anchor: null,
  listId: null, applyId: null,
  listTotal: 0, applyDone: 0, applyErrors: 0,
  busy: false,                     // a log-style task is running
  drawer: { open: false, paths: [], art: null },
  cands: [],
  logEmpty: true,
};
let engineOk = false;

function load(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fileUrl(p) { return 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F'); }
function human(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i < 2 ? 0 : 1)} ${u[i]}`;
}
const stem = (f) => f.replace(/\.[^.]+$/, '');
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// ═════════════════════════════ Library list ═════════════════════════════

function libraryReady() {
  return state.target === 'device' ? !!state.device : !!state.folder;
}

function loadLibrary() {
  if (state.listId) api.cancelStream(state.listId);
  state.tracks.clear();
  state.selected.clear();
  state.root = null;
  state.listId = null;
  closeDrawer();
  render();
  if (!libraryReady() || !engineOk) return;
  state.listTotal = 0;
  setEmpty(state.target === 'device' ? 'Reading songs on your Walkman…' : 'Reading your music folder…', true);
  api.list(state.target === 'device' ? { device: state.device.path } : { folder: state.folder })
    .then((id) => { state.listId = id; });
}

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 200);
}

api.onStream(({ id, msg }) => {
  if (id === state.listId) {
    if (msg.type === 'start') { state.root = msg.root; state.listTotal = msg.count; }
    else if (msg.type === 'track') {
      state.tracks.set(msg.track.path, msg.track);
      $('lib-sub').textContent = `Reading ${msg.i.toLocaleString()} of ${state.listTotal.toLocaleString()}…`;
      scheduleRender();
    } else if (msg.type === 'error') log(`Couldn't read ${msg.path}: ${msg.error}`, 'err');
  } else if (id === state.applyId) {
    if (msg.type === 'item') {
      state.applyDone++;
      state.tracks.set(msg.track.path, msg.track);
      log(msg.track.title || msg.track.file, 'item');
      for (const c of msg.changes) log(c, 'detail');
      if (!msg.changes.length) log('nothing to change, or nothing found online', 'detail');
      setProgress(msg.i, msg.n);
      scheduleRender();
    } else if (msg.type === 'error') {
      state.applyDone++; state.applyErrors++;
      log(`${msg.path.split('/').pop()}: ${msg.error}`, 'err');
      setProgress(msg.i, msg.n);
    }
  }
});

api.onStreamEnd(({ id, code, stderr }) => {
  if (id === state.listId) {
    state.listId = null;
    render();
    if (code !== 0 && stderr) setEmpty(stderr.split('\n').pop());
  } else if (id === state.applyId) {
    state.applyId = null;
    const ok = state.applyDone - state.applyErrors;
    finishTask(code === 0 && !state.applyErrors,
      `Updated ${plural(ok, 'song', 'songs')}${state.applyErrors ? `, ${state.applyErrors} failed` : ''}`);
    // a finished bulk auto-fix shouldn't leave its songs selected for the next action
    if (state.clearAfterApply) { state.selected.clear(); state.anchor = null; }
    render();
    if (state.drawer.open) fillDrawer(state.drawer.paths.filter((p) => state.tracks.has(p)));
    refreshSpace();
  }
});

function issues(t) {
  return { noart: !t.has_art, notags: t.missing.length > 0, badart: t.has_art && !t.art_ok };
}

function render() {
  const all = [...state.tracks.values()];
  const counts = { all: all.length, noart: 0, notags: 0, badart: 0 };
  for (const t of all) {
    const i = issues(t);
    if (i.noart) counts.noart++;
    if (i.notags) counts.notags++;
    if (i.badart) counts.badart++;
  }
  for (const k of Object.keys(counts)) $(`n-${k}`).textContent = counts[k].toLocaleString();
  $('chips').querySelector('[data-filter="badart"]').classList.toggle('hidden', !counts.badart && state.filter !== 'badart');

  const q = state.query.trim().toLowerCase();
  const { key, dir } = state.sort;
  const val = (t) => {
    if (key === 'tracknumber') return parseInt(t.tracknumber, 10) || 0;
    if (key === 'title') return (t.title || t.file).toLowerCase();
    return String(t[key] || '').toLowerCase() || '￿';
  };
  const tieKey = (t) => `${(t.album || '').toLowerCase()}\u0000${String(parseInt(t.tracknumber, 10) || 0).padStart(4, '0')}\u0000${t.file}`;
  state.view = all
    .filter((t) => state.filter === 'all' || issues(t)[state.filter])
    .filter((t) => !q || `${t.title} ${t.artist} ${t.album} ${t.albumartist} ${t.file}`.toLowerCase().includes(q))
    .sort((a, b) => {
      const x = val(a), y = val(b);
      if (x < y) return -dir;
      if (x > y) return dir;
      const ax = tieKey(a), bx = tieKey(b);
      return ax < bx ? -1 : ax > bx ? 1 : 0;
    })
    .map((t) => t.path);

  // The selection only ever holds songs that are visible right now. A song hidden by a
  // filter or search (or one that just left the filter after being fixed) is dropped,
  // so an edit can never reach songs the user can't see.
  const visible = new Set(state.view);
  for (const p of [...state.selected]) if (!visible.has(p)) state.selected.delete(p);
  if (state.anchor && !visible.has(state.anchor)) state.anchor = null;

  $('rows').innerHTML = state.view.map((p) => rowHtml(state.tracks.get(p))).join('');

  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === key);
    th.classList.toggle('desc', th.dataset.sort === key && dir < 0);
  }

  $('lib-title').textContent = state.target === 'device' ? (state.device ? state.device.name : 'Walkman') : 'Music folder';
  if (!state.listId) {
    const artists = new Set(all.map((t) => (t.albumartist || t.artist).toLowerCase()).filter(Boolean)).size;
    const albums = new Set(all.map((t) => t.album.toLowerCase()).filter(Boolean)).size;
    $('lib-sub').textContent = all.length
      ? `${plural(all.length, 'song', 'songs')} · ${plural(artists, 'artist', 'artists')} · ${plural(albums, 'album', 'albums')}`
      : '';
  }

  if (!libraryReady()) {
    setEmpty(state.target === 'device'
      ? '<div class="player-icon big"><div class="screen"></div><div class="wheel"></div></div><h3>Connect your Walkman</h3><p>Plug it in and choose <b>Data transfer</b> on the player. Your songs will appear here.</p>'
      : '<h3>No music folder chosen</h3><p>Choose the folder that holds your music in the sidebar.</p>');
  } else if (!all.length) {
    if (!state.listId && engineOk) setEmpty('<h3>No songs yet</h3><p>Use <b>Sync music</b> to copy songs over.</p>');
  } else if (!state.view.length) {
    setEmpty(state.filter !== 'all' && !q ? '<h3>Nothing to fix here</h3><p>Every song has what it needs.</p>' : '<h3>No matches</h3>');
  } else {
    $('empty').classList.add('hidden');
  }
  updateSelection();
}

function setEmpty(html, spinner = false) {
  $('empty').innerHTML = (spinner ? '<div class="spinner"></div>' : '') + (html.startsWith('<') ? html : `<p>${esc(html)}</p>`);
  $('empty').classList.remove('hidden');
}

function rowHtml(t) {
  const i = issues(t);
  const sel = state.selected.has(t.path);
  const art = t.thumb ? `<img loading="lazy" src="${esc(fileUrl(t.thumb))}" alt="">` : '<span class="noart">♪</span>';
  const badges = [];
  if (i.noart) badges.push('<span class="badge warn">No cover</span>');
  if (i.badart) badges.push('<span class="badge warn" title="This cover is a format the Walkman can\'t display (progressive or very large). Select it and choose Auto-fix to convert it.">Cover won\'t show</span>');
  if (i.notags) badges.push(`<span class="badge warn">No ${esc(t.missing.join(', '))}</span>`);
  if (!badges.length) badges.push('<span class="badge ok">✓</span>');
  return `<tr data-path="${esc(t.path)}" class="${sel ? 'sel' : ''}">
    <td class="c-check"><input type="checkbox" ${sel ? 'checked' : ''} tabindex="-1"></td>
    <td class="c-art"><div class="thumb">${art}</div></td>
    <td class="c-title">${t.title ? esc(t.title) : `<span class="missing">${esc(stem(t.file))}</span>`}</td>
    <td>${t.artist ? esc(t.artist) : '<span class="missing">Unknown artist</span>'}</td>
    <td>${t.album ? esc(t.album) : '<span class="missing">Unknown album</span>'}</td>
    <td class="c-num">${esc((t.tracknumber || '').split('/')[0])}</td>
    <td class="c-fmt"><span class="fmt">${esc(t.format)}</span></td>
    <td class="c-status">${badges.join('')}</td>
  </tr>`;
}

// ─── selection ───
$('rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const path = tr.dataset.path;
  const idx = state.view.indexOf(path);
  const onCheck = !!e.target.closest('.c-check');
  if (e.shiftKey && state.anchor && state.view.includes(state.anchor)) {
    const a = state.view.indexOf(state.anchor);
    const [lo, hi] = a < idx ? [a, idx] : [idx, a];
    if (!(e.metaKey || e.ctrlKey || onCheck)) state.selected.clear();
    for (let k = lo; k <= hi; k++) state.selected.add(state.view[k]);
  } else if (e.metaKey || e.ctrlKey || onCheck) {
    if (state.selected.has(path)) state.selected.delete(path); else state.selected.add(path);
    state.anchor = path;
  } else {
    state.selected.clear();
    state.selected.add(path);
    state.anchor = path;
    paintSelection();
    openDrawer();
    return;
  }
  paintSelection();
  if (state.drawer.open) state.selected.size ? openDrawer() : closeDrawer();
});

function paintSelection() {
  for (const tr of $('rows').children) {
    const on = state.selected.has(tr.dataset.path);
    tr.classList.toggle('sel', on);
    tr.querySelector('input').checked = on;
  }
  updateSelection();
}

function updateSelection() {
  const n = state.selected.size;
  $('selbar').classList.toggle('hidden', n === 0);
  $('sel-count').textContent = n.toLocaleString();
  const shown = state.view.length;
  const shownSel = state.view.filter((p) => state.selected.has(p)).length;
  $('check-all').checked = shown > 0 && shownSel === shown;
  $('check-all').indeterminate = shownSel > 0 && shownSel < shown;
  for (const id of ['sel-auto', 'sel-edit', 'sel-cover']) $(id).disabled = !!state.applyId || state.busy;
}

$('check-all').onchange = (e) => {
  if (e.target.checked) state.view.forEach((p) => state.selected.add(p));
  else state.view.forEach((p) => state.selected.delete(p));
  paintSelection();
  if (state.drawer.open) state.selected.size ? openDrawer() : closeDrawer();
};
$('sel-clear').onclick = () => { state.selected.clear(); paintSelection(); closeDrawer(); };

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName) && document.activeElement.type !== 'checkbox';
  if (e.key === 'Escape') {
    if (state.drawer.open) closeDrawer();
    else { state.selected.clear(); paintSelection(); }
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !typing) {
    e.preventDefault();
    state.view.forEach((p) => state.selected.add(p));
    paintSelection();
  }
});

// ─── filters, search, sort ───
for (const b of $('chips').querySelectorAll('button')) {
  b.onclick = () => {
    if (state.filter === b.dataset.filter) return;
    state.filter = b.dataset.filter;
    for (const x of $('chips').querySelectorAll('button')) x.classList.toggle('active', x === b);
    // a new filter is a new task: start with nothing selected
    state.selected.clear();
    state.anchor = null;
    closeDrawer();
    render();
  };
}
$('search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
for (const th of document.querySelectorAll('th[data-sort]')) {
  th.onclick = () => {
    const k = th.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
    render();
  };
}

// ─── bulk actions ───
const selectedPaths = () => state.view.filter((p) => state.selected.has(p));

$('sel-auto').onclick = () => {
  const paths = selectedPaths();
  if (!paths.length) return;
  runApply(paths.map((path) => ({ path, auto: true })), true, `Auto-fixing ${plural(paths.length, 'song', 'songs')}`, true);
};
$('sel-edit').onclick = () => openDrawer();
$('sel-cover').onclick = async () => {
  const file = await api.pickImage();
  if (!file) return;
  openDrawer();
  if (state.drawer.open) setPendingArt({ file, preview: fileUrl(file) });
};

async function runApply(edits, online, title, clearAfter = false) {
  if (state.applyId || state.busy || !state.root) return;
  state.clearAfterApply = clearAfter;
  startTask(title);
  state.applyDone = 0; state.applyErrors = 0;
  $('cancel-btn').classList.remove('hidden');
  state.applyId = await api.apply({ edits, root: state.root, online });
  updateSelection();
  updateTools();
  updateSave();
}

// ═════════════════════════════ Edit drawer ═════════════════════════════

function openDrawer() {
  const paths = selectedPaths();
  if (!paths.length) return;
  state.drawer.open = true;
  $('layout').classList.add('drawer-open');
  fillDrawer(paths);
}

function closeDrawer() {
  state.drawer.open = false;
  $('layout').classList.remove('drawer-open');
}
$('dr-close').onclick = closeDrawer;

function common(recs, key) {
  const vals = new Set(recs.map((r) => r[key] || ''));
  return vals.size === 1 ? [...vals][0] : null;   // null = mixed
}

function fillDrawer(paths) {
  const recs = paths.map((p) => state.tracks.get(p)).filter(Boolean);
  if (!recs.length) { closeDrawer(); return; }
  state.drawer.paths = recs.map((r) => r.path);
  state.drawer.art = null;
  const n = recs.length;
  const one = n === 1;
  $('dr-title').textContent = one ? 'Edit song' : `Edit ${n} songs`;

  for (const input of $('dr-form').querySelectorAll('input')) {
    const key = input.dataset.key;
    const perSong = key === 'title' || key === 'tracknumber';
    const v = common(recs, key);
    input.disabled = !one && perSong;
    input.value = one || !perSong ? (v ?? '') : '';
    input.placeholder = !one && perSong ? 'Different for each song' : v === null ? 'Mixed — leave blank to keep' : '';
    input.dataset.orig = input.value;
    input.classList.remove('changed');
  }

  const thumbs = new Set(recs.map((r) => r.thumb || ''));
  const thumb = thumbs.size === 1 ? [...thumbs][0] : null;
  showCover(thumb ? fileUrl(thumb) : null, thumbs.size > 1 ? 'Mixed covers' : 'No cover');
  $('dr-new').classList.add('hidden');
  $('dr-undo-cover').classList.add('hidden');

  const cantArt = recs.filter((r) => !r.can_embed).length;
  const missing = recs.filter((r) => !r.has_art).length;
  const notes = [];
  if (one) notes.push(`${recs[0].format}${recs[0].bitrate ? ` · ${recs[0].bitrate} kbps` : ''} · ${recs[0].rel}`);
  else if (missing) notes.push(`${missing} of ${n} have no cover.`);
  if (cantArt) notes.push(one ? "This format can't hold cover art." : `${plural(cantArt, 'song is in a format', 'songs are in formats')} that can't hold cover art.`);
  $('dr-note').textContent = notes.join(' ');
  const names = recs.map((r) => r.title || stem(r.file));
  $('dr-applies').classList.toggle('hidden', one);
  $('dr-applies').innerHTML = one ? '' : `<b>Saving applies to these ${n} songs:</b><ul>${
    names.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;

  const first = recs[0];
  $('q-artist').value = common(recs, 'artist') || first.artist || (one ? guessArtist(first.file) : '');
  $('q-title').value = one ? (first.title || guessTitle(first.file)) : '';
  $('q-album').value = common(recs, 'album') || '';
  $('q-results').innerHTML = '';
  updateSave();
}

function guessParts(file) {
  return stem(file).replace(/^\d{1,3}[\s.\-_]+/, '').replace(/_/g, ' ').split(/\s+[-–—]\s+/);
}
function guessTitle(file) { const p = guessParts(file); return p.length > 1 ? p.slice(1).join(' - ') : p[0]; }
function guessArtist(file) { const p = guessParts(file); return p.length > 1 ? p[0] : ''; }

function showCover(src, emptyText = 'No cover') {
  const img = $('dr-img');
  if (src) {
    img.onerror = () => { img.classList.add('hidden'); $('dr-noimg').classList.remove('hidden'); $('dr-noimg').textContent = 'Preview unavailable'; };
    img.src = src;
    img.classList.remove('hidden');
    $('dr-noimg').classList.add('hidden');
  } else {
    img.classList.add('hidden');
    img.removeAttribute('src');
    $('dr-noimg').classList.remove('hidden');
    $('dr-noimg').textContent = emptyText;
  }
}

function setPendingArt(art) {
  if (!state.drawer.open) return;
  state.drawer.art = art;
  showCover(art.preview || null, 'New cover');
  $('dr-new').classList.remove('hidden');
  $('dr-undo-cover').classList.remove('hidden');
  updateSave();
}

$('dr-undo-cover').onclick = () => {
  const recs = state.drawer.paths.map((p) => state.tracks.get(p));
  const thumbs = new Set(recs.map((r) => r.thumb || ''));
  const thumb = thumbs.size === 1 ? [...thumbs][0] : null;
  state.drawer.art = null;
  showCover(thumb ? fileUrl(thumb) : null, thumbs.size > 1 ? 'Mixed covers' : 'No cover');
  $('dr-new').classList.add('hidden');
  $('dr-undo-cover').classList.add('hidden');
  for (const x of $('q-results').querySelectorAll('.cand')) x.classList.remove('picked');
  updateSave();
};

$('dr-pick').onclick = async () => {
  const file = await api.pickImage();
  if (file) setPendingArt({ file, preview: fileUrl(file) });
};

const drop = $('dr-cover');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = [...e.dataTransfer.files].find((x) => /^image\//.test(x.type) || /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(x.name));
  if (!f) return;
  const file = api.pathForFile(f);
  if (file) setPendingArt({ file, preview: fileUrl(file) });
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

$('dr-form').addEventListener('input', (e) => {
  const i = e.target;
  i.classList.toggle('changed', i.value !== i.dataset.orig);
  updateSave();
});

function collectTags() {
  const tags = {};
  for (const input of $('dr-form').querySelectorAll('input')) {
    if (input.disabled) continue;
    if (input.value.trim() !== (input.dataset.orig || '').trim()) tags[input.dataset.key] = input.value.trim();
  }
  return tags;
}

function updateSave() {
  const changes = Object.keys(collectTags()).length + (state.drawer.art ? 1 : 0);
  const n = state.drawer.paths.length;
  $('dr-save').disabled = !changes || !!state.applyId || state.busy;
  $('dr-save').textContent = n > 1 ? `Save to ${n} songs` : 'Save';
  $('dr-revert').disabled = !changes;
}

$('dr-revert').onclick = () => fillDrawer(state.drawer.paths);

$('dr-save').onclick = () => {
  const tags = collectTags();
  const pa = state.drawer.art;
  const art = pa ? (pa.url ? { url: pa.url } : { file: pa.file }) : null;
  const edits = state.drawer.paths.map((p) => {
    const t = state.tracks.get(p);
    const e = { path: p };
    if (Object.keys(tags).length) e.tags = tags;
    if (art && t.can_embed) e.art = art;
    return e;
  }).filter((e) => e.tags || e.art);
  if (!edits.length) return;
  runApply(edits, false, `Saving ${plural(edits.length, 'song', 'songs')}`);
};

// ─── online search ───
$('q-go').onclick = search;
for (const id of ['q-artist', 'q-title', 'q-album']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });

async function search() {
  const q = { artist: $('q-artist').value.trim(), title: $('q-title').value.trim(), album: $('q-album').value.trim() };
  if (!q.artist && !q.title && !q.album) return;
  $('q-results').innerHTML = '<div class="spinner small"></div>';
  $('q-go').disabled = true;
  const r = await api.search(q);
  $('q-go').disabled = false;
  const cands = r.candidates || [];
  state.cands = cands;
  if (!cands.length) {
    $('q-results').innerHTML = `<p class="small muted">${r.errors && r.errors.length
      ? `Couldn't reach the music databases: ${esc(r.errors.join('; '))}`
      : 'Nothing found. Try fewer words, or just the artist and album.'}</p>`;
    return;
  }
  $('q-results').innerHTML = cands.map((c, i) => `
    <button class="cand" data-i="${i}">
      <div class="cand-art"><span>No cover</span>${c.thumb_url ? `<img src="${esc(c.thumb_url)}" alt="" loading="lazy">` : ''}</div>
      <div class="cand-meta">
        <b>${esc(c.album || c.title)}</b>
        <span>${esc(c.artist)}${c.date ? ` · ${esc(c.date)}` : ''}</span>
        <em>${esc(c.source)}</em>
      </div>
    </button>`).join('') + (r.errors && r.errors.length ? `<p class="small muted">Some sources failed: ${esc(r.errors.join('; '))}</p>` : '');
  for (const img of $('q-results').querySelectorAll('img')) img.onerror = () => img.remove();
}

$('q-results').addEventListener('click', (e) => {
  const b = e.target.closest('.cand');
  if (!b) return;
  const c = state.cands[+b.dataset.i];
  for (const x of $('q-results').querySelectorAll('.cand')) x.classList.toggle('picked', x === b);
  const one = state.drawer.paths.length === 1;
  const set = (key, v) => {
    const input = $('dr-form').querySelector(`[data-key="${key}"]`);
    if (!v || input.disabled) return;
    input.value = v;
    input.classList.toggle('changed', input.value !== input.dataset.orig);
  };
  if (one) { set('title', c.title); set('tracknumber', c.tracknumber); }
  set('artist', c.artist);
  set('album', c.album);
  set('date', c.date);
  set('genre', c.genre);
  if (!$('dr-form').querySelector('[data-key="albumartist"]').value) set('albumartist', c.artist);
  if (c.art_url && b.querySelector('img')) setPendingArt({ url: c.art_url, preview: c.thumb_url });
  else updateSave();
});

// ═════════════════════════════ Tools (sync, dedupe, clean) ═════════════════════════════

for (const id of ['opt-fix', 'opt-online', 'opt-dry']) {
  const el = $(id);
  el.checked = load(id, el.checked);
  el.addEventListener('change', () => save(id, el.checked));
}
const opt = (id) => $(id).checked;

function log(line, kind = 'out') {
  const box = $('log');
  if (state.logEmpty) { box.innerHTML = ''; state.logEmpty = false; }
  const div = document.createElement('div');
  div.className = `line ${kind}`;
  const m = line.match(/^\[(\d+)\/(\d+)\]\s+(.*)$/);
  if (m) {
    setProgress(+m[1], +m[2]);
    div.classList.add('item');
    div.textContent = m[3];
  } else if (/^\s{3,}/.test(line)) {
    div.classList.add('detail');
    div.textContent = line.trim();
  } else {
    if (/^\s*KEEP\s/.test(line)) div.classList.add('keep');
    if (/^\s*remove\s/.test(line)) div.classList.add('remove');
    div.textContent = line;
  }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(div);
  while (box.childElementCount > 4000) box.firstChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function setProgress(i, n) {
  $('progress').classList.remove('hidden');
  $('progress-bar').style.width = `${Math.round((i / n) * 100)}%`;
  $('task-title').textContent = `${state.task} — ${i} of ${n}`;
}

function showLog(open) {
  $('activity').classList.toggle('collapsed', !open);
  $('toggle-log').textContent = open ? 'Hide log' : 'Show log';
}
$('toggle-log').onclick = () => showLog($('activity').classList.contains('collapsed'));

function startTask(title) {
  state.task = title;
  $('apply-dupes').classList.add('hidden');
  $('progress-bar').style.width = '0%';
  if (!state.logEmpty) log('');
  log(`▸ ${title}`, 'head');
  $('dot').className = 'dot running';
  $('task-title').textContent = title;
  showLog(true);
}

function finishTask(ok, summary, cancelled = false) {
  $('dot').className = `dot ${cancelled ? '' : ok ? 'ok' : 'bad'}`;
  $('progress').classList.add('hidden');
  $('cancel-btn').classList.toggle('hidden', !state.busy);
  $('task-title').textContent = summary || `${state.task} — ${cancelled ? 'cancelled' : ok ? 'done' : 'failed'}`;
  if (summary) log(summary, ok ? 'info' : 'err');
  updateSelection();
  updateTools();
  updateSave();
}

function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle('busy', busy);
  $('cancel-btn').classList.toggle('hidden', !busy);
  updateTools();
}

async function runTask(title, args, after) {
  if (state.busy || state.applyId) return;
  state.after = after;
  startTask(title);
  setBusy(true);
  const r = await api.run(args);
  if (!r.ok) { log(r.error, 'err'); setBusy(false); finishTask(false); }
}

api.onLog(({ line, kind }) => log(line, kind));
api.onDone(({ code, cancelled }) => {
  setBusy(false);
  finishTask(code === 0, null, cancelled);
  const after = state.after; state.after = null;
  if (after) after(code);
  if (!opt('opt-dry')) loadLibrary();
  refreshSpace();
});
$('cancel-btn').onclick = () => (state.applyId ? api.cancelStream(state.applyId) : api.cancel());

const deviceArgs = () => (state.device ? ['--device', state.device.path] : []);
const dry = () => (opt('opt-dry') ? ['--dry-run'] : []);

$('act-sync').onclick = async () => {
  if (!state.folder && !(await pickFolder())) return;
  const args = ['sync', state.folder, ...deviceArgs(), ...dry()];
  if (opt('opt-fix')) args.push('--fix');
  if (opt('opt-fix') && opt('opt-online')) args.push('--online');
  runTask(opt('opt-dry') ? 'Previewing sync' : 'Syncing', args);
};

$('act-dedupe').onclick = () => {
  const base = ['dedupe', ...(state.target === 'library' ? [state.folder] : []), ...deviceArgs()];
  runTask('Finding duplicates', base, (code) => {
    const n = $('log').querySelectorAll('.line.remove').length;
    if (code === 0 && n) {
      state.dedupeArgs = [...base, '--apply'];
      $('apply-dupes').textContent = `Move ${plural(n, 'duplicate', 'duplicates')} out`;
      $('apply-dupes').classList.remove('hidden');
    }
  });
};

$('apply-dupes').onclick = () => {
  if (!state.dedupeArgs) return;
  if (!confirm('Move the duplicates listed in the log to "Music/Walkman Duplicates" on your Mac?\n\nNothing is permanently deleted; you can review that folder and trash it later.')) return;
  const args = state.dedupeArgs;
  state.dedupeArgs = null;
  runTask('Moving duplicates', args);
};

$('act-clean').onclick = () => runTask('Cleaning macOS junk', ['clean', ...deviceArgs(), ...dry()]);

function updateTools() {
  const busy = state.busy || !!state.applyId;
  $('act-sync').disabled = busy || !state.device;
  $('act-clean').disabled = busy || !state.device;
  $('act-dedupe').disabled = busy || !libraryReady();
  $('eject-btn').disabled = busy;
}

// ═════════════════════════════ Target, folder, device ═════════════════════════════

for (const b of $('target').querySelectorAll('button')) {
  b.onclick = () => {
    if (state.target === b.dataset.target) return;
    state.target = b.dataset.target;
    save('target', state.target);
    renderTarget();
    loadLibrary();
  };
}
function renderTarget() {
  for (const b of $('target').querySelectorAll('button')) b.classList.toggle('active', b.dataset.target === state.target);
  updateTools();
}

async function pickFolder() {
  const f = await api.pickFolder('Choose your music folder');
  if (f) {
    state.folder = f;
    save('folder', f);
    renderFolder();
    if (state.target === 'library') loadLibrary();
  }
  return f;
}
$('folder-btn').onclick = pickFolder;
function renderFolder() {
  $('folder').textContent = state.folder ? state.folder.replace(/^\/Users\/[^/]+/, '~') : 'No folder chosen';
  $('folder').title = state.folder || '';
  $('folder').classList.toggle('muted', !state.folder);
  updateTools();
}

api.onDevices((devices) => {
  const prev = state.device && state.device.path;
  state.device = devices.find((d) => d.path === prev) || devices[0] || null;
  renderDevice();
  const now = state.device && state.device.path;
  if (now === prev) return;
  if (now) {
    log(`Walkman connected: ${state.device.name}`, 'info');
    if (state.target !== 'device') { state.target = 'device'; save('target', 'device'); renderTarget(); }
  } else {
    log('Walkman disconnected', 'info');
  }
  if (state.target === 'device') loadLibrary();
  refreshSpace();
});

function renderDevice() {
  $('device-empty').classList.toggle('hidden', !!state.device);
  $('device-info').classList.toggle('hidden', !state.device);
  if (state.device) $('dev-name').textContent = state.device.name;
  updateTools();
}

async function refreshSpace() {
  if (!state.device) return;
  const s = await api.space(state.device.path);
  if (s.error) return;
  $('dev-bar').style.width = `${Math.round((s.used / s.total) * 100)}%`;
  $('dev-used').textContent = `${human(s.used)} used`;
  $('dev-free').textContent = `${human(s.free)} free`;
}

$('open-btn').onclick = () => state.device && api.open(state.device.path + '/MUSIC');
$('eject-btn').onclick = async () => {
  if (!state.device) return;
  const name = state.device.name;
  const r = await api.eject(state.device.path);
  log(r.ok ? `Ejected ${name}. You can unplug it now; it will rebuild its library.` : `Eject failed: ${r.error}`, r.ok ? 'info' : 'err');
  if (!r.ok) showLog(true);
};

// ═════════════════════════════ First-run engine setup ═════════════════════════════

async function ensureEngine() {
  const env = await api.checkEnv();
  if (env.ready) { engineOk = true; loadLibrary(); return; }
  $('setup').classList.remove('hidden');
  if (!env.python) {
    $('setup-msg').innerHTML = 'WalkSync needs Python 3. Open Terminal and run <code>brew install python</code> (or <code>xcode-select --install</code>), then click Check again.';
    $('setup-btn').textContent = 'Check again';
  }
  $('setup-btn').onclick = async () => {
    $('setup-btn').disabled = true;
    $('setup-btn').textContent = 'Installing…';
    const fresh = await api.checkEnv();
    let ok = fresh.ready;
    if (!ok && fresh.python) {
      const r = await api.installEnv();
      ok = r.ok;
      if (!ok) { $('setup-err').textContent = r.error; $('setup-err').classList.remove('hidden'); }
    }
    if (ok) {
      engineOk = true;
      $('setup').classList.add('hidden');
      loadLibrary();
    } else {
      $('setup-btn').disabled = false;
      $('setup-btn').textContent = fresh.python ? 'Try again' : 'Check again';
    }
  };
}

renderFolder();
renderTarget();
renderDevice();
render();
ensureEngine();

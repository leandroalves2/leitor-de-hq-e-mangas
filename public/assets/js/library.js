import {
  state, progressOf, statusOf, metaOf, readCount, filesUnder, parseName, isFav, toggleFav,
  collectionNames, inCollection, toggleInCollection, createCollection, renameCollection, deleteCollection
} from './state.js';
import { coverUrl, watchCovers } from './thumbs.js';
import { api, platform } from './api.js';
import { $, $$, esc, fmtSize, norm, folderHash, readHash, parentOf, baseName, stripExt, hashCode, prefs, toast } from './util.js';

export const DRAG_TYPE = 'application/x-comicstream';
const DIR = 'dir:';
const keyName = (key) => (key.startsWith(DIR) ? baseName(key.slice(DIR.length)) : stripExt(baseName(key)));

const TINT = { pdf: 'red', cbz: 'blue', zip: 'blue', cbr: 'pink', rar: 'pink', cb7: 'purple', '7z': 'purple' };
const tint = (ext) => TINT[ext] || 'green';
const tilt = (path) => ((Math.abs(hashCode(path)) % 5) - 2) * 0.7 || -1;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const collectionHash = (name) => `#/c/${encodeURIComponent(name)}`;

const FILTER_LABEL = { unread: 'Não lidos', reading: 'Lendo', done: 'Lidos' };

function cover(file, label) {
  const url = coverUrl(file);
  if (url) return `<img class="cover-img" src="${esc(url)}" alt="" loading="lazy" decoding="async">`;
  if (!file) return `<div class="ph ph-yellow"><span>${esc(label || '?')}</span></div>`;
  return `<div class="ph ph-${tint(file.ext)}" data-need="${esc(file.path)}"><span>${esc(label || file.ext)}</span></div>`;
}

function actions(file) {
  const fav = isFav(file.path);
  return `<div class="card-acts">
    <button class="act act-fav${fav ? ' on' : ''}" data-act="fav" data-path="${esc(file.path)}" title="${fav ? 'Remover dos favoritos' : 'Favoritar'}" aria-pressed="${fav}"><svg class="ic"><use href="#i-star"/></svg></button>
    <button class="act" data-act="collect" data-path="${esc(file.path)}" title="Adicionar a uma coleção"><svg class="ic"><use href="#i-plus"/></svg></button>
    <button class="act act-del" data-act="delete" data-path="${esc(file.path)}" title="Apagar (vai para a lixeira)"><svg class="ic"><use href="#i-trash"/></svg></button>
  </div>`;
}

function folderActions(folder) {
  return `<div class="card-acts">
    <button class="act" data-act="collect" data-path="${esc(DIR + folder.path)}" title="Adicionar a pasta inteira a uma coleção"><svg class="ic"><use href="#i-plus"/></svg></button>
    <button class="act act-del" data-act="delete" data-path="${esc(DIR + folder.path)}" title="Apagar pasta (vai para a lixeira)"><svg class="ic"><use href="#i-trash"/></svg></button>
  </div>`;
}

function comicCard(file, n, { showWhere = false } = {}) {
  const p = progressOf(file.path);
  const status = statusOf(file.path);
  const pct = p ? Math.round((p.page / p.total) * 100) : 0;
  const title = file.kind === 'image' ? file.name : stripExt(file.name);
  const meta = metaOf(file);
  const { issue, year } = file.kind === 'image' ? {} : parseName(meta && meta.title ? meta.title : file.name);
  const where = showWhere ? (parentOf(file.path) || 'Estante') : '';
  const metaTitle = meta && meta.title && norm(meta.title) !== norm(title) ? meta.title : '';
  const bits = [];
  if (status === 'reading') bits.push(`Pág. ${p.page} de ${p.total}`);
  else if (meta && meta.pages) bits.push(`${meta.pages} pág.`);
  if (year) bits.push(year);
  if (status !== 'reading') bits.push(fmtSize(file.size));
  return `<a class="card comic" href="${readHash(file.path)}" draggable="true" data-key="${esc(file.path)}" style="--tilt:${tilt(file.path)}deg;--n:${n}">
    <div class="cover">${cover(file)}
      <span class="fmt fmt-${tint(file.ext)}">${esc(file.ext)}</span>
      ${issue ? `<span class="issue">#${esc(issue)}</span>` : ''}
      ${status === 'done' ? '<span class="stamp">Lido!</span>' : ''}
      ${status === 'reading' ? '<span class="play"><svg class="ic"><use href="#i-play"/></svg></span>' : ''}
      ${actions(file)}
    </div>
    ${status === 'reading' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    <div class="meta"><h3 title="${esc(title)}">${esc(title)}</h3>${metaTitle ? `<small class="mtitle" title="${esc(metaTitle)}">${esc(metaTitle)}</small>` : ''}${where ? `<small class="where" title="${esc(where)}">${esc(where)}</small>` : ''}<small>${esc(bits.join(' · '))}</small></div>
  </a>`;
}

function folderCard(folder, n) {
  const file = folder.cover ? state.files.get(folder.cover) : null;
  const read = readCount(folder);
  const bits = [];
  if (folder.folders.length) bits.push(plural(folder.folders.length, 'pasta', 'pastas'));
  bits.push(fmtSize(folder.size));
  if (read) bits.push(`${read} lida${read === 1 ? '' : 's'}`);
  return `<a class="card folder" href="${folderHash(folder.path)}" draggable="true" data-key="${esc(DIR + folder.path)}" style="--tilt:${tilt(folder.path)}deg;--n:${n}">
    <div class="cover">${cover(file, 'HQ')}<span class="count">${plural(folder.count, 'HQ', 'HQs')}</span>${folderActions(folder)}</div>
    <div class="meta"><h3 title="${esc(folder.name)}"><svg class="ic"><use href="#i-folder"/></svg>${esc(folder.name)}</h3><small>${esc(bits.join(' · '))}</small></div>
  </a>`;
}

function collectionEntries(name) {
  const folders = [];
  const files = [];
  for (const key of state.collections.collections[name] || []) {
    if (key.startsWith(DIR)) {
      const folder = state.folders.get(key.slice(DIR.length));
      if (folder) folders.push(folder);
    } else if (state.files.has(key)) {
      files.push(state.files.get(key));
    }
  }
  return { folders, files };
}

function collectionItems(name) {
  const { folders, files } = collectionEntries(name);
  const seen = new Set();
  const out = [];
  for (const f of [...folders.flatMap(filesUnder), ...files]) {
    if (!seen.has(f.path)) { seen.add(f.path); out.push(f); }
  }
  return out;
}

function collectionCard(name, n) {
  const items = collectionItems(name);
  const done = items.filter((f) => statusOf(f.path) === 'done').length;
  return `<a class="card folder collection" href="${collectionHash(name)}" data-drop-col="${esc(name)}" style="--tilt:${tilt(name)}deg;--n:${n}">
    <div class="cover">${cover(items[0], 'Vazia')}<span class="count">${plural(items.length, 'HQ', 'HQs')}</span></div>
    <div class="meta"><h3 title="${esc(name)}"><svg class="ic"><use href="#i-stack"/></svg>${esc(name)}</h3><small>Coleção${done ? ` · ${done} lida${done === 1 ? '' : 's'}` : ''}</small></div>
  </a>`;
}

const newCollectionCard = (n) => `<button class="card new-col" data-act="new-collection" data-drop-new="1" style="--n:${n}">
  <div class="cover"><div class="ph ph-yellow"><span>+</span></div></div>
  <div class="meta"><h3>Nova coleção</h3><small>Agrupe suas sagas</small></div>
</button>`;

function sortItems(items, sort) {
  if (sort === 'recent') return [...items].sort((a, b) => b.mtime - a.mtime);
  if (sort === 'size') return [...items].sort((a, b) => b.size - a.size);
  return items;
}

function homeCrumb(current) {
  return current
    ? '<span class="crumb current"><svg class="ic"><use href="#i-home"/></svg>Estante</span>'
    : '<a class="crumb" href="#/"><svg class="ic"><use href="#i-home"/></svg>Estante</a>';
}

function folderCrumbs(folder) {
  const parts = folder.path ? folder.path.split('/') : [];
  return homeCrumb(!parts.length) + parts.map((name, i) => {
    const path = parts.slice(0, i + 1).join('/');
    const last = i === parts.length - 1;
    return `<span class="sep">›</span>${last ? `<span class="crumb current">${esc(name)}</span>` : `<a class="crumb" href="${folderHash(path)}">${esc(name)}</a>`}`;
  }).join('');
}

function emptyState(kind) {
  if (kind === 'offline') {
    return `<div class="empty"><div class="burst-wrap"><div class="burst big burst-red">Ops!</div></div>
      <h2>Servidor desligado</h2>
      <p>${platform === 'desktop' ? 'O servidor interno do app não respondeu. Feche o ComicStream e abra de novo.' : 'Não consegui falar com o servidor PHP. Rode o <code>iniciar.bat</code> na pasta do projeto e recarregue a página.'}</p>
      <button class="btn btn-yellow" data-action="reload">Tentar de novo</button></div>`;
  }
  if (kind === 'search') {
    return `<div class="empty"><div class="burst-wrap"><div class="burst big">Hmm?</div></div>
      <h2>Nada encontrado</h2><p>Nenhuma HQ, pasta ou coleção combina com essa busca.</p></div>`;
  }
  if (kind === 'filter') {
    return `<div class="empty"><div class="burst-wrap"><div class="burst big">Zap!</div></div>
      <h2>Nada por aqui</h2><p>Nenhuma HQ com esse filtro nesta pasta. Troque o filtro para "Todos".</p></div>`;
  }
  if (kind === 'fav') {
    return `<div class="empty"><div class="burst-wrap"><div class="burst big">Ei!</div></div>
      <h2>Nenhum favorito ainda</h2><p>Passe o mouse numa HQ e clique na estrela para guardar aqui.</p></div>`;
  }
  if (kind === 'collection') {
    return `<div class="empty"><div class="burst-wrap"><div class="burst big">Vazia!</div></div>
      <h2>Coleção vazia</h2><p>Na estante, passe o mouse numa HQ e clique no <b>+</b> para adicionar aqui.</p></div>`;
  }
  return `<div class="empty"><div class="burst-wrap"><div class="burst big">Pow!</div></div>
    <h2>Sua estante está vazia</h2>
    <p>${api.local
      ? `Use o botão <b>Enviar</b>, baixe pelo <b>Drive</b> ou copie pelo cabo USB para <code>${esc(api.libraryLabel || '')}</code>.`
      : platform === 'desktop'
        ? 'Arraste HQs para esta janela, use <b>Enviar</b>, baixe pelo <b>Drive</b> ou abra a pasta da biblioteca em <b>Configurações</b>.'
        : 'Arraste HQs para esta janela, use <b>Enviar</b>, baixe pelo <b>Drive</b> ou copie os arquivos para a pasta <code>uploads</code> do projeto.'}</p>
    <p class="formats">PDF · CBZ · CBR · CB7 · ZIP · JPG · PNG · WEBP</p>
    <button class="btn btn-yellow" data-action="upload"><svg class="ic"><use href="#i-upload"/></svg><span>Enviar HQs</span></button></div>`;
}

function renderShelves(show) {
  const cont = $('#continue');
  const favs = $('#favorites');
  const cols = $('#collections');
  if (!show) { cont.hidden = true; favs.hidden = true; cols.hidden = true; return; }

  const reading = Object.entries(state.progress)
    .filter(([path, p]) => p.page < p.total && state.files.has(path))
    .sort((a, b) => b[1].updated - a[1].updated)
    .slice(0, 14)
    .map(([path]) => state.files.get(path));
  cont.hidden = !reading.length;
  if (reading.length) {
    $('#continue-row').innerHTML = reading.map((f, i) => comicCard(f, i, { showWhere: true })).join('');
    watchCovers($('#continue-row'));
  }

  const favFiles = state.collections.favorites.map((p) => state.files.get(p)).filter(Boolean).slice(0, 14);
  favs.hidden = !favFiles.length;
  if (favFiles.length) {
    $('#favorites-row').innerHTML = favFiles.map((f, i) => comicCard(f, i, { showWhere: true })).join('');
    watchCovers($('#favorites-row'));
  }

  cols.hidden = false;
  const names = collectionNames();
  $('#collections-row').innerHTML = names.map(collectionCard).join('') + newCollectionCard(names.length);
  watchCovers($('#collections-row'));
}

function grid(html) {
  const el = $('#grid');
  el.innerHTML = html;
  watchCovers(el);
}

function applyFilter(files) {
  const filter = prefs.get('filter', 'all');
  return filter === 'all' ? files : files.filter((f) => statusOf(f.path) === filter);
}

function syncToolbar() {
  const sort = prefs.get('sort', 'name');
  const filter = prefs.get('filter', 'all');
  $$('#sort [data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === sort)));
  $$('#filter [data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
}

function renderSearch(query) {
  const tokens = query.split(/\s+/).filter(Boolean);
  const match = (text) => { const n = norm(text); return tokens.every((t) => n.includes(t)); };
  const folders = [...state.folders.values()].filter((f) => f.path && match(f.path)).slice(0, 60);
  const cols = collectionNames().filter(match);
  const files = [...state.files.values()].filter((f) => {
    const meta = metaOf(f);
    return match(f.path + (meta && meta.title ? ` ${meta.title}` : ''));
  }).slice(0, 200);
  $('#crumbs').innerHTML = `<span class="crumb current">Busca: ${esc($('#search').value.trim())}</span><button class="crumb crumb-clear" data-action="clear-search" title="Limpar busca">✕</button>`;
  const total = folders.length + cols.length + files.length;
  $('#stats').textContent = plural(total, 'resultado', 'resultados');
  grid(total
    ? cols.map(collectionCard).join('') + folders.map(folderCard).join('') + files.map((f, i) => comicCard(f, i + folders.length, { showWhere: true })).join('')
    : emptyState('search'));
}

function renderFolder() {
  const folder = state.folders.get(state.folderPath) || state.root;
  const sort = prefs.get('sort', 'name');
  const filter = prefs.get('filter', 'all');
  renderShelves(folder === state.root && filter === 'all');
  $('#crumbs').innerHTML = folderCrumbs(folder) + (folder.path
    ? `<button class="crumb crumb-tool crumb-add" data-act="collect" data-path="${esc(DIR + folder.path)}" title="Adicionar esta pasta inteira a uma coleção"><svg class="ic"><use href="#i-stack"/></svg>Coleção</button>`
    : '');

  if (filter !== 'all') {
    const files = sortItems(applyFilter(filesUnder(folder)), sort);
    $('#stats').textContent = `${FILTER_LABEL[filter]}: ${plural(files.length, 'HQ', 'HQs')}`;
    grid(files.length ? files.map((f, i) => comicCard(f, i, { showWhere: true })).join('') : emptyState('filter'));
    return;
  }

  const folders = sortItems(folder.folders, sort);
  const files = sortItems(folder.files, sort);
  const stats = [];
  if (folders.length) stats.push(plural(folders.length, 'pasta', 'pastas'));
  if (files.length) stats.push(plural(files.length, 'HQ', 'HQs'));
  stats.push(fmtSize(folder.size));
  $('#stats').textContent = stats.join(' · ');
  if (!folders.length && !files.length) { grid(emptyState('empty')); return; }
  grid(folders.map(folderCard).join('') + files.map((f, i) => comicCard(f, i + folders.length)).join(''));
}

function renderFavorites() {
  renderShelves(false);
  $('#crumbs').innerHTML = `${homeCrumb(false)}<span class="sep">›</span><span class="crumb current crumb-pink"><svg class="ic"><use href="#i-star"/></svg>Favoritos</span>`;
  const files = sortItems(applyFilter(state.collections.favorites.map((p) => state.files.get(p)).filter(Boolean)), prefs.get('sort', 'name'));
  $('#stats').textContent = plural(files.length, 'favorito', 'favoritos');
  grid(files.length ? files.map((f, i) => comicCard(f, i, { showWhere: true })).join('') : emptyState('fav'));
}

function renderCollection() {
  renderShelves(false);
  const name = state.collection;
  if (!state.collections.collections[name]) { location.replace('#/'); return; }
  $('#crumbs').innerHTML = `${homeCrumb(false)}<span class="sep">›</span><span class="crumb current"><svg class="ic"><use href="#i-stack"/></svg>${esc(name)}</span>
    <button class="crumb crumb-tool" data-act="rename-collection" title="Renomear coleção"><svg class="ic"><use href="#i-edit"/></svg></button>
    <button class="crumb crumb-tool crumb-danger" data-act="delete-collection" title="Apagar coleção"><svg class="ic"><use href="#i-trash"/></svg></button>`;
  const sort = prefs.get('sort', 'name');
  const total = collectionItems(name).length;
  $('#stats').textContent = plural(total, 'HQ', 'HQs');
  if (prefs.get('filter', 'all') !== 'all') {
    const files = sortItems(applyFilter(collectionItems(name)), sort);
    grid(files.length ? files.map((f, i) => comicCard(f, i, { showWhere: true })).join('') : emptyState('filter'));
    return;
  }
  const { folders, files } = collectionEntries(name);
  grid(folders.length + files.length
    ? folders.map(folderCard).join('') + sortItems(files, sort).map((f, i) => comicCard(f, i + folders.length, { showWhere: true })).join('')
    : emptyState('collection'));
}

export function renderSkeleton() {
  $('#grid').innerHTML = Array.from({ length: 12 }, () => '<div class="card skeleton"><div class="cover"></div><div class="meta"><i></i><i style="width:60%"></i></div></div>').join('');
}

export function renderLibrary() {
  syncToolbar();
  if (!state.root) {
    renderShelves(false);
    $('#crumbs').innerHTML = homeCrumb(true);
    $('#stats').textContent = '';
    $('#grid').innerHTML = emptyState('offline');
    return;
  }
  const query = norm($('#search').value.trim());
  if (query) { renderShelves(false); renderSearch(query); return; }
  if (state.view === 'fav') renderFavorites();
  else if (state.view === 'collection') renderCollection();
  else renderFolder();
}

function refreshCards() {
  const y = window.scrollY;
  renderLibrary();
  window.scrollTo(0, y);
}

function closeCollectMenu() {
  const menu = $('#collect-menu');
  if (!menu.hidden) {
    menu.hidden = true;
    refreshCards();
  }
}

function paintCollectMenu(path) {
  const menu = $('#collect-menu');
  const names = collectionNames();
  menu.dataset.path = path;
  const isDir = path.startsWith(DIR);
  menu.innerHTML = `<p class="menu-title">${isDir ? `Pasta "${esc(keyName(path))}" na coleção` : 'Adicionar à coleção'}</p>
    ${names.length ? names.map((n) => `<button class="col-opt${inCollection(n, path) ? ' on' : ''}" data-col="${esc(n)}"><span class="check"><svg class="ic"><use href="#i-check"/></svg></span>${esc(n)}</button>`).join('') : '<p>Nenhuma coleção ainda.</p>'}
    <form class="new-col-form"><input name="name" maxlength="60" placeholder="Nova coleção..." value="${isDir ? esc(keyName(path)) : ''}" autocomplete="off"><button class="btn btn-yellow sm" type="submit" title="Criar"><svg class="ic"><use href="#i-plus"/></svg></button></form>`;
}

function openCollectMenu(path, anchor) {
  const menu = $('#collect-menu');
  paintCollectMenu(path);
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.max(8, Math.min(document.documentElement.clientWidth - w - 8, r.right - w));
  const top = r.bottom + 8 + h > window.innerHeight && r.top - h - 8 > 0 ? r.top - h - 8 : r.bottom + 8;
  menu.style.left = `${left + window.scrollX}px`;
  menu.style.top = `${top + window.scrollY}px`;
}

export function initLibraryActions() {
  const menu = $('#collect-menu');
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    const opt = e.target.closest('[data-col]');
    if (!opt) return;
    const added = toggleInCollection(opt.dataset.col, menu.dataset.path);
    opt.classList.toggle('on', added);
  });
  menu.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = menu.querySelector('input');
    const name = createCollection(input.value);
    if (!name) return;
    if (!inCollection(name, menu.dataset.path)) toggleInCollection(name, menu.dataset.path);
    toast(`Coleção "${name}" criada`, 'ok', 1800);
    paintCollectMenu(menu.dataset.path);
    menu.querySelector('input').focus();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCollectMenu(); });
  initDrag();

  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!e.target.closest('#collect-menu') && !(act && act.dataset.act === 'collect')) closeCollectMenu();
    if (!act || act.closest('#reader')) return;
    e.preventDefault();
    e.stopPropagation();
    const path = act.dataset.path;
    switch (act.dataset.act) {
      case 'fav': {
        const on = toggleFav(path);
        act.classList.toggle('on', on);
        act.setAttribute('aria-pressed', String(on));
        toast(on ? 'Favoritado!' : 'Removido dos favoritos', on ? 'ok' : 'info', 1500);
        refreshCards();
        break;
      }
      case 'collect':
        if (!$('#collect-menu').hidden && $('#collect-menu').dataset.path === path) closeCollectMenu();
        else openCollectMenu(path, act);
        break;
      case 'new-collection': {
        const name = createCollection(window.prompt('Nome da nova coleção:', '') || '');
        if (name) location.hash = collectionHash(name);
        break;
      }
      case 'rename-collection': {
        const to = window.prompt('Novo nome da coleção:', state.collection);
        if (to && renameCollection(state.collection, to)) location.replace(collectionHash(to.trim().slice(0, 60)));
        else if (to) toast('Esse nome já existe ou é inválido', 'err');
        break;
      }
      case 'delete':
        trash(path);
        break;
      case 'delete-collection':
        if (window.confirm(`Apagar a coleção "${state.collection}"? As HQs continuam na estante.`)) {
          deleteCollection(state.collection);
          location.hash = '#/';
        }
        break;
      default:
    }
  }, true);
}

async function trash(key) {
  const isDir = key.startsWith(DIR);
  const rel = isDir ? key.slice(DIR.length) : key;
  const label = isDir ? `a pasta "${baseName(rel)}" e tudo dentro dela` : `"${baseName(rel)}"`;
  if (!window.confirm(`Apagar ${label}?\n\nNada é apagado de vez: vai para a pasta storage/lixeira do projeto.`)) return;
  try {
    await api.postJson('delete', { path: rel });
  } catch (e) {
    toast(`Não consegui apagar: ${e.message}`, 'err', 6000);
    return;
  }
  const gone = (p) => p === rel || p.startsWith(`${rel}/`) || p === key || p.startsWith(`${DIR}${rel}/`);
  state.collections.favorites = state.collections.favorites.filter((p) => !gone(p));
  for (const name of Object.keys(state.collections.collections)) {
    state.collections.collections[name] = state.collections.collections[name].filter((p) => !gone(p));
  }
  api.postJson('collections', state.collections).catch(() => {});
  toast(`Apagado: ${baseName(rel)}`, 'ok', 2200);
  window.dispatchEvent(new CustomEvent('cs:reload'));
}

function addToCollection(name, key) {
  if (inCollection(name, key)) {
    toast(`Já está em "${name}"`, 'info', 1800);
    return;
  }
  toggleInCollection(name, key);
  toast(`"${keyName(key)}" adicionado a "${name}"`, 'ok', 2200);
  refreshCards();
}

function paintDock() {
  const dock = $('#drag-dock');
  const names = collectionNames();
  dock.innerHTML = `<span class="dock-title">Solte numa coleção</span>
    ${names.map((n) => `<div class="dock-target" data-drop-col="${esc(n)}"><svg class="ic"><use href="#i-stack"/></svg>${esc(n)}</div>`).join('')}
    <div class="dock-target dock-new" data-drop-new="1"><svg class="ic"><use href="#i-plus"/></svg>Nova coleção</div>`;
}

function initDrag() {
  const dock = $('#drag-dock');
  let dragKey = null;
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest && e.target.closest('.card[data-key]');
    if (!card) return;
    dragKey = card.dataset.key;
    e.dataTransfer.setData(DRAG_TYPE, dragKey);
    e.dataTransfer.setData('text/plain', keyName(dragKey));
    e.dataTransfer.effectAllowed = 'copyLink';
    closeCollectMenu();
    paintDock();
    dock.hidden = false;
    document.body.classList.add('dragging-card');
  });
  const endDrag = () => {
    dragKey = null;
    dock.hidden = true;
    document.body.classList.remove('dragging-card');
    $$('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
  };
  window.addEventListener('dragend', endDrag, true);
  window.addEventListener('drop', () => setTimeout(endDrag, 0), true);
  window.addEventListener('hashchange', endDrag);
  const target = (e) => e.target.closest && e.target.closest('[data-drop-col], [data-drop-new]');
  document.addEventListener('dragover', (e) => {
    const t = target(e);
    if (!t || !dragKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $$('.drop-hover').forEach((n) => { if (n !== t) n.classList.remove('drop-hover'); });
    t.classList.add('drop-hover');
  });
  document.addEventListener('dragleave', (e) => {
    const t = target(e);
    if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-hover');
  });
  document.addEventListener('drop', (e) => {
    const t = target(e);
    if (!t || !dragKey) return;
    e.preventDefault();
    e.stopPropagation();
    const key = dragKey;
    endDrag();
    if (t.dataset.dropNew) {
      const name = createCollection(window.prompt('Nome da nova coleção:', keyName(key)) || '');
      if (name) addToCollection(name, key);
    } else {
      addToCollection(t.dataset.dropCol, key);
    }
  });
}

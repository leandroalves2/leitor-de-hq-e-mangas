import { api, platform } from './api.js';
import { initDrive } from './drive.js';
import { initSettings } from './settings.js';
import { state, setLibrary } from './state.js';
import { renderLibrary, renderSkeleton, initLibraryActions } from './library.js';
import { renderStats } from './stats.js';
import { initReader, openReader, closeReader, readerIsOpen, readerPath } from './reader.js';
import { initUpload, pickFiles } from './upload.js';
import { $, prefs, toast, folderHash, parentOf, debounce, isTyping } from './util.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdfjs/pdf.worker.min.js';

let fromLibrary = false;
let lastView = '';

async function loadLibrary(silent = false) {
  try {
    setLibrary(await api.get('tree'));
    return true;
  } catch (e) {
    if (!silent) toast(`Não consegui ler a estante: ${e.message}`, 'err', 6000);
    return false;
  }
}

function decodeHash() {
  const h = location.hash.replace(/^#/, '');
  const pick = (prefix) => { try { return decodeURIComponent(h.slice(prefix.length)); } catch { return ''; } };
  if (h.startsWith('/r/')) return { view: 'read', path: pick('/r/') };
  if (h.startsWith('/f/')) return { view: 'lib', path: pick('/f/') };
  if (h.startsWith('/c/')) return { view: 'collection', name: pick('/c/') };
  if (h === '/fav') return { view: 'fav' };
  if (h === '/stats') return { view: 'stats' };
  return { view: 'lib', path: '' };
}

function exitReader() {
  if (fromLibrary) {
    fromLibrary = false;
    history.back();
  } else {
    location.replace(folderHash(state.folderPath));
  }
}

function route() {
  const r = decodeHash();
  if (r.view === 'read') {
    if (readerIsOpen() && readerPath() === r.path) return;
    const file = state.files.get(r.path);
    if (!file) {
      toast('Essa HQ não está mais na estante', 'err');
      location.replace('#/');
      return;
    }
    state.folderPath = parentOf(file.path);
    renderLibrary();
    lastView = 'read';
    openReader(file, { onExit: exitReader });
    return;
  }
  if (readerIsOpen()) closeReader();
  fromLibrary = false;
  const statsView = r.view === 'stats';
  $('#library').hidden = statsView;
  $('#stats-view').hidden = !statsView;
  if (statsView) {
    renderStats();
    window.scrollTo({ top: 0 });
    lastView = 'stats';
    return;
  }
  if (r.view === 'fav' || r.view === 'collection') {
    state.view = r.view;
    state.collection = r.name || '';
    $('#search').value = '';
    renderLibrary();
    window.scrollTo({ top: 0 });
    lastView = r.view;
    return;
  }
  state.view = 'folder';
  const path = state.folders.has(r.path) ? r.path : '';
  const changed = path !== state.folderPath || lastView !== 'read';
  state.folderPath = path;
  renderLibrary();
  if (changed && lastView !== 'read') window.scrollTo({ top: 0 });
  lastView = 'lib';
}

async function refresh(manual = false) {
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  const ok = await loadLibrary(!manual);
  btn.classList.remove('spin');
  if (ok && !readerIsOpen()) renderLibrary();
  if (ok && manual) toast('Estante atualizada!', 'ok', 1800);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#btn-theme use').setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  $('#btn-theme').title = theme === 'dark' ? 'Tema claro' : 'Tema escuro';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#221f2c' : '#ffd60a';
}

function toggleMenu(force) {
  const menu = $('#upload-menu');
  const open = force === undefined ? menu.hidden : force;
  menu.hidden = !open;
  $('#btn-upload').setAttribute('aria-expanded', String(open));
}

function bindLibrary() {
  const search = $('#search');
  search.addEventListener('input', debounce(renderLibrary, 120));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; renderLibrary(); search.blur(); }
  });

  $('#filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    prefs.set('filter', b.dataset.filter);
    renderLibrary();
  });

  $('#sort').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    prefs.set('sort', b.dataset.sort);
    renderLibrary();
  });

  $('#btn-upload').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  $('#upload-menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    toggleMenu(false);
    pickFiles(b.dataset.pick);
  });
  $('#btn-refresh').addEventListener('click', () => refresh(true));
  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    prefs.set('theme', next);
    applyTheme(next);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) toggleMenu(false);
    if (e.target.closest('a.card.comic')) fromLibrary = true;
    const action = e.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'upload') pickFiles('files');
    if (action.dataset.action === 'reload') refresh(true);
    if (action.dataset.action === 'clear-search') { search.value = ''; renderLibrary(); search.focus(); }
  });

  document.addEventListener('keydown', (e) => {
    if (readerIsOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') toggleMenu(false);
    if (isTyping(e.target)) return;
    if (e.key === '/') { e.preventDefault(); search.focus(); search.select(); }
    if (e.key === 'Backspace' && state.folderPath) {
      e.preventDefault();
      location.hash = folderHash(parentOf(state.folderPath));
    }
  });

  window.addEventListener('focus', () => {
    if (!readerIsOpen() && Date.now() - state.loadedAt > 20000) refresh(false);
  });
}

const IGNORED = /cancel|destroyed|AbortError|aborted/i;

function reportError(message) {
  const text = String(message || 'erro desconhecido');
  if (IGNORED.test(text)) return;
  console.error('[ComicStream]', text);
  toast(`Erro: ${text}`, 'err', 8000);
}

window.addEventListener('error', (e) => reportError(e.message));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason && e.reason.message ? e.reason.message : e.reason));

let installPrompt = null;

function initPwa() {
  if (platform === 'web' && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('#btn-install').hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    $('#btn-install').hidden = true;
    toast('ComicStream instalado! Procure o ícone na área de trabalho ou na tela inicial.', 'ok', 4000);
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    $('#btn-install').hidden = true;
  });
}

function trackTopbar() {
  const bar = document.querySelector('.topbar');
  const set = () => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
  set();
  if ('ResizeObserver' in window) new ResizeObserver(set).observe(bar);
  const fs = () => {
    document.documentElement.classList.toggle('fs', !!document.fullscreenElement);
    set();
    window.dispatchEvent(new Event('resize'));
  };
  document.addEventListener('fullscreenchange', fs);
  document.body.addEventListener('transitionend', set);
}

async function boot() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  trackTopbar();
  window.addEventListener('cs:reload', () => refresh(false));
  document.documentElement.dataset.platform = platform;
  initPwa();
  initLibraryActions();
  initDrive();
  initSettings();
  initReader();
  initUpload(() => refresh(false));
  bindLibrary();
  renderSkeleton();
  await loadLibrary();
  window.addEventListener('hashchange', route);
  route();
}

boot();

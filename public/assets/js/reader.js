import { api } from './api.js';
import { state, siblingsOf, progressOf, isFav, toggleFav, saveMeta } from './state.js';
import { createSource } from './sources.js';
import { analyzePage } from './panels.js';
import { $, $$, esc, clamp, debounce, prefs, toast, stripExt, parentOf, baseName, readHash, isTyping } from './util.js';

const R = {
  open: false,
  token: 0,
  pageToken: 0,
  file: null,
  progressPath: '',
  chapters: [],
  source: null,
  total: 0,
  page: 0,
  mode: prefs.get('mode', 'single'),
  dir: prefs.get('dir', 'ltr'),
  fit: prefs.get('fit', 'screen'),
  zoom: 1,
  img: null,
  natural: null,
  book: null,
  bookMap: null,
  bookPad: 0,
  bookSize: '',
  sp: null,
  io: null,
  center: null,
  near: new Set(),
  preload: [],
  onExit: null,
  idle: 0,
  overBars: false,
  drag: null,
  dragMoved: false,
  touch: null,
  wheelAcc: 0,
  wheelAt: 0,
  wheelFlip: 0,
  lastScroll: 0,
  bookBox: null,
  bookHandlers: true,
  hi: new Map(),
  cropEl: null,
  guided: false,
  step: 0,
  guidedScale: 1,
  analysis: new Map(),
  seen: new Set(),
  lastInput: Date.now(),
  adj: null
};

const ADJ_DEFAULT = { brightness: 100, contrast: 100, saturate: 100, sepia: 0, crop: false };
const PRESETS = {
  normal: { brightness: 100, contrast: 100, saturate: 100, sepia: 0 },
  night: { brightness: 82, contrast: 95, saturate: 80, sepia: 45 },
  paper: { brightness: 106, contrast: 120, saturate: 85, sepia: 0 },
  punch: { brightness: 102, contrast: 112, saturate: 140, sepia: 0 }
};
R.adj = { ...ADJ_DEFAULT, ...prefs.get('adjust', {}) };

const stats = { pages: 0, seconds: 0, night: 0, finished: new Set() };
let nextPre = null;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function flushStats() {
  if (!stats.pages && stats.seconds < 5 && !stats.finished.size) return;
  const body = { day: today(), pages: stats.pages, seconds: stats.seconds, night: stats.night, finished: [...stats.finished] };
  stats.pages = 0;
  stats.seconds = 0;
  stats.night = 0;
  stats.finished.clear();
  api.postJson('stats', body).catch(() => {});
}

function countPages(list) {
  const night = new Date().getHours() < 5;
  for (const i of list) {
    if (R.seen.has(i)) continue;
    R.seen.add(i);
    stats.pages++;
    if (night) stats.night++;
  }
}

setInterval(() => {
  if (R.open && !document.hidden && Date.now() - R.lastInput < 120000) stats.seconds += 10;
}, 10000);
setInterval(flushStats, 60000);

function discardNext() {
  if (!nextPre) return;
  nextPre.promise.then((s) => { if (s) s.destroy(); });
  nextPre = null;
}

function preloadNext() {
  const next = chapterAt(1);
  if (!next || (nextPre && nextPre.path === next.path)) return;
  discardNext();
  const promise = createSource(next, siblingsOf(next))
    .then((src) => {
      src.url(0).then((u) => { if (u && src.remote) { const im = new Image(); im.src = u; } });
      return src;
    })
    .catch(() => null);
  nextPre = { path: next.path, promise };
}

let el;
let stage;

const saveProgress = debounce(() => {
  if (!R.progressPath || !R.total) return;
  const page = R.page + 1;
  if (page >= R.total && R.file && R.file.kind !== 'image') stats.finished.add(R.progressPath);
  state.progress[R.progressPath] = { page, total: R.total, updated: Math.floor(Date.now() / 1000) };
  api.postJson('progress', { path: R.progressPath, page, total: R.total }).catch(() => {});
}, 700);

export const readerIsOpen = () => R.open;
export const readerPath = () => (R.open && R.file ? R.file.path : null);

export async function openReader(file, { onExit } = {}) {
  saveProgress.flush();
  const token = ++R.token;
  unmount();
  teardownSource();

  R.open = true;
  R.file = file;
  R.onExit = onExit || R.onExit;
  R.chapters = siblingsOf(file);
  const images = file.kind === 'image';
  R.progressPath = images ? R.chapters[0].path : file.path;
  const folderName = baseName(parentOf(file.path)) || 'Estante';
  $('#r-title').textContent = images ? folderName : stripExt(file.name);
  $('#r-sub').textContent = images ? `${R.chapters.length} imagens` : folderName;
  document.title = `${$('#r-title').textContent} · ComicStream`;

  el.hidden = false;
  document.body.classList.add('reading');
  hideEnd();
  toggleDrawer(false);
  toggleHelp(false);
  loading(true, 0);
  syncControls();

  let source;
  let opening = true;
  let pre = null;
  if (nextPre && nextPre.path === file.path) { pre = nextPre.promise; nextPre = null; } else discardNext();
  try {
    source = (pre && await pre) || await createSource(file, R.chapters, (p) => { if (opening && token === R.token) loading(true, p); });
    opening = false;
  } catch (e) {
    opening = false;
    if (token !== R.token) return;
    loading(false);
    toast(e && e.message ? e.message : 'Não foi possível abrir este arquivo', 'err', 6000);
    exit();
    return;
  }
  if (token !== R.token) { source.destroy(); return; }

  R.source = source;
  R.total = source.count;
  R.zoom = 1;
  const saved = progressOf(R.progressPath);
  let start = images ? Math.max(0, R.chapters.indexOf(file)) : 0;
  const resume = saved && saved.page < saved.total && start === 0 && saved.page > 1;
  if (resume) start = saved.page - 1;
  R.analysis = new Map();
  R.seen = new Set();
  R.guided = false;
  if (file.kind === 'pdf' && source.doc) {
    source.doc.getMetadata().then((m) => saveMeta(file, { title: m && m.info && m.info.Title, pages: source.count })).catch(() => {});
  } else if (file.kind === 'archive') {
    saveMeta(file, { pages: source.count });
  }
  R.page = clamp(start, 0, R.total - 1);

  const slider = $('#r-slider');
  slider.max = String(R.total);
  slider.value = String(R.page + 1);
  renderChapters();
  syncControls();
  await mount();
  if (token !== R.token) return;
  loading(false);
  if (resume) toast(`Continuando da página ${R.page + 1}`, 'info', 2200);
  wake();
  stage.focus({ preventScroll: true });
}

export function closeReader() {
  if (!R.open) return;
  saveProgress.flush();
  flushStats();
  discardNext();
  R.token++;
  unmount();
  teardownSource();
  R.open = false;
  R.file = null;
  el.hidden = true;
  el.classList.remove('ui-hidden');
  document.body.classList.remove('reading');
  document.title = 'ComicStream';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function exit() {
  if (R.onExit) R.onExit();
  else closeReader();
}

function teardownSource() {
  if (R.source) R.source.destroy();
  R.source = null;
  R.total = 0;
  R.preload = [];
}

function loading(on, progress) {
  $('#r-loading').hidden = !on;
  const bar = $('#r-load-bar');
  bar.parentElement.classList.toggle('indeterminate', !progress);
  bar.style.width = `${Math.round((progress || 0) * 100)}%`;
}

async function mount() {
  unmount();
  if (!R.source) return;
  stage.className = `r-stage mode-${R.mode}`;
  if (R.mode === 'book') await mountBook();
  else if (R.mode === 'scroll') mountScroll();
  else mountSingle();
  afterChange();
}

function unmount() {
  R.pageToken++;
  if (R.book) {
    try { R.book.destroy(); } catch {}
    R.book = null;
  }
  if (R.io) { R.io.disconnect(); R.io = null; }
  if (R.center) { R.center.disconnect(); R.center = null; }
  R.sp = null;
  R.near.clear();
  R.bookMap = null;
  R.bookBox = null;
  for (const h of R.hi.values()) URL.revokeObjectURL(h.url);
  R.hi.clear();
  if (el) el.classList.remove('zoomed');
  R.img = null;
  R.cropEl = null;
  hideGuidedUi();
  R.natural = null;
  if (stage) {
    stage.innerHTML = '';
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
    stage.classList.remove('pannable', 'panning', 'busy');
  }
}

function mountSingle() {
  stage.innerHTML = '<div class="single"><div class="crop"><img class="page-img" alt="" draggable="false"></div></div>';
  R.img = stage.querySelector('.page-img');
  R.cropEl = stage.querySelector('.crop');
  stage.classList.toggle('guided', R.guided);
  showPage(R.page);
}

function analysisFor(i, img) {
  const key = `${i}:${R.dir}`;
  if (!R.analysis.has(key)) {
    const source = img || (R.page === i ? R.img : null);
    if (!source || !source.naturalWidth) return null;
    R.analysis.set(key, analyzePage(source, R.dir));
  }
  return R.analysis.get(key);
}

function cropBox() {
  if (!R.adj.crop || R.guided) return { x: 0, y: 0, w: 1, h: 1 };
  const a = analysisFor(R.page);
  return a && a.bounds ? a.bounds : { x: 0, y: 0, w: 1, h: 1 };
}

function guidedRects() {
  const a = analysisFor(R.page);
  return a && a.panels.length ? a.panels : [{ x: 0, y: 0, w: 1, h: 1 }];
}

function hideGuidedUi() {
  const spot = document.getElementById('r-spot');
  const chip = document.getElementById('r-chip');
  if (spot) spot.hidden = true;
  if (chip) chip.hidden = true;
}

function applyGuided(animate = true) {
  if (!R.img || !R.natural) return;
  const bars = barSpace();
  const sw = stage.clientWidth;
  const sh = stage.clientHeight - bars.top - bars.bottom;
  const rects = guidedRects();
  R.step = clamp(R.step, 0, rects.length - 1);
  const r = rects[R.step];
  const { w, h } = R.natural;
  const s = Math.min((sw * 0.94) / (r.w * w), (sh * 0.94) / (r.h * h));
  R.guidedScale = s * (w / Math.max(1, sw));
  const tx = sw / 2 - (r.x + r.w / 2) * w * s;
  const ty = bars.top + sh / 2 - (r.y + r.h / 2) * h * s;
  R.cropEl.style.width = '';
  R.cropEl.style.height = '';
  const img = R.img;
  const spot = $('#r-spot');
  img.style.transition = animate ? '' : 'none';
  spot.style.transition = animate ? '' : 'none';
  img.style.left = '0px';
  img.style.top = '0px';
  img.style.width = `${w}px`;
  img.style.height = `${h}px`;
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  const many = rects.length > 1;
  spot.hidden = !many;
  if (many) {
    spot.style.width = `${r.w * w * s}px`;
    spot.style.height = `${r.h * h * s}px`;
    spot.style.transform = `translate(${tx + r.x * w * s}px, ${ty + r.y * h * s}px)`;
  }
  const chip = $('#r-chip');
  chip.hidden = false;
  chip.textContent = many ? `Quadro ${R.step + 1} de ${rects.length}` : 'Página inteira';
  stage.classList.remove('pannable');
  if (!animate) requestAnimationFrame(() => { img.style.transition = ''; spot.style.transition = ''; });
}

function guidedStep(delta) {
  const rects = guidedRects();
  const next = R.step + delta;
  if (next >= 0 && next < rects.length) {
    R.step = next;
    applyGuided();
    sharpenSoon();
    return;
  }
  const target = R.page + delta;
  if (target >= R.total) { showEnd(); return; }
  if (target < 0) return;
  hideEnd();
  showPage(target, { step: delta > 0 ? 'first' : 'last' });
}

function toggleGuided(force) {
  if (!R.source) return;
  const on = force === undefined ? !R.guided : force;
  if (on && R.mode !== 'single') {
    R.guided = true;
    setMode('single');
    return;
  }
  R.guided = on;
  R.zoom = 1;
  stage.classList.toggle('guided', on);
  if (R.img) {
    R.img.style.transform = '';
    R.img.style.transition = '';
  }
  if (on) {
    R.step = 0;
    applyGuided(false);
    if (guidedRects().length < 2) toast('Não achei quadros nesta página: mostrando a página inteira', 'info', 2600);
    else toast('Leitura por quadro: use as setas para avançar', 'ok', 2200);
  } else {
    hideGuidedUi();
    layoutSingle();
  }
  syncControls();
  sharpenSoon();
}

async function showPage(i, { fromEnd = false, step = 'first' } = {}) {
  const src = R.source;
  if (!src) return;
  i = clamp(i, 0, R.total - 1);
  R.page = i;
  afterChange();
  const token = ++R.pageToken;
  src.focus(i, 6);
  const spin = setTimeout(() => stage.classList.add('busy'), 160);
  const url = await src.url(i);
  if (token !== R.pageToken || src !== R.source || R.mode !== 'single') { clearTimeout(spin); return; }
  if (url) {
    const probe = new Image();
    probe.src = url;
    try { await probe.decode(); } catch {}
    if (token !== R.pageToken || !R.img) { clearTimeout(spin); return; }
    R.natural = { w: probe.naturalWidth || 1000, h: probe.naturalHeight || 1500 };
    src.learn(i, R.natural.w, R.natural.h);
    if (R.adj.crop || R.guided) analysisFor(i, probe);
    R.img.src = url;
    if (R.guided) {
      R.step = step === 'last' ? guidedRects().length - 1 : 0;
      applyGuided(false);
    } else {
      layoutSingle();
      stage.scrollTo({ top: fromEnd ? stage.scrollHeight : 0, left: R.dir === 'rtl' ? stage.scrollWidth : 0 });
    }
  }
  clearTimeout(spin);
  stage.classList.remove('busy');
  prefetch(i);
  sharpenSoon();
}

function prefetch(i) {
  const src = R.source;
  if (!src) return;
  R.preload = [];
  for (const d of [1, 2, -1, 3]) {
    const j = i + d;
    if (j < 0 || j >= R.total) continue;
    src.url(j).then((u) => {
      if (u && src === R.source && src.remote) {
        const im = new Image();
        im.decoding = 'async';
        im.src = u;
        R.preload.push(im);
      }
    });
  }
  src.release(i - 6, i + 8);
}

function barSpace() {
  const top = el.querySelector('.r-top').offsetHeight + 6;
  const bottom = el.querySelector('.r-bottom').offsetHeight + 6;
  return { top, bottom };
}

function layoutSingle() {
  if (!R.img || !R.natural || !R.cropEl) return;
  if (R.guided) { applyGuided(false); return; }
  const bars = barSpace();
  const wrap = R.cropEl.parentElement;
  wrap.style.paddingTop = `${bars.top}px`;
  wrap.style.paddingBottom = `${bars.bottom}px`;
  const sw = stage.clientWidth - 16;
  const sh = stage.clientHeight - bars.top - bars.bottom;
  const { w, h } = R.natural;
  const b = cropBox();
  const cw = w * b.w;
  const ch = h * b.h;
  const base = R.fit === 'width' ? sw / cw : Math.min(sw / cw, sh / ch);
  const s = base * R.zoom;
  R.cropEl.style.width = `${Math.max(1, Math.round(cw * s))}px`;
  R.cropEl.style.height = `${Math.max(1, Math.round(ch * s))}px`;
  R.img.style.transform = '';
  R.img.style.width = `${Math.max(1, Math.round(w * s))}px`;
  R.img.style.height = `${Math.max(1, Math.round(h * s))}px`;
  R.img.style.left = `${-Math.round(b.x * w * s)}px`;
  R.img.style.top = `${-Math.round(b.y * h * s)}px`;
  stage.classList.toggle('pannable', stage.scrollWidth > stage.clientWidth + 2 || stage.scrollHeight > stage.clientHeight + 2);
}

const toDom = (i) => (R.dir === 'rtl' ? R.total - 1 - i + R.bookPad : i);
const fromDom = (d) => (R.dir === 'rtl' ? R.total - 1 - (d - R.bookPad) : d);

function bookSize() {
  const ratio = R.source.ratio(0);
  const bars = barSpace();
  const W = stage.clientWidth - 32;
  const H = stage.clientHeight - Math.max(bars.top, bars.bottom) * 2 - 8;
  const two = W > H * ratio * 1.3;
  let ph = H;
  let pw = ph * ratio;
  if (two && pw * 2 > W) { pw = W / 2; ph = pw / ratio; }
  if (!two && pw > W) { pw = W; ph = pw / ratio; }
  return { pw: Math.max(120, Math.floor(pw)), ph: Math.max(180, Math.floor(ph)), two };
}

async function mountBook() {
  if (typeof St === 'undefined') {
    toast('Modo livro indisponível', 'err');
    R.mode = 'single';
    syncControls();
    mountSingle();
    return;
  }
  const src = R.source;
  if (!src.known(0)) await src.probe(0);
  if (src !== R.source || R.mode !== 'book') return;
  const { pw, ph, two } = bookSize();
  R.bookSize = `${pw}x${ph}x${two}`;
  const n = R.total;
  R.bookPad = R.dir === 'rtl' && n % 2 === 1 ? 1 : 0;
  const order = [];
  if (R.bookPad) order.push(-1);
  for (let k = 0; k < n; k++) order.push(R.dir === 'rtl' ? n - 1 - k : k);

  const bookW = two ? pw * 2 : pw;
  const scroller = document.createElement('div');
  scroller.className = 'book-scroller';
  const zoomBox = document.createElement('div');
  zoomBox.className = 'book-zoom';
  const wrap = document.createElement('div');
  wrap.className = 'book-wrap';
  wrap.style.width = `${bookW + 32}px`;
  wrap.style.height = `${ph + 32}px`;
  const book = document.createElement('div');
  book.className = 'book';
  book.style.width = `${bookW}px`;
  book.style.height = `${ph}px`;
  book.innerHTML = order.map((i) => (i < 0
    ? '<div class="pf-page blank"></div>'
    : `<div class="pf-page" data-i="${i}"><img alt="" draggable="false"><b>${i + 1}</b></div>`)).join('');
  wrap.appendChild(book);
  zoomBox.appendChild(wrap);
  scroller.appendChild(zoomBox);
  stage.appendChild(scroller);
  R.bookBox = { w: bookW + 32, h: ph + 32, el: zoomBox, wrap };
  R.bookHandlers = true;

  R.bookMap = new Map();
  book.querySelectorAll('.pf-page[data-i]').forEach((p) => R.bookMap.set(Number(p.dataset.i), p));

  R.book = new St.PageFlip(book, {
    width: pw,
    height: ph,
    size: 'fixed',
    autoSize: false,
    showCover: true,
    usePortrait: true,
    startPage: toDom(R.page),
    maxShadowOpacity: 0.45,
    mobileScrollSupport: false,
    flippingTime: 650,
    showPageCorners: true,
    drawShadow: true
  });
  R.book.loadFromHTML(book.querySelectorAll('.pf-page'));
  R.book.on('flip', () => {
    afterChange();
    fillBook();
    if (R.zoom > 1.01) stage.scrollTo({ top: 0, left: R.dir === 'rtl' ? stage.scrollWidth : 0 });
    sharpenSoon();
  });
  R.book.on('changeOrientation', () => { afterChange(); fillBook(); });
  fillBook();
  applyBookZoom();
}

function setBookHandlers(on) {
  if (!R.book || R.bookHandlers === on) return;
  try {
    const ui = R.book.getUI();
    if (on) ui.setHandlers(); else ui.removeHandlers();
    R.bookHandlers = on;
  } catch {}
}

function applyBookZoom() {
  const box = R.bookBox;
  if (!box) return;
  const z = R.zoom;
  box.el.style.width = `${Math.round(box.w * z)}px`;
  box.el.style.height = `${Math.round(box.h * z)}px`;
  box.wrap.style.transform = z === 1 ? '' : `scale(${z})`;
  setBookHandlers(z <= 1.01);
  stage.classList.toggle('pannable', z > 1.01 && (stage.scrollWidth > stage.clientWidth + 2 || stage.scrollHeight > stage.clientHeight + 2));
}

function imgFor(i) {
  if (R.mode === 'single') return R.page === i ? R.img : null;
  if (R.mode === 'book' && R.bookMap) {
    const pageEl = R.bookMap.get(i);
    return pageEl ? pageEl.firstElementChild : null;
  }
  return null;
}

function dropHi(keep) {
  for (const [i, h] of R.hi) {
    if (keep && keep.has(i)) continue;
    R.hi.delete(i);
    const img = imgFor(i);
    if (img && img.src === h.url && R.source) {
      R.source.url(i).then((u) => {
        if (u && img.src === h.url) img.src = u;
        URL.revokeObjectURL(h.url);
      });
    } else {
      URL.revokeObjectURL(h.url);
    }
  }
}

async function sharpen() {
  const src = R.source;
  if (!src || src.remote || !src.renderHi || R.mode === 'scroll') return;
  const pages = R.mode === 'single' ? [R.page] : bookVisible();
  const want = Math.max(R.zoom, R.guided ? R.guidedScale : 1);
  if (want < 1.35) { dropHi(); return; }
  dropHi(new Set(pages));
  const factor = Math.min(3, Math.ceil(want * 2) / 2);
  for (const i of pages) {
    const img = imgFor(i);
    if (!img) continue;
    const cur = R.hi.get(i);
    if (cur && cur.factor >= factor) continue;
    const url = await src.renderHi(i, factor);
    if (!url) continue;
    const target = imgFor(i);
    if (src !== R.source || !target || Math.max(R.zoom, R.guided ? R.guidedScale : 1) < 1.35) { URL.revokeObjectURL(url); return; }
    target.src = url;
    if (cur) URL.revokeObjectURL(cur.url);
    R.hi.set(i, { url, factor });
  }
}

const sharpenSoon = debounce(sharpen, 350);

function bookVisible() {
  if (!R.book) return [R.page];
  let d;
  try { d = R.book.getCurrentPageIndex(); } catch { return [R.page]; }
  const count = R.book.getPageCount();
  let idx = [d];
  if (R.book.getOrientation() === 'landscape' && d > 0) {
    const a = d % 2 === 1 ? d : d - 1;
    idx = [a, a + 1].filter((x) => x < count);
  }
  return idx.map(fromDom).filter((i) => i >= 0 && i < R.total).sort((a, b) => a - b);
}

function fillBook() {
  if (!R.bookMap || !R.source) return;
  const src = R.source;
  const vis = bookVisible();
  const c = vis.length ? vis[0] : R.page;
  src.focus(c, 10);
  for (const [i, pageEl] of R.bookMap) {
    const img = pageEl.firstElementChild;
    if (i >= c - 3 && i <= c + 5) {
      if (!img.getAttribute('src') && !pageEl.dataset.loading) {
        pageEl.dataset.loading = '1';
        src.url(i).then((u) => {
          delete pageEl.dataset.loading;
          if (u && R.bookMap && R.bookMap.get(i) === pageEl) {
            img.onload = () => pageEl.classList.add('ready');
            img.src = u;
          }
        });
      }
    } else if ((i < c - 8 || i > c + 10) && img.getAttribute('src')) {
      img.removeAttribute('src');
      pageEl.classList.remove('ready');
    }
  }
  src.release(c - 8, c + 10);
}

function mountScroll() {
  const src = R.source;
  const col = document.createElement('div');
  col.className = 'scroll-col';
  col.innerHTML = Array.from({ length: R.total }, (_, i) => `<div class="sp" data-i="${i}" style="aspect-ratio:${src.ratio(i)}"><img alt="" draggable="false" decoding="async"><b>${i + 1}</b></div>`).join('');
  stage.appendChild(col);
  R.sp = Array.from(col.children);
  layoutScroll();
  R.io = new IntersectionObserver(onNear, { root: stage, rootMargin: '120% 0px' });
  R.center = new IntersectionObserver(onCenter, { root: stage, rootMargin: '-45% 0px -54% 0px' });
  R.sp.forEach((node) => { R.io.observe(node); R.center.observe(node); });
  const target = R.sp[R.page];
  if (target && R.page > 0) stage.scrollTop = target.offsetTop - 8;
}

function layoutScroll() {
  const col = stage.querySelector('.scroll-col');
  if (!col) return;
  const sw = stage.clientWidth;
  const base = R.fit === 'width' ? sw : Math.min(sw, 900);
  col.style.width = `${Math.round(base * R.zoom)}px`;
}

function onNear(entries) {
  for (const e of entries) {
    const i = Number(e.target.dataset.i);
    if (e.isIntersecting) { R.near.add(i); loadSp(i); } else { R.near.delete(i); unloadSp(i); }
  }
  trimScroll();
}

function onCenter(entries) {
  let changed = false;
  for (const e of entries) {
    if (e.isIntersecting) { R.page = Number(e.target.dataset.i); changed = true; }
  }
  if (changed) {
    afterChange();
    R.near.forEach(loadSp);
    trimScroll();
  }
}

function loadSp(i) {
  const node = R.sp && R.sp[i];
  if (!node || node.dataset.state) return;
  node.dataset.state = 'loading';
  const src = R.source;
  src.url(i).then((u) => {
    if (!R.sp || R.sp[i] !== node || node.dataset.state !== 'loading') return;
    if (!u) { delete node.dataset.state; return; }
    const img = node.firstElementChild;
    img.onload = () => {
      node.dataset.state = 'loaded';
      src.learn(i, img.naturalWidth, img.naturalHeight);
      fixRatio(node, img.naturalWidth / img.naturalHeight);
    };
    img.onerror = () => { delete node.dataset.state; };
    img.src = u;
  });
}

function unloadSp(i) {
  const node = R.sp && R.sp[i];
  if (!node) return;
  const img = node.firstElementChild;
  img.onload = null;
  img.removeAttribute('src');
  delete node.dataset.state;
}

function trimScroll() {
  if (!R.near.size || !R.source) return;
  const list = [...R.near];
  const lo = Math.min(...list);
  const hi = Math.max(...list);
  R.source.focus(R.page, Math.max(R.page - lo, hi - R.page) + 2);
  R.source.release(lo - 1, hi + 1);
}

function fixRatio(node, ratio) {
  if (!ratio || !isFinite(ratio)) return;
  const current = parseFloat(node.style.aspectRatio) || 0;
  if (Math.abs(current - ratio) < 0.004) return;
  const above = node.offsetTop < stage.scrollTop;
  const old = node.offsetHeight;
  node.style.aspectRatio = String(ratio);
  if (above) stage.scrollTop += node.offsetHeight - old;
}

function step(delta, opts = {}) {
  if (!R.source) return;
  if (R.mode === 'single' && R.guided) { guidedStep(delta); return; }
  if (R.mode === 'book' && R.book) {
    const vis = bookVisible();
    if (delta > 0 && vis.includes(R.total - 1)) { showEnd(); return; }
    if (delta < 0 && vis.includes(0)) return;
    const forward = (delta > 0) !== (R.dir === 'rtl');
    if (forward) R.book.flipNext(); else R.book.flipPrev();
    return;
  }
  const target = R.page + delta;
  if (target >= R.total) { showEnd(); return; }
  if (target < 0) return;
  hideEnd();
  if (R.mode === 'scroll') { scrollToPage(target, true); return; }
  showPage(target, opts);
}

function visual(side) {
  const logical = side === 'right' ? 1 : -1;
  step(R.dir === 'rtl' ? -logical : logical);
}

function goTo(i) {
  if (!R.source) return;
  i = clamp(i, 0, R.total - 1);
  hideEnd();
  if (R.mode === 'book' && R.book) {
    try { R.book.turnToPage(toDom(i)); } catch {}
    afterChange();
    fillBook();
    return;
  }
  if (R.mode === 'scroll') { scrollToPage(i, false); return; }
  showPage(i);
}

function scrollToPage(i, smooth) {
  const node = R.sp && R.sp[i];
  if (node) stage.scrollTo({ top: node.offsetTop - 8, behavior: smooth ? 'smooth' : 'auto' });
}

function afterChange() {
  if (!R.source) return;
  let label = `${R.page + 1}`;
  if (R.mode === 'book' && R.book) {
    const vis = bookVisible();
    if (vis.length) {
      R.page = vis[vis.length - 1];
      label = vis.length > 1 ? `${vis[0] + 1}-${vis[1] + 1}` : `${vis[0] + 1}`;
    }
  }
  $('#r-counter').innerHTML = `<b>${label}</b> / ${R.total}`;
  R.lastInput = Date.now();
  countPages(R.mode === 'book' && R.book ? bookVisible() : [R.page]);
  if (R.file && R.file.kind !== 'image' && R.page >= R.total - 3) preloadNext();
  const slider = $('#r-slider');
  if (document.activeElement !== slider || !R.sliding) slider.value = String(R.page + 1);
  paintSlider();
  saveProgress();
}

function paintSlider() {
  const slider = $('#r-slider');
  const max = Number(slider.max) || 1;
  const pct = max > 1 ? ((Number(slider.value) - 1) / (max - 1)) * 100 : 100;
  slider.style.setProperty('--fill', `${pct}%`);
  return pct;
}

function chapterAt(delta) {
  if (!R.file || R.file.kind === 'image') return null;
  const idx = R.chapters.findIndex((f) => f.path === R.file.path);
  return idx < 0 ? null : R.chapters[idx + delta] || null;
}

function openChapter(file) {
  if (!file) return;
  saveProgress.flush();
  history.replaceState(null, '', readHash(file.path));
  state.folderPath = parentOf(file.path);
  openReader(file, { onExit: R.onExit });
}

function showEnd() {
  const next = chapterAt(1);
  R.page = R.total - 1;
  saveProgress();
  saveProgress.flush();
  $('#r-end-text').innerHTML = next
    ? `Próximo: <b>${esc(stripExt(next.name))}</b>`
    : 'Você chegou ao fim desta pasta!';
  $('#r-end-next').hidden = !next;
  $('#r-end').hidden = false;
  wake();
}

function hideEnd() {
  const end = $('#r-end');
  if (end) end.hidden = true;
}

function renderChapters() {
  const list = $('#r-chapter-list');
  const isImages = R.file.kind === 'image';
  $('#r-chapters').hidden = isImages;
  if (isImages) { list.innerHTML = ''; return; }
  list.innerHTML = R.chapters.map((f, i) => {
    const p = progressOf(f.path);
    const done = p && p.page >= p.total;
    const status = done ? '<span class="ch-p done">Lido</span>' : p ? `<span class="ch-p reading">${p.page}/${p.total}</span>` : '';
    return `<button class="ch${f.path === R.file.path ? ' current' : ''}" data-path="${esc(f.path)}"><span class="ch-n">${i + 1}</span><span class="ch-t" title="${esc(f.name)}">${esc(stripExt(f.name))}</span>${status}</button>`;
  }).join('');
}

function toggleDrawer(force) {
  const drawer = $('#r-drawer');
  const open = force === undefined ? !drawer.classList.contains('open') : force;
  drawer.classList.toggle('open', open);
  if (open) {
    renderChapters();
    const cur = drawer.querySelector('.ch.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
    wake();
  }
}

function toggleHelp(force) {
  const modal = $('#r-help-modal');
  modal.hidden = force === undefined ? !modal.hidden : !force;
}

async function setMode(mode) {
  if (!R.source || mode === R.mode) return;
  R.mode = mode;
  prefs.set('mode', mode);
  R.zoom = 1;
  if (mode !== 'single') R.guided = false;
  hideEnd();
  syncControls();
  await mount();
}

function toggleDir() {
  R.dir = R.dir === 'rtl' ? 'ltr' : 'rtl';
  prefs.set('dir', R.dir);
  syncControls();
  toast(R.dir === 'rtl' ? 'Modo mangá: leitura da direita para a esquerda' : 'Modo HQ: leitura da esquerda para a direita', 'info', 2000);
  if (R.mode === 'book' && R.source) mount();
  else if (R.guided) { R.step = 0; applyGuided(false); }
}

function toggleFit() {
  if (R.mode === 'book') return;
  R.fit = R.fit === 'width' ? 'screen' : 'width';
  prefs.set('fit', R.fit);
  R.zoom = 1;
  if (R.mode === 'single') { layoutSingle(); stage.scrollTo({ top: 0 }); } else relayoutScroll();
  syncControls();
}

function relayoutScroll() {
  const anchor = R.sp && R.sp[R.page];
  const offset = anchor ? (stage.scrollTop - anchor.offsetTop) / Math.max(anchor.offsetHeight, 1) : 0;
  layoutScroll();
  if (anchor) stage.scrollTop = anchor.offsetTop + offset * anchor.offsetHeight;
}

function setZoom(z, anchor) {
  if (!R.source) return;
  z = clamp(Math.round(z * 100) / 100, R.mode === 'book' ? 1 : 0.4, 4);
  if (z === R.zoom) return;
  if (R.mode === 'scroll') {
    R.zoom = z;
    relayoutScroll();
    syncControls();
    return;
  }
  if (R.guided) toggleGuided(false);
  const target = R.mode === 'single' ? R.cropEl : R.bookBox && R.bookBox.el;
  const sr = stage.getBoundingClientRect();
  const ax = anchor ? anchor.x : sr.left + sr.width / 2;
  const ay = anchor ? anchor.y : sr.top + sr.height / 2;
  const before = target ? target.getBoundingClientRect() : null;
  const rx = before && before.width ? (ax - before.left) / before.width : 0.5;
  const ry = before && before.height ? (ay - before.top) / before.height : 0.5;
  R.zoom = z;
  if (R.mode === 'single') layoutSingle(); else applyBookZoom();
  if (target) {
    const after = target.getBoundingClientRect();
    stage.scrollLeft += after.left + rx * after.width - ax;
    stage.scrollTop += after.top + ry * after.height - ay;
  }
  syncControls();
  sharpenSoon();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => toast('Tela cheia não suportada aqui', 'err'));
}

function syncControls() {
  el.classList.toggle('rtl', R.dir === 'rtl');
  el.dataset.mode = R.mode;
  $$('#r-modes [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === R.mode)));
  $('#r-dir').innerHTML = R.dir === 'rtl' ? '<span>← Mangá</span>' : '<span>HQ →</span>';
  $('#r-fit use').setAttribute('href', R.fit === 'width' ? '#i-fit-w' : '#i-fit-h');
  $('#r-fit').title = R.fit === 'width' ? 'Ajustado à largura · trocar para tela (W)' : 'Ajustado à tela · trocar para largura (W)';
  $('#r-fit').disabled = R.mode === 'book';
  $('#r-zoom').textContent = `${Math.round(R.zoom * 100)}%`;
  $('#r-zoomgrp').classList.remove('off');
  el.classList.toggle('zoomed', R.zoom > 1.01 && R.mode !== 'scroll');
  $('#r-slider').dir = R.dir === 'rtl' ? 'rtl' : 'ltr';
  $('#r-chap-prev').disabled = !chapterAt(-1);
  $('#r-chap-next').disabled = !chapterAt(1);
  $('#r-full use').setAttribute('href', document.fullscreenElement ? '#i-compress' : '#i-expand');
  $('#r-guided').setAttribute('aria-pressed', String(R.guided));
  $('#r-guided').disabled = !R.source;
  const favPath = R.file ? R.progressPath : null;
  $('#r-fav').setAttribute('aria-pressed', String(!!favPath && isFav(favPath)));
  paintSlider();
}

function adjustFilter(a) {
  const plain = a.brightness === 100 && a.contrast === 100 && a.saturate === 100 && a.sepia === 0;
  return plain ? 'none' : `brightness(${a.brightness / 100}) contrast(${a.contrast / 100}) saturate(${a.saturate / 100}) sepia(${a.sepia / 100})`;
}

const saveAdjust = debounce(() => prefs.set('adjust', R.adj), 300);

function applyAdjust() {
  const a = R.adj;
  const filter = adjustFilter(a);
  el.style.setProperty('--flt', filter);
  const pop = $('#r-adjust-pop');
  $$('[data-adj]', pop).forEach((input) => {
    const key = input.dataset.adj;
    if (input.type === 'checkbox') input.checked = !!a[key];
    else input.value = String(a[key]);
  });
  $$('[data-out]', pop).forEach((out) => { out.textContent = `${a[out.dataset.out]}%`; });
  $$('[data-preset]', pop).forEach((b) => {
    const p = PRESETS[b.dataset.preset];
    b.setAttribute('aria-pressed', String(Object.keys(p).every((k) => p[k] === a[k])));
  });
  $('#r-adjust').setAttribute('aria-pressed', String(filter !== 'none' || a.crop));
}

function toggleAdjust(force) {
  const pop = $('#r-adjust-pop');
  pop.hidden = force === undefined ? !pop.hidden : !force;
  if (!pop.hidden) wake();
}

function toggleReaderFav() {
  if (!R.file) return;
  const on = toggleFav(R.progressPath);
  toast(on ? 'Favoritado!' : 'Removido dos favoritos', on ? 'ok' : 'info', 1500);
  syncControls();
}

function wake() {
  if (!R.open) return;
  R.lastInput = Date.now();
  el.classList.remove('ui-hidden');
  clearTimeout(R.idle);
  R.idle = setTimeout(hideUi, 2800);
}

function hideUi() {
  if (!R.open || R.overBars || R.sliding || !$('#r-adjust-pop').hidden) return;
  if (!$('#r-help-modal').hidden || !$('#r-end').hidden || $('#r-drawer').classList.contains('open') || !$('#r-loading').hidden) return;
  el.classList.add('ui-hidden');
}

function toggleUi() {
  if (el.classList.contains('ui-hidden')) wake();
  else { clearTimeout(R.idle); el.classList.add('ui-hidden'); }
}

function wheelStep(dy) {
  const now = performance.now();
  if (now - R.wheelAt > 400) R.wheelAcc = 0;
  R.wheelAt = now;
  R.wheelAcc += dy;
  if (Math.abs(R.wheelAcc) >= 100 && now - R.wheelFlip > 380) {
    R.wheelFlip = now;
    const dir = R.wheelAcc > 0 ? 1 : -1;
    R.wheelAcc = 0;
    step(dir, { fromEnd: dir < 0 });
  }
}

function onKey(e) {
  if (!R.open || e.altKey || isTyping(e.target)) return;
  const k = e.key;
  if (e.target.type === 'range' && /^(Arrow|Home|End|Page)/.test(k)) return;
  if (e.ctrlKey || e.metaKey) {
    if (k === '+' || k === '=') { e.preventDefault(); setZoom(R.zoom + 0.2); }
    else if (k === '-') { e.preventDefault(); setZoom(R.zoom - 0.2); }
    else if (k === '0') { e.preventDefault(); setZoom(1); }
    return;
  }
  if (!$('#r-help-modal').hidden) {
    if (k === 'Escape' || k === '?' || k === 'h' || k === 'H') { e.preventDefault(); toggleHelp(false); }
    return;
  }
  if (!$('#r-end').hidden) {
    if (k === 'Enter' && chapterAt(1)) { e.preventDefault(); openChapter(chapterAt(1)); return; }
    if (k === 'Escape') { e.preventDefault(); hideEnd(); return; }
  }
  const pannable = stage.classList.contains('pannable');
  switch (k) {
    case 'ArrowRight': case 'd': case 'D':
      e.preventDefault(); visual('right'); break;
    case 'ArrowLeft': case 'a': case 'A':
      e.preventDefault(); visual('left'); break;
    case 'ArrowDown': case 'ArrowUp':
      if (R.mode === 'scroll' || pannable) return;
      e.preventDefault(); step(k === 'ArrowDown' ? 1 : -1); break;
    case ' ':
      if (R.mode === 'scroll') return;
      if (pannable) {
        const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
        if (!e.shiftKey && !atBottom) return;
      }
      e.preventDefault(); step(e.shiftKey ? -1 : 1); break;
    case 'PageDown':
      if (R.mode === 'scroll') return;
      e.preventDefault(); step(1); break;
    case 'PageUp':
      if (R.mode === 'scroll') return;
      e.preventDefault(); step(-1); break;
    case 'Home': e.preventDefault(); goTo(0); break;
    case 'End': e.preventDefault(); goTo(R.total - 1); break;
    case '+': case '=': e.preventDefault(); setZoom(R.zoom + 0.25); break;
    case '-': case '_': e.preventDefault(); setZoom(R.zoom - 0.25); break;
    case '0': e.preventDefault(); setZoom(1); break;
    case '1': setMode('single'); break;
    case '2': setMode('book'); break;
    case '3': setMode('scroll'); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'g': case 'G': toggleGuided(); break;
    case 'i': case 'I': toggleAdjust(); break;
    case 's': case 'S': toggleReaderFav(); break;
    case 'w': case 'W': toggleFit(); break;
    case 'm': case 'M': toggleDir(); break;
    case 'c': case 'C': if (R.file && R.file.kind !== 'image') toggleDrawer(); break;
    case 'n': case 'N': openChapter(chapterAt(1)); break;
    case 'p': case 'P': openChapter(chapterAt(-1)); break;
    case '?': case 'h': case 'H': toggleHelp(); break;
    case 'Escape':
      e.preventDefault();
      if (!$('#r-adjust-pop').hidden) toggleAdjust(false);
      else if ($('#r-drawer').classList.contains('open')) toggleDrawer(false);
      else if (!document.fullscreenElement) exit();
      break;
    default: return;
  }
  wake();
}

function bind() {
  document.addEventListener('keydown', onKey);
  el.addEventListener('mousemove', wake, { passive: true });
  $$('.r-bar', el).forEach((bar) => {
    bar.addEventListener('mouseenter', () => { R.overBars = true; wake(); });
    bar.addEventListener('mouseleave', () => { R.overBars = false; wake(); });
  });

  $('#r-close').addEventListener('click', exit);
  $('#r-guided').addEventListener('click', () => toggleGuided());
  $('#r-fav').addEventListener('click', toggleReaderFav);
  $('#r-adjust').addEventListener('click', (e) => { e.stopPropagation(); toggleAdjust(); });
  const pop = $('#r-adjust-pop');
  pop.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    Object.assign(R.adj, PRESETS[b.dataset.preset]);
    applyAdjust();
    saveAdjust();
  });
  pop.addEventListener('input', (e) => {
    const key = e.target.dataset.adj;
    if (!key) return;
    R.adj[key] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
    applyAdjust();
    saveAdjust();
    if (key === 'crop') {
      if (R.adj.crop && R.mode !== 'single') toast('O corte de margens funciona no modo Página', 'info', 2200);
      if (R.mode === 'single') layoutSingle();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !e.target.closest('.r-pop-wrap')) toggleAdjust(false);
  });
  $('#r-modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('#r-zoom-in').addEventListener('click', () => setZoom(R.zoom + 0.2));
  $('#r-zoom-out').addEventListener('click', () => setZoom(R.zoom - 0.2));
  $('#r-zoom').addEventListener('click', () => setZoom(1));
  $('#r-fit').addEventListener('click', toggleFit);
  $('#r-dir').addEventListener('click', toggleDir);
  $('#r-full').addEventListener('click', toggleFullscreen);
  $('#r-help').addEventListener('click', () => toggleHelp());
  $('#r-chapters').addEventListener('click', () => toggleDrawer());
  $('#r-drawer-close').addEventListener('click', () => toggleDrawer(false));
  $('#r-chapter-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-path]');
    if (!b) return;
    const file = state.files.get(b.dataset.path);
    toggleDrawer(false);
    if (file && file.path !== R.file.path) openChapter(file);
  });
  $('#r-help-modal').addEventListener('click', (e) => {
    if (e.target.id === 'r-help-modal' || e.target.closest('[data-close]')) toggleHelp(false);
  });
  $('#r-left').addEventListener('click', () => visual('left'));
  $('#r-edge-l').addEventListener('click', () => visual('left'));
  $('#r-edge-r').addEventListener('click', () => visual('right'));
  $('#r-right').addEventListener('click', () => visual('right'));
  $('#r-chap-prev').addEventListener('click', () => openChapter(chapterAt(-1)));
  $('#r-chap-next').addEventListener('click', () => openChapter(chapterAt(1)));
  $('#r-end-next').addEventListener('click', () => openChapter(chapterAt(1)));
  $('#r-end-back').addEventListener('click', exit);
  $('#r-end').addEventListener('click', (e) => { if (e.target.id === 'r-end') hideEnd(); });

  const slider = $('#r-slider');
  const bubble = $('#r-bubble');
  const jump = debounce((v) => goTo(v - 1), 110);
  slider.addEventListener('input', () => {
    R.sliding = true;
    const v = Number(slider.value);
    const pct = paintSlider();
    bubble.hidden = false;
    bubble.textContent = `Pág. ${v}`;
    bubble.style.setProperty('--x', `${R.dir === 'rtl' ? 100 - pct : pct}%`);
    $('#r-counter').innerHTML = `<b>${v}</b> / ${R.total}`;
    jump(v);
    wake();
  });
  slider.addEventListener('change', () => {
    jump.flush();
    R.sliding = false;
    setTimeout(() => { bubble.hidden = true; }, 500);
    stage.focus({ preventScroll: true });
  });

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const pan = (R.mode === 'single' || (R.mode === 'book' && R.zoom > 1.01)) && stage.classList.contains('pannable');
    R.drag = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop, moved: false, pan };
    if (pan) { stage.setPointerCapture(e.pointerId); stage.classList.add('panning'); }
  });
  stage.addEventListener('pointermove', (e) => {
    const d = R.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
    if (d.pan) { stage.scrollLeft = d.sl - dx; stage.scrollTop = d.st - dy; }
  });
  const endDrag = () => {
    if (!R.drag) return;
    R.dragMoved = R.drag.moved;
    R.drag = null;
    stage.classList.remove('panning');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener('click', (e) => {
    if (R.dragMoved) { R.dragMoved = false; return; }
    if ($('#r-drawer').classList.contains('open')) { toggleDrawer(false); return; }
    if (R.mode === 'scroll') { toggleUi(); return; }
    const rect = stage.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (R.zoom > 1.01) {
      if (x < 0.08) visual('left');
      else if (x > 0.92) visual('right');
      return;
    }
    if (R.mode === 'book') {
      if (!e.target.closest('.pf-page')) toggleUi();
      return;
    }
    if (x < 0.3) visual('left');
    else if (x > 0.7) visual('right');
    else toggleUi();
  });

  stage.addEventListener('dblclick', (e) => {
    if (R.mode !== 'single') return;
    const rect = stage.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x >= 0.3 && x <= 0.7) setZoom(R.zoom > 1.05 ? 1 : 2, { x: e.clientX, y: e.clientY });
  });

  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { R.touch = null; return; }
    const t = e.touches[0];
    R.touch = { x: t.clientX, y: t.clientY, at: Date.now() };
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    const t0 = R.touch;
    R.touch = null;
    if (!t0 || R.mode !== 'single') return;
    const t = e.changedTouches[0];
    const dx = t.clientX - t0.x;
    const dy = t.clientY - t0.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - t0.at < 700 && stage.scrollWidth <= stage.clientWidth + 2) {
      visual(dx < 0 ? 'right' : 'left');
    }
  }, { passive: true });

  stage.addEventListener('wheel', (e) => {
    const dy = e.deltaY * (e.deltaMode === 1 ? 40 : 1);
    const factor = Math.exp(-clamp(dy, -150, 150) * 0.0018);
    if (e.ctrlKey || e.metaKey || R.mode === 'book') {
      e.preventDefault();
      setZoom(R.zoom * factor, { x: e.clientX, y: e.clientY });
      return;
    }
    if (R.mode === 'single') {
      const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
      const atTop = stage.scrollTop <= 1;
      if ((dy > 0 && atBottom) || (dy < 0 && atTop)) { e.preventDefault(); wheelStep(dy); }
      else R.wheelAcc = 0;
    }
  }, { passive: false });

  stage.addEventListener('scroll', () => {
    if (R.mode !== 'scroll') return;
    const y = stage.scrollTop;
    if (y > R.lastScroll + 40) { clearTimeout(R.idle); if (!R.overBars) el.classList.add('ui-hidden'); R.lastScroll = y; }
    else if (y < R.lastScroll - 40) { wake(); R.lastScroll = y; }
  }, { passive: true });

  const onResize = debounce(() => {
    if (!R.open || !R.source) return;
    if (R.mode === 'single') layoutSingle();
    else if (R.mode === 'scroll') relayoutScroll();
    else if (R.mode === 'book') {
      const { pw, ph, two } = bookSize();
      if (`${pw}x${ph}x${two}` !== R.bookSize) mount();
    }
  }, 180);
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', () => { syncControls(); onResize(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { saveProgress.flush(); flushStats(); } });
  window.addEventListener('pagehide', () => { saveProgress.flush(); flushStats(); });
}

export function initReader() {
  el = $('#reader');
  stage = $('#r-stage');
  bind();
  syncControls();
  applyAdjust();
}

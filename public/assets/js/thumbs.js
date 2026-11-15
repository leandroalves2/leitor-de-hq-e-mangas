import { api } from './api.js';
import { state, saveMeta } from './state.js';
import { PDF_OPTS } from './sources.js';

const WIDTH = 360;
const MAX_HEIGHT = 600;
const LIMIT = 2;
const blobs = new Map();
const queued = new Set();
const queue = [];
let active = 0;

export function coverUrl(file) {
  if (!file) return null;
  return blobs.get(file.key) || (file.thumb ? api.thumbUrl(file) : null);
}

const observer = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        enqueue(state.files.get(entry.target.dataset.need));
      }
    }, { rootMargin: '400px 200px' })
  : null;

export function watchCovers(root) {
  root.querySelectorAll('[data-need]').forEach((el) => {
    if (observer) observer.observe(el);
    else enqueue(state.files.get(el.dataset.need));
  });
}

function enqueue(file) {
  if (!file || queued.has(file.key) || coverUrl(file)) return;
  queued.add(file.key);
  queue.push(file);
  pump();
}

function pump() {
  while (active < LIMIT && queue.length) {
    const file = queue.shift();
    active++;
    make(file)
      .then((url) => { if (url) paint(file, url); })
      .catch(() => markFailed(file))
      .finally(() => { active--; pump(); });
  }
}

function paint(file, url) {
  document.querySelectorAll(`[data-need="${CSS.escape(file.path)}"]`).forEach((el) => {
    const img = new Image();
    img.className = 'cover-img';
    img.alt = '';
    img.decoding = 'async';
    img.src = url;
    el.replaceWith(img);
  });
}

function markFailed(file) {
  document.querySelectorAll(`[data-need="${CSS.escape(file.path)}"]`).forEach((el) => el.removeAttribute('data-need'));
}

async function make(file) {
  const canvas = file.kind === 'pdf'
    ? await fromPdf(file)
    : await fromImage(file.kind === 'archive' ? await (async () => { await api.preparePages(file); return api.pageUrl(file, 0); })() : api.fileUrl(file));
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  blobs.set(file.key, url);
  api.postBlob('thumb', { p: file.path, k: file.key }, blob).then(() => { file.thumb = true; }).catch(() => {});
  return url;
}

async function fromPdf(file) {
  const doc = await pdfjsLib.getDocument({
    url: api.fileUrl(file),
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 131072,
    ...PDF_OPTS
  }).promise;
  try {
    const info = await doc.getMetadata().catch(() => null);
    saveMeta(file, { title: info && info.info && info.info.Title, pages: doc.numPages });
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: WIDTH / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.min(Math.round(viewport.height), MAX_HEIGHT);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  } finally {
    doc.destroy();
  }
}

async function fromImage(url) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  const scale = WIDTH / img.naturalWidth;
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = Math.max(1, Math.min(Math.round(img.naturalHeight * scale), MAX_HEIGHT));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, WIDTH, img.naturalHeight * scale);
  return canvas;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${units[i]}`;
}

export function debounce(fn, ms) {
  let timer = 0;
  let args = null;
  const run = () => { timer = 0; const a = args; args = null; fn(...a); };
  const d = (...a) => { args = a; clearTimeout(timer); timer = setTimeout(run, ms); };
  d.flush = () => { if (timer) { clearTimeout(timer); run(); } };
  d.cancel = () => { clearTimeout(timer); timer = 0; args = null; };
  return d;
}

export function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
export const folderHash = (p) => (p ? `#/f/${encodePath(p)}` : '#/');
export const readHash = (p) => `#/r/${encodePath(p)}`;
export const parentOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
export const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
export const stripExt = (n) => n.replace(/\.[^.]+$/, '');

export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`cs.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`cs.${key}`, JSON.stringify(value)); } catch {}
  }
};

export function toast(message, type = 'info', ms = 3200) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

const NON_TEXT = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file']);

export const isTyping = (target) => {
  if (!target || !target.closest) return false;
  const field = target.closest('input, textarea, select, [contenteditable="true"]');
  if (!field) return false;
  return !(field.tagName === 'INPUT' && NON_TEXT.has(field.type));
};

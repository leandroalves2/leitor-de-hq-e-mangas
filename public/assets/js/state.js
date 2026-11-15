import { api } from './api.js';
import { parentOf, stripExt, toast } from './util.js';

export const state = {
  root: null,
  files: new Map(),
  folders: new Map(),
  progress: {},
  meta: {},
  collections: { favorites: [], collections: {} },
  features: {},
  view: 'folder',
  folderPath: '',
  collection: '',
  loadedAt: 0
};

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function setLibrary(data) {
  state.root = data.root;
  state.progress = obj(data.progress);
  state.meta = obj(data.meta);
  const c = data.collections || {};
  state.collections = { favorites: Array.isArray(c.favorites) ? c.favorites : [], collections: obj(c.collections) };
  state.features = data.features || {};
  state.files.clear();
  state.folders.clear();
  const walk = (node) => {
    state.folders.set(node.path, node);
    node.files.forEach((f) => state.files.set(f.path, f));
    node.folders.forEach(walk);
  };
  walk(state.root);
  state.loadedAt = Date.now();
}

export function siblingsOf(file) {
  const folder = state.folders.get(parentOf(file.path));
  if (!folder) return [file];
  const images = file.kind === 'image';
  return folder.files.filter((f) => (f.kind === 'image') === images);
}

export function progressOf(path) {
  return state.progress[path] || null;
}

export function statusOf(path) {
  const p = state.progress[path];
  if (!p) return 'unread';
  return p.page >= p.total ? 'done' : 'reading';
}

export function metaOf(file) {
  return (file && state.meta[file.key]) || null;
}

export function readCount(folder) {
  let n = 0;
  const walk = (node) => {
    for (const f of node.files) if (statusOf(f.path) === 'done') n++;
    node.folders.forEach(walk);
  };
  walk(folder);
  return n;
}

export function filesUnder(folder) {
  const out = [];
  const walk = (node) => {
    out.push(...node.files);
    node.folders.forEach(walk);
  };
  walk(folder);
  return out;
}

export function parseName(name) {
  const base = stripExt(name).replace(/[_]+/g, ' ').trim();
  let year = null;
  const y = base.match(/\((19|20)\d{2}\)/) || base.match(/\b(19|20)\d{2}\b/);
  if (y) year = y[0].replace(/\D/g, '');
  const cleaned = base.replace(/\((19|20)\d{2}\)/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ');
  let issue = null;
  const tagged = cleaned.match(/(?:#|\bn[º°o]\.?\s*|\bcap[ií]tulo\s*|\bcap\.?\s*|\bch\.?\s*|\bedi[cç][aã]o\s*|\bed\.?\s*|\bissue\s*)(\d{1,4}(?:\.\d+)?)/i);
  if (tagged) issue = tagged[1];
  else {
    const nums = cleaned.match(/\b\d{1,4}(?:\.\d+)?\b/g);
    if (nums) issue = nums[nums.length - 1];
  }
  return { issue, year };
}

export const isFav = (path) => state.collections.favorites.includes(path);

export function collectionNames() {
  return Object.keys(state.collections.collections).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

export function inCollection(name, path) {
  return (state.collections.collections[name] || []).includes(path);
}

async function saveCollections() {
  try {
    const saved = await api.postJson('collections', state.collections);
    state.collections = { favorites: saved.favorites || [], collections: obj(saved.collections) };
  } catch (e) {
    toast(`Não salvei a coleção: ${e.message}`, 'err');
  }
}

export function toggleFav(path) {
  const list = state.collections.favorites;
  const i = list.indexOf(path);
  if (i >= 0) list.splice(i, 1); else list.unshift(path);
  saveCollections();
  return i < 0;
}

export function toggleInCollection(name, path) {
  const list = state.collections.collections[name] || (state.collections.collections[name] = []);
  const i = list.indexOf(path);
  if (i >= 0) list.splice(i, 1); else list.push(path);
  saveCollections();
  return i < 0;
}

export function createCollection(name) {
  name = name.trim().slice(0, 60);
  if (!name) return null;
  if (!state.collections.collections[name]) state.collections.collections[name] = [];
  saveCollections();
  return name;
}

export function renameCollection(from, to) {
  to = to.trim().slice(0, 60);
  if (!to || to === from || state.collections.collections[to]) return false;
  state.collections.collections[to] = state.collections.collections[from] || [];
  delete state.collections.collections[from];
  saveCollections();
  return true;
}

export function deleteCollection(name) {
  delete state.collections.collections[name];
  saveCollections();
}

export function saveMeta(file, data) {
  if (!file) return;
  const cur = state.meta[file.key] || {};
  const next = { ...cur };
  if (data.title && !cur.title) next.title = String(data.title).trim();
  if (data.pages && !cur.pages) next.pages = data.pages;
  if (next.title === cur.title && next.pages === cur.pages) return;
  state.meta[file.key] = next;
  api.postJson('meta', { path: file.path, key: file.key, ...next }).catch(() => {});
}

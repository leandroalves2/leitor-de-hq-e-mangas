import { createLocalDrive } from './drive-local.js';

const LIB = 'ComicStream/Biblioteca';
const DATA = 'ComicStream/.dados';
const ARCHIVES = ['cbz', 'zip', 'cbr', 'rar', 'cb7', '7z'];
const IMAGES = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'];
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const extOf = (name) => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); };

function kindOf(name) {
  const ext = extOf(name);
  if (ext === 'pdf') return 'pdf';
  if (ARCHIVES.includes(ext)) return 'archive';
  if (IMAGES.includes(ext)) return 'image';
  return null;
}

function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const hashKey = (s) => (fnv(s, 2166136261) + fnv(s, 3323198485) + fnv(s, 1103515245)).slice(0, 20);

function isPage(name) {
  const n = name.replace(/\\/g, '/');
  if (n.includes('__MACOSX/')) return false;
  const base = n.slice(n.lastIndexOf('/') + 1);
  return !!base && base[0] !== '.' && IMAGES.includes(extOf(base));
}

export function sanitizePath(rel) {
  return String(rel).split(/[\\/]+/)
    .map((p) => p.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().replace(/[. ]+$/, ''))
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

let jsZipPromise = null;
function loadJsZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jsZipPromise) {
    jsZipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'assets/vendor/jszip/jszip.min.js';
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => reject(new Error('JSZip indisponível'));
      document.head.appendChild(s);
    });
  }
  return jsZipPromise;
}

export async function createLocalApi(fs) {
  await fs.mkdir(LIB);
  await fs.mkdir(`${DATA}/thumbs`);
  await fs.mkdir(`${DATA}/cache`);

  const files = new Map();
  const archives = new Map();
  let abortUpload = null;

  function store(name, fallback) {
    const path = `${DATA}/${name}.json`;
    let cache = null;
    let chain = Promise.resolve();
    return {
      async read() {
        if (cache === null) {
          const text = await fs.readText(path);
          try { cache = text ? JSON.parse(text) : fallback(); } catch { cache = fallback(); }
        }
        return cache;
      },
      update(fn) {
        chain = chain.then(async () => {
          const current = await this.read();
          const next = fn(current);
          cache = next === undefined ? current : next;
          await fs.writeText(path, JSON.stringify(cache));
          return cache;
        });
        return chain;
      }
    };
  }

  const stores = {
    progress: store('progress', () => ({})),
    collections: store('collections', () => ({ favorites: [], collections: {} })),
    meta: store('meta', () => ({})),
    stats: store('stats', () => ({ days: {}, finished: {} })),
    cacheIndex: store('cache-index', () => ({}))
  };

  async function scan(dir, rel, name, thumbs) {
    const entries = (await fs.list(dir)).filter((e) => e.name && e.name[0] !== '.');
    const folders = [];
    const list = [];
    const subdirs = entries.filter((e) => e.type === 'directory');
    const children = await Promise.all(subdirs.map((e) => scan(`${dir}/${e.name}`, rel ? `${rel}/${e.name}` : e.name, e.name, thumbs)));
    children.forEach((c) => { if (c.count > 0) folders.push(c); });
    for (const e of entries) {
      if (e.type === 'directory') continue;
      const kind = kindOf(e.name);
      if (!kind) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      const key = hashKey(`${path}|${e.size}|${e.mtime}`);
      const file = { name: e.name, path, ext: extOf(e.name), kind, size: e.size, mtime: e.mtime, key, thumb: thumbs.has(key) };
      files.set(path, file);
      list.push(file);
    }
    folders.sort((a, b) => collator.compare(a.name, b.name));
    list.sort((a, b) => collator.compare(a.name, b.name));
    let count = list.length;
    let size = 0;
    let mtime = 0;
    for (const f of list) { size += f.size; mtime = Math.max(mtime, f.mtime); }
    for (const f of folders) { count += f.count; size += f.size; mtime = Math.max(mtime, f.mtime); }
    const firstComic = list.find((f) => f.kind !== 'image');
    const cover = (firstComic || list[0] || {}).path || (folders[0] ? folders[0].cover : null) || null;
    return { name, path: rel, folders, files: list, count, size, mtime, cover };
  }

  async function tree() {
    files.clear();
    const thumbs = new Set((await fs.list(`${DATA}/thumbs`)).map((e) => e.name.replace(/\.jpg$/, '')));
    const root = await scan(LIB, '', 'Estante', thumbs);
    const c = await stores.collections.read();
    return {
      root,
      progress: await stores.progress.read(),
      collections: { favorites: c.favorites || [], collections: obj(c.collections) },
      meta: await stores.meta.read(),
      features: { zip: true, rar: true, local: true }
    };
  }

  async function fileFor(path) {
    if (!files.has(path)) await tree();
    const f = files.get(path);
    if (!f) throw new Error('Arquivo não encontrado');
    return f;
  }

  async function openArchive(f) {
    const blob = await fs.readBlob(`${LIB}/${f.path}`);
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    let entries;
    if (head[0] === 0x50 && head[1] === 0x4b) {
      const JSZip = await loadJsZip();
      const zip = await JSZip.loadAsync(blob);
      entries = Object.values(zip.files).filter((e) => !e.dir).map((e) => ({ name: e.name, read: () => e.async('blob') }));
    } else {
      const { Archive } = await import('../vendor/libarchive/libarchive.js');
      Archive.init({ workerUrl: new URL('../vendor/libarchive/worker-bundle.js', import.meta.url).href });
      const archive = await Archive.open(new File([blob], f.name));
      const list = await archive.getFilesArray();
      entries = list.map(({ file, path }) => ({ name: `${path || ''}${file.name}`, read: () => file.extract() }));
    }
    return entries.filter((e) => isPage(e.name)).sort((a, b) => collator.compare(a.name, b.name));
  }

  async function pruneCache(keep) {
    const index = await stores.cacheIndex.update((idx) => { idx[keep] = Date.now(); return idx; });
    const old = Object.entries(index).sort((a, b) => b[1] - a[1]).slice(10);
    if (!old.length) return;
    for (const [key] of old) await fs.remove(`${DATA}/cache/${key}`, true);
    await stores.cacheIndex.update((idx) => { old.forEach(([key]) => delete idx[key]); return idx; });
  }

  async function pages(path) {
    const f = await fileFor(path);
    let state = archives.get(f.key);
    if (!state) {
      const dir = `${DATA}/cache/${f.key}`;
      const saved = await fs.readText(`${dir}/pages.json`);
      let names = null;
      try { names = saved ? JSON.parse(saved) : null; } catch { names = null; }
      let entries = null;
      if (!Array.isArray(names) || !names.length) {
        entries = await openArchive(f);
        if (!entries.length) throw new Error('Nenhuma imagem encontrada dentro deste arquivo');
        names = entries.map((e, i) => `${String(i).padStart(4, '0')}.${extOf(e.name)}`);
        await fs.writeText(`${dir}/pages.json`, JSON.stringify(names));
      }
      const done = new Set((await fs.list(dir)).map((e) => e.name));
      state = { dir, names, done, entries, pending: new Map(), file: f };
      archives.set(f.key, state);
      for (const [key, s] of archives) if (key !== f.key && archives.size > 2) { s.entries = null; archives.delete(key); }
      pruneCache(f.key).catch(() => {});
    }
    return { count: state.names.length, key: f.key };
  }

  async function extractPage(state, i) {
    const name = state.names[i];
    if (state.pending.has(name)) return state.pending.get(name);
    const job = (async () => {
      if (!state.entries) state.entries = await openArchive(state.file);
      const entry = state.entries[i];
      if (!entry) return null;
      await fs.writeBlob(`${state.dir}/${name}`, await entry.read());
      state.done.add(name);
      return fs.url(`${state.dir}/${name}`);
    })();
    state.pending.set(name, job);
    try { return await job; } finally { state.pending.delete(name); }
  }

  async function trash(rel) {
    rel = sanitizePath(rel);
    if (!rel) throw new Error('Não dá para apagar a estante inteira');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const isFile = files.has(rel);
    if (!isFile && !(await fs.exists(`${LIB}/${rel}`))) throw new Error('Arquivo não encontrado');
    await fs.rename(`${LIB}/${rel}`, `${DATA}/lixeira/${stamp}/${rel}`);
    return { ok: true, trash: `.dados/lixeira/${stamp}/${rel}` };
  }

  function cleanPaths(list, max) {
    const out = [];
    for (const p of Array.isArray(list) ? list : []) {
      if (typeof p === 'string' && p && p.length <= 1024 && !p.includes('..') && !out.includes(p)) out.push(p);
      if (out.length >= max) break;
    }
    return out;
  }

  const drive = createLocalDrive(fs, { LIB, kindOf, sanitizePath });

  const api = {
    local: true,
    adapter: fs,
    libraryLabel: `${fs.rootLabel}/${LIB}`,

    async get(route, params = {}) {
      switch (route) {
        case 'tree': return tree();
        case 'pages': return pages(String(params.p || ''));
        case 'stats': return stores.stats.read();
        case 'collections': return stores.collections.read();
        case 'drive-jobs': return { jobs: drive.jobs() };
        case 'google': return { configured: false, connected: false, native: true };
        default: throw new Error('Rota inexistente');
      }
    },

    async postJson(route, body = {}) {
      switch (route) {
        case 'progress': {
          const path = String(body.path || '');
          await fileFor(path);
          const page = Number(body.page) || 0;
          const total = Math.max(1, Number(body.total) || 1);
          const data = await stores.progress.update((d) => {
            if (page <= 0) delete d[path];
            else d[path] = { page: Math.min(page, total), total, updated: Math.floor(Date.now() / 1000) };
            return d;
          });
          return { ok: true, entry: data[path] || null };
        }
        case 'collections': {
          const favorites = cleanPaths(body.favorites, 5000);
          const collections = {};
          for (const [name, items] of Object.entries(obj(body.collections))) {
            const n = String(name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
            if (n) collections[n] = cleanPaths(items, 2000);
          }
          return stores.collections.update(() => ({ favorites, collections }));
        }
        case 'meta': {
          const f = await fileFor(String(body.path || ''));
          if (body.key !== f.key) throw new Error('Arquivo mudou');
          const entry = {};
          if (body.title) entry.title = String(body.title).slice(0, 200);
          if (Number(body.pages) > 0) entry.pages = Number(body.pages);
          if (Object.keys(entry).length) await stores.meta.update((d) => { d[f.key] = { ...(d[f.key] || {}), ...entry }; return d; });
          return { ok: true };
        }
        case 'stats': {
          const day = String(body.day || '');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Dia inválido');
          const clampN = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
          await stores.stats.update((d) => {
            d.days = obj(d.days);
            d.finished = obj(d.finished);
            const e = d.days[day] || { pages: 0, seconds: 0, chapters: 0, night: 0 };
            e.pages += clampN(body.pages, 5000);
            e.seconds += clampN(body.seconds, 86400);
            e.night = (e.night || 0) + clampN(body.night, 5000);
            for (const p of cleanPaths(body.finished, 200)) {
              if (!d.finished[p]) { d.finished[p] = Math.floor(Date.now() / 1000); e.chapters++; }
            }
            d.days[day] = e;
            return d;
          });
          return { ok: true };
        }
        case 'delete': return trash(String(body.path || ''));
        case 'drive-download': return drive.start(body);
        case 'drive-confirm': return drive.confirm(String(body.id || ''));
        case 'drive-clear': return drive.clear();
        case 'drive-cancel': return drive.cancel(String(body.id || ''));
        default: throw new Error('Rota inexistente');
      }
    },

    async postBlob(route, params, blob) {
      if (route !== 'thumb') throw new Error('Rota inexistente');
      if (!/^[a-f0-9]{20}$/.test(params.k || '')) throw new Error('Chave inválida');
      await fs.writeBlob(`${DATA}/thumbs/${params.k}.jpg`, blob);
      return { ok: true };
    },

    fileUrl(file) {
      return fs.url(`${LIB}/${file.path}`);
    },

    thumbUrl(file) {
      return fs.url(`${DATA}/thumbs/${file.key}.jpg`);
    },

    pageUrl(file, i) {
      const state = archives.get(file.key);
      if (!state) return pages(file.path).then(() => api.pageUrl(file, i));
      const name = state.names[i];
      if (!name) return null;
      if (state.done.has(name)) return fs.url(`${state.dir}/${name}`);
      return extractPage(state, i);
    },

    preparePages(file) {
      return pages(file.path);
    },

    async upload(file, path, onProgress) {
      const rel = sanitizePath(path);
      if (!rel || !kindOf(rel)) throw new Error(`Formato não suportado: ${file.name}`);
      const controller = new AbortController();
      abortUpload = () => controller.abort();
      try {
        await fs.writeBlob(`${LIB}/${rel}`, file, onProgress, controller.signal);
      } catch (e) {
        await fs.remove(`${LIB}/${rel}`, false);
        throw e;
      } finally {
        abortUpload = null;
      }
      return { path: rel };
    },

    abortUpload() {
      if (abortUpload) abortUpload();
    }
  };
  return api;
}

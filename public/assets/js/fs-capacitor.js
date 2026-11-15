const DIR = 'EXTERNAL';

const parent = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function lowerHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = String(v);
  return out;
}

export async function createCapacitorAdapter() {
  const { Filesystem, CapacitorHttp } = window.Capacitor.Plugins;
  const root = (await Filesystem.getUri({ directory: DIR, path: '' })).uri.replace(/\/$/, '');
  const CHUNK = 3 * 1024 * 1024;

  const adapter = {
    name: 'android',
    rootLabel: root.replace(/^file:\/\//, '').replace(/^\/storage\/emulated\/0\//, ''),

    url(path) {
      return window.Capacitor.convertFileSrc(`${root}/${encodePath(path)}`);
    },

    async list(path) {
      try {
        const res = await Filesystem.readdir({ directory: DIR, path });
        return res.files.map((f) => ({
          name: f.name,
          type: f.type === 'directory' ? 'directory' : 'file',
          size: Number(f.size) || 0,
          mtime: Math.floor((Number(f.mtime) || 0) / 1000)
        }));
      } catch {
        return [];
      }
    },

    async readText(path) {
      try {
        const res = await Filesystem.readFile({ directory: DIR, path, encoding: 'utf8' });
        return typeof res.data === 'string' ? res.data : await res.data.text();
      } catch {
        return null;
      }
    },

    async writeText(path, text) {
      await Filesystem.writeFile({ directory: DIR, path, data: text, encoding: 'utf8', recursive: true });
    },

    async writeBlob(path, blob, onProgress, signal) {
      if (!blob.size) {
        await Filesystem.writeFile({ directory: DIR, path, data: '', recursive: true });
        return;
      }
      for (let start = 0; start < blob.size; start += CHUNK) {
        if (signal && signal.aborted) throw new Error('Cancelado');
        const data = await blobToBase64(blob.slice(start, start + CHUNK));
        if (start === 0) await Filesystem.writeFile({ directory: DIR, path, data, recursive: true });
        else await Filesystem.appendFile({ directory: DIR, path, data });
        if (onProgress) onProgress(Math.min(blob.size, start + CHUNK), blob.size);
      }
    },

    async readBlob(path) {
      const res = await fetch(this.url(path));
      if (!res.ok) throw new Error(`Não consegui ler ${path}`);
      return res.blob();
    },

    async mkdir(path) {
      try { await Filesystem.mkdir({ directory: DIR, path, recursive: true }); } catch {}
    },

    async remove(path, isDir) {
      try {
        if (isDir) await Filesystem.rmdir({ directory: DIR, path, recursive: true });
        else await Filesystem.deleteFile({ directory: DIR, path });
      } catch {}
    },

    async rename(from, to) {
      await this.mkdir(parent(to));
      await Filesystem.rename({ directory: DIR, from, to, toDirectory: DIR });
    },

    async exists(path) {
      try {
        await Filesystem.stat({ directory: DIR, path });
        return true;
      } catch {
        return false;
      }
    },

    async httpGet(url) {
      const res = await CapacitorHttp.request({ url, method: 'GET', responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0 ComicStream' } });
      return { status: res.status, headers: lowerHeaders(res.headers), text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data), url: res.url || url };
    },

    async httpJson(url, headers = {}) {
      const res = await CapacitorHttp.request({ url, method: 'GET', headers });
      return { status: res.status, data: typeof res.data === 'string' ? JSON.parse(res.data || 'null') : res.data };
    },

    async download(url, path, onProgress, headers = {}) {
      await this.mkdir(parent(path));
      const handle = onProgress
        ? await Filesystem.addListener('progress', (p) => { if (p.url === url) onProgress(p.bytes, p.contentLength); })
        : null;
      try {
        await Filesystem.downloadFile({ url, path, directory: DIR, progress: !!onProgress, recursive: true, headers });
      } finally {
        if (handle) handle.remove();
      }
    }
  };
  return adapter;
}

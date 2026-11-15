const BASE = 'api.php';

const native = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
const localMode = native || !!window.__csLocalAdapter;

export const platform = native ? 'android' : window.comicstreamDesktop ? 'desktop' : localMode ? 'local' : 'web';

async function parse(res) {
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Erro ${res.status}`);
  if (typeof data === 'string') {
    throw new Error(platform === 'desktop' ? 'o servidor interno não respondeu. Feche e abra o app de novo' : 'o servidor PHP não respondeu. Abra pelo iniciar.bat');
  }
  return data;
}

const remoteApi = {
  current: null,
  local: false,

  url(route, params = {}) {
    return `${BASE}?${new URLSearchParams({ r: route, ...params })}`;
  },

  get(route, params) {
    return fetch(this.url(route, params), { cache: 'no-store' }).then(parse);
  },

  postJson(route, body) {
    return fetch(this.url(route), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    }).then(parse);
  },

  postBlob(route, params, blob) {
    return fetch(this.url(route, params), {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob
    }).then(parse);
  },

  fileUrl(file) {
    return this.url('file', { p: file.path, v: file.key });
  },

  pageUrl(file, i) {
    return this.url('page', { p: file.path, i, v: file.key });
  },

  thumbUrl(file) {
    return this.url('thumb', { k: file.key });
  },

  preparePages() {
    return Promise.resolve();
  },

  upload(file, path, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append('path', path);
      form.append('file', file, file.name);
      xhr.open('POST', this.url('upload'));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error((data && data.error) || `Erro ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Falha de rede'));
      xhr.onabort = () => reject(new Error('Cancelado'));
      this.current = xhr;
      xhr.send(form);
    });
  },

  abortUpload() {
    if (this.current) this.current.abort();
  }
};

async function createLocal() {
  const { createLocalApi } = await import('./local-api.js');
  let adapter = window.__csLocalAdapter;
  if (!adapter) {
    const { createCapacitorAdapter } = await import('./fs-capacitor.js');
    adapter = await createCapacitorAdapter();
  }
  return createLocalApi(adapter);
}

export const api = localMode ? await createLocal() : remoteApi;

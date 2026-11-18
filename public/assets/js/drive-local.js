import { parseDriveLink, parseFolderHtml, parseFileTitle, parseConfirmForm, downloadUrl, folderUrl, viewUrl } from './drive-common.js';

export function createLocalDrive(fs, { LIB, kindOf, sanitizePath }) {
  const jobs = [];
  let seq = 0;

  const snapshot = (job) => {
    const { cancelled, go, ...rest } = job;
    return rest;
  };

  let slots = 4;
  const waiting = [];
  const acquire = () => (slots > 0 ? (slots--, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else slots++;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function fetchFolder(id) {
    let parsed = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await acquire();
      let res;
      try {
        res = await fs.httpGet(folderUrl(id));
      } finally {
        release();
      }
      if (res.status >= 400) throw new Error(`O Google Drive respondeu ${res.status}. A pasta está compartilhada como "qualquer pessoa com o link"?`);
      parsed = parseFolderHtml(res.text);
      if (parsed.items.length) break;
      await sleep(500 * (attempt + 1));
    }
    return parsed;
  }

  async function listFolder(id, rel, depth, out, job) {
    const { title, items } = await fetchFolder(id);
    if (depth === 0 && title) job.title = title;
    const subs = [];
    for (const item of items) {
      if (job.cancelled) return;
      if (item.folder) {
        if (depth < 4) subs.push(listFolder(item.id, rel ? `${rel}/${item.name}` : item.name, depth + 1, out, job));
      } else if (kindOf(item.name)) {
        out.push({ id: item.id, name: item.name, rel });
        job.files = out.length;
      } else {
        job.skipped++;
        const dot = item.name.lastIndexOf('.');
        const ext = dot > 0 && item.name.length - dot <= 7 ? item.name.slice(dot).toLowerCase() : 'sem extensão';
        job.ignored[ext] = (job.ignored[ext] || 0) + 1;
      }
    }
    job.folders++;
    await Promise.all(subs);
  }

  async function sizeOf(path) {
    const i = path.lastIndexOf('/');
    const name = path.slice(i + 1);
    const entry = (await fs.list(path.slice(0, i))).find((e) => e.name === name);
    return entry ? entry.size : 0;
  }

  async function looksLikeHtml(path) {
    if ((await sizeOf(path)) > 400000) return null;
    const text = await fs.readText(path);
    return text && /^\s*<(!doctype|html)/i.test(text.slice(0, 200)) ? text : null;
  }

  async function fetchFile(job, item, dest) {
    const tmp = `${dest}.part`;
    const onProgress = (bytes) => { job.bytes = job.base + bytes; job.current = item.name; };
    await fs.download(downloadUrl(item.id), tmp, onProgress);
    const html = await looksLikeHtml(tmp);
    if (html) {
      const retry = parseConfirmForm(html);
      await fs.remove(tmp, false);
      if (!retry) throw new Error(`${item.name}: o Drive bloqueou o download (limite de cota ou arquivo privado)`);
      await fs.download(retry, tmp, onProgress);
      if (await looksLikeHtml(tmp)) {
        await fs.remove(tmp, false);
        throw new Error(`${item.name}: o Drive bloqueou o download`);
      }
    }
    await fs.remove(dest, false);
    await fs.rename(tmp, dest);
  }

  async function run(job, spec) {
    try {
      const list = [];
      if (spec.type === 'folder') {
        await listFolder(spec.id, '', 0, list, job);
      } else {
        const page = await fs.httpGet(viewUrl(spec.id));
        const name = parseFileTitle(page.text) || `arquivo-${spec.id}.pdf`;
        job.title = name;
        if (kindOf(name)) list.push({ id: spec.id, name, rel: '' });
        else job.skipped++;
      }
      list.sort((a, b) => `${a.rel}/${a.name}`.localeCompare(`${b.rel}/${b.name}`, undefined, { numeric: true, sensitivity: 'base' }));
      const base = spec.type === 'folder' ? `${LIB}/Downloads/${sanitizePath(job.title || 'Google Drive') || 'Google Drive'}` : `${LIB}/Downloads`;
      job.files = list.length;
      const pending = [];
      for (const item of list) {
        const rel = sanitizePath(item.rel ? `${item.rel}/${item.name}` : item.name);
        const dest = `${base}/${rel}`;
        if (await fs.exists(dest)) job.done++;
        else pending.push({ item, dest });
      }
      job.already = job.done;
      job.analyzed = true;
      if (pending.length && !job.cancelled) {
        job.status = 'awaiting';
        await new Promise((resolve) => { job.go = resolve; });
      }
      job.status = 'downloading';
      const began = Date.now();
      let finished = 0;
      for (const { item, dest } of pending) {
        if (job.cancelled) break;
        job.base = job.bytes;
        try {
          await fetchFile(job, item, dest);
          job.done++;
        } catch (e) {
          job.errors.push(e.message || String(e));
        }
        finished++;
        job.eta = Math.round(((Date.now() - began) / finished) * (pending.length - finished) / 1000);
      }
      job.eta = 0;
      job.status = job.cancelled ? 'cancelled' : job.files === 0 ? 'empty' : 'done';
    } catch (e) {
      job.status = 'error';
      job.errors.push(e.message || String(e));
    }
    job.current = '';
    job.finished = Date.now();
  }

  return {
    jobs: () => jobs.slice(-10).reverse().map(snapshot),

    start(body) {
      const spec = parseDriveLink(body.link);
      if (!spec) throw new Error('Link do Google Drive inválido');
      const job = { id: `j${Date.now()}${++seq}`, source: 'public', title: '', status: 'listing', files: 0, done: 0, skipped: 0, ignored: {}, folders: 0, bytes: 0, base: 0, already: 0, analyzed: false, totalBytes: 0, estimated: false, eta: null, current: '', errors: [], started: Date.now(), cancelled: false };
      jobs.push(job);
      run(job, spec);
      return snapshot(job);
    },

    cancel(id) {
      const job = jobs.find((j) => j.id === id);
      if (job) {
        job.cancelled = true;
        if (job.go) job.go();
      }
      return { ok: true };
    },

    clear() {
      const active = ['listing', 'analyzing', 'awaiting', 'downloading'];
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (!active.includes(jobs[i].status)) jobs.splice(i, 1);
      }
      return { ok: true };
    },

    confirm(id) {
      const job = jobs.find((j) => j.id === id);
      if (job && job.go) job.go();
      return { ok: true };
    }
  };
}

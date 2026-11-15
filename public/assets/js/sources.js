import { api } from './api.js';

export const PDF_OPTS = {
  standardFontDataUrl: 'assets/vendor/pdfjs/standard_fonts/',
  isEvalSupported: false
};

const timeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

class Source {
  constructor(count) {
    this.count = count;
    this.ratios = new Map();
    this.defaultRatio = 2 / 3;
    this.remote = true;
  }

  ratio(i) {
    return this.ratios.get(i) || this.defaultRatio;
  }

  known(i) {
    return this.ratios.has(i);
  }

  learn(i, w, h) {
    if (!w || !h) return;
    if (!this.ratios.size) this.defaultRatio = w / h;
    this.ratios.set(i, w / h);
  }

  async probe(i) {
    const url = await this.url(i);
    if (!url) return;
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
      this.learn(i, img.naturalWidth, img.naturalHeight);
    } catch {}
  }

  focus() {}
  release() {}
  destroy() {}
}

class ArchiveSource extends Source {
  static async open(file) {
    const info = await api.get('pages', { p: file.path });
    const source = new ArchiveSource(file, info.count);
    await timeout(source.probe(0), 6000);
    return source;
  }

  constructor(file, count) {
    super(count);
    this.file = file;
  }

  url(i) {
    return Promise.resolve(i >= 0 && i < this.count ? api.pageUrl(this.file, i) : null);
  }
}

class ImageSource extends Source {
  static async open(list, start) {
    const source = new ImageSource(list);
    await timeout(source.probe(start), 6000);
    return source;
  }

  constructor(list) {
    super(list.length);
    this.list = list;
  }

  url(i) {
    return Promise.resolve(this.list[i] ? api.fileUrl(this.list[i]) : null);
  }
}

class PdfSource extends Source {
  static async open(file, onProgress) {
    const task = pdfjsLib.getDocument({
      url: api.fileUrl(file),
      rangeChunkSize: 262144,
      disableAutoFetch: true,
      disableStream: true,
      ...PDF_OPTS
    });
    if (onProgress) task.onProgress = (p) => { if (p.total) onProgress(p.loaded / p.total); };
    const doc = await task.promise;
    const source = new PdfSource(doc);
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    source.defaultRatio = vp.width / vp.height;
    source.ratios.set(0, source.defaultRatio);
    return source;
  }

  constructor(doc) {
    super(doc.numPages);
    this.doc = doc;
    this.remote = false;
    this.cache = new Map();
    this.pending = new Map();
    this.center = 0;
    this.busy = false;
    this.dead = false;
  }

  learn() {}

  url(i) {
    if (i < 0 || i >= this.count || this.dead) return Promise.resolve(null);
    if (this.cache.has(i)) return Promise.resolve(this.cache.get(i));
    let job = this.pending.get(i);
    if (!job) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      job = { promise, resolve };
      this.pending.set(i, job);
      this.pump();
    }
    return job.promise;
  }

  focus(i, keep) {
    this.center = i;
    for (const [k, job] of this.pending) {
      if (Math.abs(k - i) > keep) {
        this.pending.delete(k);
        job.resolve(null);
      }
    }
  }

  release(lo, hi) {
    for (const [k, url] of this.cache) {
      if (k < lo || k > hi) {
        URL.revokeObjectURL(url);
        this.cache.delete(k);
      }
    }
  }

  async pump() {
    if (this.busy || this.dead || !this.pending.size) return;
    let best = -1;
    let bestDist = Infinity;
    for (const k of this.pending.keys()) {
      const d = Math.abs(k - this.center) + (k < this.center ? 0.5 : 0);
      if (d < bestDist) { bestDist = d; best = k; }
    }
    const job = this.pending.get(best);
    this.pending.delete(best);
    this.busy = true;
    try {
      const url = await this.render(best);
      if (url && !this.dead) this.cache.set(best, url);
      job.resolve(this.dead ? null : url);
    } catch {
      job.resolve(null);
    } finally {
      this.busy = false;
      this.pump();
    }
  }

  renderHi(i, factor) {
    if (this.dead || i < 0 || i >= this.count) return Promise.resolve(null);
    return this.render(i, factor).catch(() => null);
  }

  async render(i, factor = 1) {
    const page = await this.doc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    this.ratios.set(i, base.width / base.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let scale = Math.max((window.innerHeight * dpr) / base.height, (Math.min(window.innerWidth, 1200) * dpr) / base.width) * factor;
    scale = Math.max(0.5, Math.min(scale, Math.min(3200 * factor, 7000) / Math.max(base.width, base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    if (this.dead) return null;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    canvas.width = 0;
    canvas.height = 0;
    return blob ? URL.createObjectURL(blob) : null;
  }

  destroy() {
    this.dead = true;
    for (const job of this.pending.values()) job.resolve(null);
    this.pending.clear();
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear();
    this.doc.destroy();
  }
}

export function createSource(file, chapters, onProgress) {
  if (file.kind === 'pdf') return PdfSource.open(file, onProgress);
  if (file.kind === 'archive') return ArchiveSource.open(file);
  return ImageSource.open(chapters, Math.max(0, chapters.indexOf(file)));
}

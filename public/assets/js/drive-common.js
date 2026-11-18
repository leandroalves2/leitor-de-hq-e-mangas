const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' };

export function decodeHtml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .trim();
}

export function parseDriveLink(link) {
  const s = String(link || '').trim();
  let m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,}).*folder/i) || s.match(/folderview\?id=([\w-]{10,})/);
  if (m) return { type: 'folder', id: m[1] };
  m = s.match(/\/file\/d\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/) || s.match(/\/d\/([\w-]{10,})/);
  if (m) return { type: 'file', id: m[1] };
  if (/^[\w-]{20,}$/.test(s)) return { type: 'folder', id: s };
  return null;
}

export function parseFolderHtml(html) {
  const items = [];
  const re = /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const href = decodeHtml(m[2]);
    items.push({ id: m[1], name: decodeHtml(m[3].replace(/<[^>]+>/g, '')), folder: /\/folders\//.test(href) });
  }
  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  return { title: t ? decodeHtml(t[1]).replace(/\s*-\s*Google Drive\s*$/i, '') : '', items };
}

export function parseFileTitle(html) {
  const og = html.match(/<meta property="og:title" content="([^"]*)"/i);
  if (og) return decodeHtml(og[1]);
  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  return t ? decodeHtml(t[1]).replace(/\s*-\s*Google Drive\s*$/i, '') : '';
}

export function parseConfirmForm(html) {
  const form = html.match(/<form[^>]+id="download-form"[^>]*action="([^"]+)"[\s\S]*?<\/form>/i);
  if (!form) return null;
  const params = new URLSearchParams();
  const re = /<input[^>]+type="hidden"[^>]*>/gi;
  let m;
  while ((m = re.exec(form[0]))) {
    const name = m[0].match(/name="([^"]+)"/);
    const value = m[0].match(/value="([^"]*)"/);
    if (name) params.set(decodeHtml(name[1]), value ? decodeHtml(value[1]) : '');
  }
  return `${decodeHtml(form[1])}?${params}`;
}

export const downloadUrl = (id) => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
export const folderUrl = (id) => `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`;
export const viewUrl = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;

export const hasRealExt = (name) => /\.[A-Za-z][A-Za-z0-9]{1,4}$/.test(name);

const MAGIC = [['%PDF', 'pdf'], ['PK\x03\x04', 'cbz'], ['Rar!', 'cbr'], ['7z\xBC\xAF', 'cb7'], ['\xFF\xD8\xFF', 'jpg'], ['\x89PNG', 'png']];

export function sniffExt(res, kindOf) {
  const type = (res.headers['content-type'] || '').toLowerCase();
  if (type.includes('text/html')) return null;
  let bin = '';
  try { bin = atob(String(res.data || '').slice(0, 24)); } catch {}
  for (const [sig, ext] of MAGIC) if (bin.startsWith(sig)) return ext;
  if (bin.startsWith('RIFF') && bin.slice(8, 12) === 'WEBP') return 'webp';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.headers['content-disposition'] || '');
  if (m) {
    let n = m[1];
    try { n = decodeURIComponent(n); } catch {}
    if (kindOf(n)) return n.slice(n.lastIndexOf('.') + 1).toLowerCase();
  }
  return type.includes('application/pdf') ? 'pdf' : null;
}

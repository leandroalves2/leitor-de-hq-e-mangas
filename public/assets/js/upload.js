import { api } from './api.js';
import { state } from './state.js';
import { $, fmtSize, toast } from './util.js';

const SUPPORTED = /\.(pdf|cbz|cbr|cb7|zip|rar|7z|jpe?g|png|webp|gif|avif|bmp)$/i;
let busy = false;
let cancelled = false;

const hasFiles = (e) => {
  const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
  return types.includes('Files') && !types.includes('application/x-comicstream') && !document.body.classList.contains('dragging-card');
};

async function collect(dt) {
  const entries = Array.from(dt.items || [])
    .map((item) => (item.kind === 'file' && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return Array.from(dt.files || []).map((file) => ({ file, rel: file.name }));
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, rel: prefix + file.name });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    } while (batch.length);
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}

function panel(index, count, name, loaded, total) {
  $('#up-title').textContent = `Enviando ${index + 1} de ${count}`;
  $('#up-file').textContent = `${name} · ${fmtSize(loaded)} de ${fmtSize(total)}`;
  $('#up-bar').style.width = `${total ? Math.round((loaded / total) * 100) : 0}%`;
}

async function start(items, onDone) {
  if (busy) { toast('Espere o envio atual terminar', 'info'); return; }
  const list = items.filter((x) => SUPPORTED.test(x.file.name));
  const skipped = items.length - list.length;
  if (!list.length) { toast('Nenhum arquivo suportado (PDF, CBZ, CBR, imagens)', 'err'); return; }

  busy = true;
  cancelled = false;
  const base = state.folderPath ? `${state.folderPath}/` : '';
  const total = list.reduce((sum, x) => sum + x.file.size, 0);
  let done = 0;
  let ok = 0;
  const errors = [];
  $('#upload-panel').hidden = false;

  for (let i = 0; i < list.length && !cancelled; i++) {
    const { file, rel } = list[i];
    panel(i, list.length, file.name, done, total);
    try {
      await api.upload(file, base + rel, (loaded) => panel(i, list.length, file.name, done + loaded, total));
      ok++;
    } catch (e) {
      if (cancelled) break;
      errors.push(`${file.name}: ${e.message}`);
    }
    done += file.size;
  }

  busy = false;
  $('#upload-panel').hidden = true;
  if (ok) toast(`BOOM! ${ok} ${ok === 1 ? 'arquivo chegou' : 'arquivos chegaram'} na estante`, 'ok');
  if (errors.length) toast(errors.slice(0, 2).join(' • ') + (errors.length > 2 ? ` (+${errors.length - 2})` : ''), 'err', 7000);
  if (skipped) toast(`${skipped} arquivo(s) ignorado(s) por formato`, 'info');
  if (cancelled) toast('Envio cancelado', 'info');
  if (ok) onDone();
}

export function pickFiles(kind) {
  $(kind === 'folder' ? '#pick-folder' : '#pick-files').click();
}

export function initUpload(onDone) {
  const files = $('#pick-files');
  const folder = $('#pick-folder');
  files.addEventListener('change', () => {
    start(Array.from(files.files).map((file) => ({ file, rel: file.name })), onDone);
    files.value = '';
  });
  folder.addEventListener('change', () => {
    start(Array.from(folder.files).map((file) => ({ file, rel: file.webkitRelativePath || file.name })), onDone);
    folder.value = '';
  });
  $('#up-cancel').addEventListener('click', () => { cancelled = true; api.abortUpload(); });

  const drop = $('#drop');
  let depth = 0;
  const reading = () => document.body.classList.contains('reading');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || reading()) return;
    e.preventDefault();
    depth++;
    drop.hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) drop.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    drop.hidden = true;
    if (reading()) return;
    collect(e.dataTransfer).then((items) => start(items, onDone)).catch(() => toast('Não consegui ler os arquivos soltos', 'err'));
  });
}

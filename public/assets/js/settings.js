import { api, platform } from './api.js';
import { $, esc, toast } from './util.js';

const PLATFORM = { web: 'Navegador (servidor PHP)', desktop: 'App para computador', android: 'App Android', local: 'Modo local' };

async function render() {
  const box = $('#settings-body');
  const desk = window.comicstreamDesktop;
  let library = '';
  let version = '';
  if (desk) {
    const info = await desk.info().catch(() => ({}));
    library = info.library || '';
    version = info.version || '';
  } else if (api.local) {
    library = api.libraryLabel || '';
  } else {
    library = 'Pasta uploads do projeto';
  }
  box.innerHTML = `
    <section class="set-block">
      <h4>Biblioteca</h4>
      <code class="set-path">${esc(library)}</code>
      ${desk ? `<div class="row-btns">
        <button class="btn btn-yellow" data-set="open"><svg class="ic"><use href="#i-folder"/></svg><span>Abrir pasta</span></button>
        <button class="btn" data-set="choose"><svg class="ic"><use href="#i-edit"/></svg><span>Trocar pasta</span></button>
      </div>` : ''}
      ${api.local ? '<p class="hint">Para copiar HQs pelo cabo USB, conecte o celular no PC e abra esta pasta. Ou use os botões Enviar e Drive.</p>' : ''}
      ${!desk && !api.local ? '<p class="hint">Coloque as HQs na pasta <b>uploads</b> do projeto, ou use os botões Enviar e Drive.</p>' : ''}
    </section>
    <section class="set-block">
      <h4>Downloads do Google Drive</h4>
      <p class="hint">Vão para a pasta <b>Downloads</b> dentro da biblioteca. Uma pasta compartilhada vira uma subpasta com o mesmo nome.</p>
    </section>
    <section class="set-block">
      <h4>Sobre</h4>
      <p class="hint">ComicStream${version ? ` ${esc(version)}` : ''} · ${esc(PLATFORM[platform] || platform)}</p>
    </section>`;
}

export function initSettings() {
  const modal = $('#settings-modal');
  $('#btn-settings').addEventListener('click', () => { modal.hidden = false; render(); });
  modal.addEventListener('click', async (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) { modal.hidden = true; return; }
    const btn = e.target.closest('[data-set]');
    if (!btn || !window.comicstreamDesktop) return;
    if (btn.dataset.set === 'open') window.comicstreamDesktop.openLibrary();
    if (btn.dataset.set === 'choose') {
      const changed = await window.comicstreamDesktop.chooseLibrary();
      if (changed) toast('Pasta trocada! Recarregando...', 'ok');
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.hidden = true; });
}

import { api, platform } from './api.js';
import { $, $$, esc, fmtSize, toast } from './util.js';
import { pickFiles } from './upload.js';

const ACTIVE = ['queued', 'listing', 'analyzing', 'awaiting', 'downloading'];
const announced = new Set();
const STATUS = {
  queued: 'Na fila',
  listing: 'Lendo a pasta...',
  analyzing: 'Analisando...',
  awaiting: 'Aguardando você',
  downloading: 'Baixando',
  done: 'Concluído',
  empty: 'Nenhuma HQ encontrada',
  cancelled: 'Cancelado',
  error: 'Erro'
};

let timer = 0;
let lastStatus = new Map();
let stack = [{ id: 'root', name: 'Meu Drive' }];
const selected = new Map();
let loginPoll = 0;

const modal = () => $('#drive-modal');

function setTab(tab) {
  $$('#drive-tabs [data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  $('#drive-public').hidden = tab !== 'public';
  $('#drive-account').hidden = tab !== 'account';
  if (tab === 'account') renderAccount();
}

export function openDrive(tab = 'public') {
  modal().hidden = false;
  setTab(tab);
  poll();
  if (tab === 'public') setTimeout(() => $('#drive-link').focus(), 50);
}

function closeDrive() {
  modal().hidden = true;
  clearInterval(loginPoll);
}

function fmtEta(seconds) {
  if (seconds == null) return 'calculando...';
  const s = Math.max(0, Math.round(seconds));
  if (s < 5) return 'poucos segundos';
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

function summary(job) {
  const news = job.files - (job.already || 0);
  const parts = [`${job.files} ${job.files === 1 ? 'HQ' : 'HQs'}`];
  if (job.already) parts.push(`${job.already} já na biblioteca`);
  if (news > 0 && job.totalBytes) parts.push(`${job.estimated ? '~' : ''}${fmtSize(job.totalBytes)} a baixar`);
  return parts.join(' · ');
}

function confirmBox(job) {
  const eta = job.totalBytes && job.eta != null ? ` Tempo estimado: ~${fmtEta(job.eta)}.` : '';
  const news = job.files - (job.already || 0);
  return `<p class="hint">Encontrei <b>${news}</b> ${news === 1 ? 'HQ nova' : 'HQs novas'} para baixar.${esc(eta)} Quer começar?</p>
    <div class="row-btns"><button class="btn btn-yellow sm" data-confirm="${esc(job.id)}">Baixar agora</button><button class="btn sm" data-cancel="${esc(job.id)}">Não baixar</button></div>`;
}

function jobLine(job) {
  const active = ACTIVE.includes(job.status);
  const pct = job.files ? Math.round((job.done / job.files) * 100) : 0;
  const info = [];
  const analyzing = ['analyzing', 'listing', 'awaiting'].includes(job.status);
  if (job.files && !analyzing) info.push(`${job.done}/${job.files} arquivos`);
  if (job.bytes) info.push(fmtSize(job.bytes));
  if (job.folders) info.push(`${job.folders} ${job.folders === 1 ? 'pasta lida' : 'pastas lidas'}`);
  if (job.skipped) info.push(`${job.skipped} ignorados`);
  const ign = Object.entries(job.ignored || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v})`).join(' · ');
  const head = job.analyzed && job.files ? `<small class="job-sum"><b>${esc(summary(job))}</b>${job.status === 'downloading' ? ` · faltam ~${esc(fmtEta(job.eta))}` : ''}</small>` : '';
  return `<div class="job job-${esc(job.status)}">
    <div class="job-head"><strong title="${esc(job.title)}">${esc(job.title || 'Google Drive')}</strong><span class="job-status">${esc(STATUS[job.status] || job.status)}</span>
      ${active ? `<button class="btn icon sm" data-cancel="${esc(job.id)}" title="Cancelar"><svg class="ic"><use href="#i-x"/></svg></button>` : ''}</div>
    ${head}
    ${job.status === 'awaiting' ? confirmBox(job) : ''}
    <div class="load-bar${active && (!job.files || analyzing) ? ' indeterminate' : ''}"><i style="width:${active ? pct : 100}%"></i></div>
    <small>${esc(info.join(' · '))}${job.current ? ` · ${esc(job.current)}` : ''}</small>
    ${ign ? `<small class="job-ign">Ignorados por formato: ${esc(ign)}</small>` : ''}
    ${job.errors && job.errors.length ? `<small class="job-err">${esc(job.errors.slice(0, 2).join(' • '))}</small>` : ''}
  </div>`;
}

async function poll() {
  clearTimeout(timer);
  let jobs = [];
  try {
    jobs = (await api.get('drive-jobs')).jobs || [];
  } catch {
    jobs = [];
  }
  let finished = false;
  for (const job of jobs) {
    const before = lastStatus.get(job.id);
    if (before && ACTIVE.includes(before) && !ACTIVE.includes(job.status)) {
      finished = true;
      if (job.status === 'done') toast(`Download concluído: ${job.done} ${job.done === 1 ? 'HQ' : 'HQs'} em Downloads`, 'ok', 4000);
      else if (job.status === 'error') toast(`Erro no download: ${(job.errors || [])[0] || ''}`, 'err', 6000);
    }
    if (job.analyzed && job.files && ['awaiting', 'downloading'].includes(job.status) && !announced.has(job.id)) {
      announced.add(job.id);
      const eta = job.totalBytes && job.eta != null ? ` · tempo estimado ~${fmtEta(job.eta)}` : '';
      toast(`${summary(job)}${eta}`, 'ok', 8000);
    }
    lastStatus.set(job.id, job.status);
  }
  if (finished) window.dispatchEvent(new CustomEvent('cs:reload'));
  const active = jobs.filter((j) => ACTIVE.includes(j.status)).length;
  const badge = $('#drive-badge');
  badge.hidden = !active;
  badge.textContent = String(active);
  $('#drive-jobs').innerHTML = jobs.length
    ? `<div class="job-title"><h4 class="caption caption-blue">Downloads</h4>${jobs.some((j) => !ACTIVE.includes(j.status)) ? '<button class="btn sm" data-clear>Limpar lista</button>' : ''}</div>${jobs.map(jobLine).join('')}`
    : '';
  if (active || !modal().hidden) timer = setTimeout(poll, active ? 1200 : 4000);
}

async function startDownload(body) {
  try {
    await api.postJson('drive-download', body);
    toast('Analisando a pasta... em instantes eu mostro quantas HQs são e o tempo.', 'info', 3500);
    poll();
  } catch (e) {
    toast(e.message, 'err', 6000);
  }
}

const STEPS = `<ol class="steps">
  <li>Abra <b>console.cloud.google.com</b> e crie um projeto (qualquer nome).</li>
  <li>Em <b>APIs e serviços → Biblioteca</b>, ative a <b>Google Drive API</b>.</li>
  <li>Em <b>Tela de consentimento OAuth</b>, escolha <b>Externo</b> e adicione seu e-mail em <b>Usuários de teste</b>.</li>
  <li>Em <b>Credenciais → Criar credenciais → ID do cliente OAuth</b>, escolha o tipo <b>App para computador</b>.</li>
  <li>Copie o <b>ID do cliente</b> e a <b>Chave secreta</b> e cole abaixo.</li>
</ol>`;

async function renderAccount() {
  const box = $('#drive-account');
  if (api.local) {
    box.innerHTML = `<p class="hint-lg">No Android, o seletor de arquivos do sistema já mostra o <b>Google Drive</b> da conta logada no celular. Escolha as HQs por lá e elas são copiadas para a estante.</p>
      <button class="btn btn-yellow" data-pick-drive><svg class="ic"><use href="#i-cloud"/></svg><span>Escolher do Google Drive</span></button>
      <p class="hint">Dica: no seletor, toque no menu (☰) e escolha <b>Drive</b>.</p>`;
    return;
  }
  box.innerHTML = '<p class="hint-lg">Carregando...</p>';
  let st;
  try {
    st = await api.get('google');
  } catch (e) {
    box.innerHTML = `<p class="hint-lg">${esc(e.message)}</p>`;
    return;
  }
  if (!st.configured) {
    box.innerHTML = `<p class="hint-lg">Para entrar com a sua conta, o Google exige uma credencial própria (é grátis e leva uns 5 minutos):</p>${STEPS}
      <form class="g-form" id="g-config">
        <label>ID do cliente<input name="client_id" required placeholder="123-abc.apps.googleusercontent.com" autocomplete="off"></label>
        <label>Chave secreta do cliente<input name="client_secret" required placeholder="GOCSPX-..." autocomplete="off"></label>
        <button class="btn btn-yellow" type="submit">Salvar</button>
      </form>`;
    return;
  }
  if (!st.connected) {
    box.innerHTML = `<p class="hint-lg">Credencial salva. Agora entre com a sua conta: o login abre no navegador e, ao terminar, volte para cá.</p>
      <div class="row-btns"><button class="btn btn-yellow" data-g-login><svg class="ic"><use href="#i-cloud"/></svg><span>Entrar com Google</span></button>
      <button class="btn" data-g-reset>Trocar credencial</button></div>
      ${st.curl ? '' : '<p class="job-err">A extensão curl do PHP não está ativa: o login pode falhar.</p>'}`;
    return;
  }
  box.innerHTML = `<div class="g-head"><span>Conectado como <b>${esc(st.email || 'sua conta')}</b></span><button class="btn sm" data-g-logout>Sair</button></div>
    <nav class="g-crumbs" id="g-crumbs"></nav>
    <div class="g-list" id="g-list"><p class="hint-lg">Carregando...</p></div>
    <div class="row-btns"><button class="btn btn-yellow" data-g-download disabled><svg class="ic"><use href="#i-download"/></svg><span>Baixar selecionados</span></button></div>`;
  renderBrowser();
}

async function renderBrowser() {
  const list = $('#g-list');
  if (!list) return;
  $('#g-crumbs').innerHTML = stack.map((f, i) => (i === stack.length - 1
    ? `<span class="crumb current">${esc(f.name)}</span>`
    : `<button class="crumb" data-g-up="${i}">${esc(f.name)}</button><span class="sep">›</span>`)).join('');
  list.innerHTML = '<p class="hint-lg">Carregando...</p>';
  try {
    const data = await api.get('drive-list', { folder: stack[stack.length - 1].id });
    list.innerHTML = data.items.length
      ? data.items.map((it) => `<label class="g-item${it.folder ? ' g-folder' : ''}">
          <input type="checkbox" data-g-sel="${esc(it.id)}" data-name="${esc(it.name)}" data-folder="${it.folder ? 1 : 0}"${selected.has(it.id) ? ' checked' : ''}>
          <svg class="ic"><use href="${it.folder ? '#i-folder' : '#i-files'}"/></svg>
          ${it.folder ? `<button type="button" class="g-open" data-g-open="${esc(it.id)}" data-name="${esc(it.name)}">${esc(it.name)}</button>` : `<span>${esc(it.name)}</span>`}
          <small>${it.folder ? 'pasta' : fmtSize(it.size)}</small>
        </label>`).join('')
      : '<p class="hint-lg">Nenhuma pasta ou HQ aqui.</p>';
  } catch (e) {
    list.innerHTML = `<p class="job-err">${esc(e.message)}</p>`;
  }
  syncSelection();
}

function syncSelection() {
  const btn = document.querySelector('[data-g-download]');
  if (!btn) return;
  btn.disabled = !selected.size;
  btn.querySelector('span').textContent = selected.size ? `Baixar selecionados (${selected.size})` : 'Baixar selecionados';
}

export function initDrive() {
  $('#btn-drive').addEventListener('click', () => openDrive());
  modal().addEventListener('click', async (e) => {
    const t = e.target;
    if (t === modal() || t.closest('[data-close]')) { closeDrive(); return; }
    const tab = t.closest('[data-tab]');
    if (tab) { setTab(tab.dataset.tab); return; }
    if (t.closest('[data-clear]')) { await api.postJson('drive-clear', {}).catch(() => {}); lastStatus.clear(); poll(); return; }
    const confirm = t.closest('[data-confirm]');
    if (confirm) { await api.postJson('drive-confirm', { id: confirm.dataset.confirm }).catch(() => {}); poll(); return; }
    const cancel = t.closest('[data-cancel]');
    if (cancel) { await api.postJson('drive-cancel', { id: cancel.dataset.cancel }).catch(() => {}); poll(); return; }
    if (t.closest('[data-pick-drive]')) { closeDrive(); pickFiles('files'); return; }
    if (t.closest('[data-g-login]')) {
      try {
        const { url } = await api.get('google-login');
        window.open(url, '_blank');
        toast('Termine o login no navegador e volte para cá', 'info', 4000);
        clearInterval(loginPoll);
        let tries = 0;
        loginPoll = setInterval(async () => {
          tries++;
          const st = await api.get('google').catch(() => null);
          if ((st && st.connected) || tries > 150) {
            clearInterval(loginPoll);
            if (st && st.connected) { toast('Conta Google conectada!', 'ok'); renderAccount(); }
          }
        }, 2000);
      } catch (err) {
        toast(err.message, 'err', 5000);
      }
      return;
    }
    if (t.closest('[data-g-logout]')) { await api.postJson('google-logout', {}).catch(() => {}); selected.clear(); renderAccount(); return; }
    if (t.closest('[data-g-reset]')) { await api.postJson('google-config', { client_id: '', client_secret: '' }).catch(() => {}); renderAccountForm(); return; }
    const open = t.closest('[data-g-open]');
    if (open) { e.preventDefault(); stack.push({ id: open.dataset.gOpen, name: open.dataset.name }); renderBrowser(); return; }
    const up = t.closest('[data-g-up]');
    if (up) { stack = stack.slice(0, Number(up.dataset.gUp) + 1); renderBrowser(); return; }
    if (t.closest('[data-g-download]')) {
      const items = [...selected.values()];
      selected.clear();
      startDownload({ items });
      renderBrowser();
    }
  });
  modal().addEventListener('change', (e) => {
    const cb = e.target.closest('[data-g-sel]');
    if (!cb) return;
    if (cb.checked) selected.set(cb.dataset.gSel, { id: cb.dataset.gSel, name: cb.dataset.name, folder: cb.dataset.folder === '1' });
    else selected.delete(cb.dataset.gSel);
    syncSelection();
  });
  modal().addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'drive-public-form') {
      const link = $('#drive-link').value.trim();
      if (!link) return;
      $('#drive-link').value = '';
      startDownload({ link });
      return;
    }
    if (e.target.id === 'g-config') {
      const form = new FormData(e.target);
      try {
        await api.postJson('google-config', { client_id: form.get('client_id'), client_secret: form.get('client_secret') });
        toast('Credencial salva!', 'ok');
        renderAccount();
      } catch (err) {
        toast(err.message, 'err', 5000);
      }
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal().hidden) closeDrive(); });
  if (platform === 'android') $('#drive-tab-account').textContent = 'Minha conta (seletor)';
  poll();
}

function renderAccountForm() {
  const box = $('#drive-account');
  box.innerHTML = `${STEPS}<form class="g-form" id="g-config">
    <label>ID do cliente<input name="client_id" required autocomplete="off"></label>
    <label>Chave secreta do cliente<input name="client_secret" required autocomplete="off"></label>
    <button class="btn btn-yellow" type="submit">Salvar</button></form>`;
}

import { api } from './api.js';
import { state, statusOf } from './state.js';
import { esc } from './util.js';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function duration(seconds) {
  if (seconds < 60) return seconds ? '<1 min' : '0 min';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (!h) return `${m} min`;
  return m ? `${h}h ${m}min` : `${h}h`;
}

function streaks(days) {
  const has = (d) => (days[dayKey(d)] || {}).pages > 0;
  const cursor = new Date();
  if (!has(cursor)) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (has(cursor)) { current++; cursor.setDate(cursor.getDate() - 1); }
  const keys = Object.keys(days).filter((k) => days[k].pages > 0).sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const k of keys) {
    const d = new Date(`${k}T12:00:00`);
    run = prev && Math.round((d - prev) / 86400000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best: Math.max(best, current) };
}

function tile(label, value, sub, color) {
  return `<div class="tile tile-${color}"><span class="tile-label">${esc(label)}</span><strong>${esc(value)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
}

function badge(a) {
  const pct = Math.min(100, Math.round((a.value / a.goal) * 100));
  const on = a.value >= a.goal;
  return `<div class="badge${on ? ' on' : ''}" title="${esc(a.desc)}">
    <div class="burst-wrap"><div class="badge-burst">${on ? '<svg class="ic"><use href="#i-trophy"/></svg>' : `${pct}%`}</div></div>
    <strong>${esc(a.name)}</strong>
    <small>${esc(a.desc)}</small>
    <div class="badge-bar"><i style="width:${pct}%"></i></div>
    <small class="badge-count">${Math.min(a.value, a.goal)} / ${a.goal}</small>
  </div>`;
}

export async function renderStats() {
  const view = document.getElementById('stats-view');
  view.innerHTML = '<div class="empty"><div class="burst-wrap"><div class="burst">Calculando!</div></div></div>';
  let data;
  try {
    data = await api.get('stats');
  } catch (e) {
    view.innerHTML = `<div class="empty"><h2>Não consegui carregar</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  const days = obj(data.days);
  const finished = obj(data.finished);
  const list = Object.values(days);
  const todayData = days[dayKey(new Date())] || {};
  const totalPages = list.reduce((s, d) => s + (d.pages || 0), 0);
  const totalSeconds = list.reduce((s, d) => s + (d.seconds || 0), 0);
  const chaptersInDays = list.reduce((s, d) => s + (d.chapters || 0), 0);
  const night = list.reduce((s, d) => s + (d.night || 0), 0);
  const maxChaptersDay = list.reduce((m, d) => Math.max(m, d.chapters || 0), 0);
  const doneByProgress = Object.keys(state.progress).filter((p) => statusOf(p) === 'done').length;
  const done = Math.max(Object.keys(finished).length, doneByProgress);
  const reading = Object.keys(state.progress).filter((p) => statusOf(p) === 'reading').length;
  const { current, best } = streaks(days);
  const avg = chaptersInDays ? totalSeconds / chaptersInDays : 0;
  const favorites = state.collections.favorites.length;
  const collections = Object.keys(state.collections.collections).length;

  const bars = [];
  let peak = 1;
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const entry = days[dayKey(d)] || {};
    peak = Math.max(peak, entry.pages || 0);
    bars.push({ d, pages: entry.pages || 0, today: i === 0 });
  }
  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  const achievements = [
    { name: 'Primeira HQ', desc: 'Termine sua primeira HQ', value: done, goal: 1 },
    { name: 'Leitor Voraz', desc: 'Termine 10 HQs', value: done, goal: 10 },
    { name: 'Colecionador', desc: 'Termine 50 HQs', value: done, goal: 50 },
    { name: 'Lenda Viva', desc: 'Termine 100 HQs', value: done, goal: 100 },
    { name: 'Mil Páginas', desc: 'Leia 1.000 páginas', value: totalPages, goal: 1000 },
    { name: 'Dez Mil!', desc: 'Leia 10.000 páginas', value: totalPages, goal: 10000 },
    { name: 'Semana Heroica', desc: 'Leia 7 dias seguidos', value: best, goal: 7 },
    { name: 'Mês Lendário', desc: 'Leia 30 dias seguidos', value: best, goal: 30 },
    { name: 'Maratonista', desc: 'Termine 5 capítulos no mesmo dia', value: maxChaptersDay, goal: 5 },
    { name: 'Coruja', desc: 'Leia 50 páginas entre meia-noite e 5h', value: night, goal: 50 },
    { name: 'Curador', desc: 'Crie uma coleção', value: collections, goal: 1 },
    { name: 'Fã Número 1', desc: 'Tenha 10 favoritos', value: favorites, goal: 10 }
  ];
  const unlocked = achievements.filter((a) => a.value >= a.goal).length;

  view.innerHTML = `
    <div class="stats-head"><h2 class="caption caption-red">Suas estatísticas</h2><a class="more" href="#/">‹ Estante</a></div>
    <div class="tiles">
      ${tile('Páginas hoje', String(todayData.pages || 0), duration(todayData.seconds || 0) + ' lendo', 'yellow')}
      ${tile('Sequência', `${current} ${current === 1 ? 'dia' : 'dias'}`, `Recorde: ${best}`, 'red')}
      ${tile('Páginas lidas', totalPages.toLocaleString('pt-BR'), 'no total', 'blue')}
      ${tile('HQs concluídas', String(done), `${reading} em andamento`, 'green')}
      ${tile('Tempo lendo', duration(totalSeconds), 'no total', 'pink')}
      ${tile('Média por capítulo', avg ? duration(Math.round(avg)) : '—', chaptersInDays ? `${chaptersInDays} capítulos medidos` : 'termine um capítulo', 'purple')}
    </div>
    <section class="stats-block">
      <h3 class="caption caption-blue">Últimos 30 dias</h3>
      <div class="bars" role="img" aria-label="Páginas lidas por dia nos últimos 30 dias">
        ${bars.map((b) => `<div class="bar-col${b.today ? ' today' : ''}" title="${b.d.getDate()} de ${months[b.d.getMonth()]}: ${b.pages} páginas">
          <span class="bar-val">${b.pages || ''}</span>
          <i style="height:${Math.round((b.pages / peak) * 100)}%"></i>
          <span class="bar-day">${b.today ? 'hoje' : b.d.getDate() % 5 === 0 ? b.d.getDate() : ''}</span>
        </div>`).join('')}
      </div>
    </section>
    <section class="stats-block">
      <h3 class="caption caption-pink">Conquistas · ${unlocked}/${achievements.length}</h3>
      <div class="badges">${achievements.map(badge).join('')}</div>
    </section>`;
}

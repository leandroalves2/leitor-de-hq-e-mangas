import { $ } from './util.js';

const mq = window.matchMedia('(max-width: 760px)');

function syncActive() {
  const stats = location.hash.startsWith('#/stats');
  $('#tab-stats').classList.toggle('on', stats);
  $('#tab-home').classList.toggle('on', !stats);
}

function placeModes() {
  const modes = $('#r-modes');
  const bottom = $('.r-bottom');
  const tools = $('.r-tools');
  if (!modes || !bottom || !tools) return;
  if (mq.matches) {
    if (modes.parentElement !== bottom) bottom.insertBefore(modes, $('.r-slider'));
  } else if (modes.parentElement !== tools) {
    tools.insertBefore(modes, tools.firstChild);
  }
}

export function initMobile() {
  const more = $('#more-modal');
  const actions = { refresh: '#btn-refresh', settings: '#btn-settings', theme: '#btn-theme' };
  $('#tab-drive').addEventListener('click', () => $('#btn-drive').click());
  $('#tab-add').addEventListener('click', () => $('#pick-files').click());
  $('#tab-more').addEventListener('click', () => { more.hidden = false; });
  more.addEventListener('click', (e) => {
    if (e.target === more || e.target.closest('[data-close]')) {
      more.hidden = true;
      return;
    }
    const item = e.target.closest('[data-more]');
    if (!item) return;
    more.hidden = true;
    $(actions[item.dataset.more]).click();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !more.hidden) more.hidden = true; });
  const source = $('#drive-badge');
  const badge = $('#tab-badge');
  const syncBadge = () => {
    badge.hidden = source.hidden;
    badge.textContent = source.textContent;
  };
  new MutationObserver(syncBadge).observe(source, { attributes: true, childList: true, characterData: true, subtree: true });
  syncBadge();
  window.addEventListener('hashchange', syncActive);
  syncActive();
  mq.addEventListener('change', placeModes);
  placeModes();
}

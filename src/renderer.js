const HOMES = {
  gmail: 'https://mail.google.com/mail/u/0/#inbox',
  calendar: 'https://calendar.google.com/calendar/u/0/r/day',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const work = $('#work');
const address = $('#address');
let config;
let lineUrl = null;

// ---------- 作業スペース ----------

function toUrl(input) {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

function openInWork(url) {
  // webview の準備前は loadURL が例外になるため src で読み込む
  try {
    work.loadURL(url).catch(() => {});
  } catch {
    work.src = url;
  }
}

$('#address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = toUrl(address.value);
  if (url) openInWork(url);
  address.blur();
});

const syncAddress = (e) => {
  if (document.activeElement !== address) address.value = e.url;
};
work.addEventListener('did-navigate', syncAddress);
work.addEventListener('did-navigate-in-page', (e) => e.isMainFrame && syncAddress(e));
work.addEventListener('did-start-loading', () => $('#work-progress').classList.remove('hidden'));
work.addEventListener('did-stop-loading', () => $('#work-progress').classList.add('hidden'));

$('#set-home').addEventListener('click', async () => {
  config = await window.workspace.setConfig({ workHome: work.getURL() });
  flash($('#set-home'));
});

$('#open-external').addEventListener('click', () => window.workspace.openExternal(work.getURL()));

window.workspace.onOpenInWork(openInWork);

// ---------- 各ペインの共通ボタン ----------

function homeOf(paneName) {
  if (paneName === 'work') return config.workHome;
  if (paneName === 'line') return lineUrl;
  return HOMES[paneName];
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const pane = btn.closest('[data-pane]');
  const view = $('webview', pane);
  if (!view) return;
  switch (btn.dataset.action) {
    case 'back':
      if (view.canGoBack()) view.goBack();
      break;
    case 'forward':
      if (view.canGoForward()) view.goForward();
      break;
    case 'reload':
      view.reload();
      break;
    case 'home':
      view.loadURL(homeOf(pane.dataset.pane));
      break;
    case 'to-work':
      openInWork(view.getURL());
      break;
  }
});

// タイトルに含まれる「(3)」などの件数を未読バッジとして表示
function watchBadge(pane) {
  const view = $('webview', pane);
  const badge = $('[data-badge]', pane);
  if (!view || !badge) return;
  view.addEventListener('page-title-updated', (e) => {
    const m = e.title.match(/\((\d+)\)/);
    badge.textContent = m ? m[1] : '';
    badge.classList.toggle('hidden', !m);
  });
}

function flash(el) {
  el.classList.add('text-amber-400');
  setTimeout(() => el.classList.remove('text-amber-400'), 800);
}

// ---------- LINE ----------

async function setupLine() {
  const body = $('#line-body');
  body.replaceChildren();
  lineUrl = await window.workspace.loadLine();

  if (lineUrl) {
    const view = document.createElement('webview');
    view.setAttribute('partition', 'persist:workspace');
    view.setAttribute('allowpopups', '');
    view.src = lineUrl;
    body.append(view);
    watchBadge($('[data-pane="line"]'));
    return;
  }

  body.append($('#line-fallback').content.cloneNode(true));
  $('[data-line="choose"]', body).addEventListener('click', chooseLineFolder);
  $('[data-line="desktop"]', body).addEventListener('click', () => window.workspace.openLineDesktop());
}

async function chooseLineFolder() {
  if (await window.workspace.chooseLineFolder()) setupLine();
}

$('#line-settings').addEventListener('click', chooseLineFolder);

// ---------- ペインのサイズ変更 ----------

const left = $('#left');
const rows = $$('section.pane', left);
const shield = $('#drag-shield');

function applyLayout() {
  left.style.width = `${config.leftWidth}px`;
  rows.forEach((row, i) => {
    row.style.flex = `${config.rowRatios[i]} 1 0`;
  });
}

function startDrag(cursor, onMove, onEnd) {
  shield.style.cursor = cursor;
  shield.classList.remove('hidden');
  const move = (e) => onMove(e);
  const up = () => {
    shield.classList.add('hidden');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    onEnd();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

const saveLayout = () => window.workspace.setConfig({ leftWidth: config.leftWidth, rowRatios: config.rowRatios });

$('#gutter-x').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = left.getBoundingClientRect().width;
  startDrag('col-resize', (ev) => {
    const max = window.innerWidth * 0.6;
    config.leftWidth = Math.round(Math.min(max, Math.max(280, startWidth + ev.clientX - startX)));
    applyLayout();
  }, saveLayout);
});

$$('[data-gutter]', left).forEach((gutter) => {
  gutter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const i = Number(gutter.dataset.gutter);
    const startY = e.clientY;
    const heights = rows.map((r) => r.getBoundingClientRect().height);
    const pair = heights[i] + heights[i + 1];
    startDrag('row-resize', (ev) => {
      const top = Math.min(pair - 80, Math.max(80, heights[i] + ev.clientY - startY));
      const next = heights.slice();
      next[i] = top;
      next[i + 1] = pair - top;
      const total = next.reduce((a, b) => a + b, 0);
      config.rowRatios = next.map((h) => +(h / total * 3).toFixed(3));
      applyLayout();
    }, saveLayout);
  });
});

// ---------- 起動 ----------

(async () => {
  config = await window.workspace.getConfig();
  applyLayout();
  rows.forEach(watchBadge);
  openInWork(config.workHome);
  setupLine();
})();

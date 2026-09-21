/* ===========================================================================
   Albany Data Systems — Command Center (frontend)
   Reads state from /api/state, renders the board, and lets a local editor
   drive the same API an AI Chief of Staff would use.
   =========================================================================== */

const STATUS_EMOJI = { green: '🟢', yellow: '🟡', red: '🔴', purple: '🟣' };
const REFRESH_MS = 5000;

let state = null;
let lastGood = 0;

// ---------- clock (updates locally every second) ----------
function tick() {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  document.getElementById('date').textContent = date;
  document.getElementById('time').textContent = time;
}
setInterval(tick, 1000);
tick();

// ---------- fetch + render loop ----------
async function refresh() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (res.status === 401) {
      show('lock');
      setConn(false);
      return;
    }
    if (!res.ok) throw new Error('bad response');
    hide('lock');
    state = await res.json();
    lastGood = Date.now();
    render();
    setConn(true);
  } catch (e) {
    setConn(false);
  }
}

// Lock screen: hand the token to /unlock, which sets a cookie and reloads.
function initLock() {
  const go = () => {
    const t = document.getElementById('lock-token').value.trim();
    if (t) window.location = '/unlock?token=' + encodeURIComponent(t);
  };
  document.getElementById('lock-go').addEventListener('click', go);
  document.getElementById('lock-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
  // If we were bounced back to "/" still locked, the token was wrong.
  if (new URLSearchParams(location.search).get('bad') === '1') {
    document.getElementById('lock-err').hidden = false;
  }
}
initLock();

function setConn(ok) {
  const conn = document.getElementById('conn');
  if (ok) {
    conn.classList.remove('stale');
    conn.firstChild.nextSibling ? null : null;
    conn.childNodes[1] && (conn.childNodes[1].textContent = ' Live');
  } else if (Date.now() - lastGood > REFRESH_MS * 2.5) {
    conn.classList.add('stale');
    conn.childNodes[1] && (conn.childNodes[1].textContent = ' Reconnecting…');
  }
}

function render() {
  if (!state) return;
  document.getElementById('org').textContent = state.org || 'ALBANY DATA SYSTEMS';

  // Overall banner
  const overall = state.overall || { status: 'green', message: '' };
  const light = document.getElementById('overall-light');
  light.className = 'overall-light s-' + overall.status;
  document.getElementById('overall-message').textContent = overall.message || '';

  renderBoard();
  renderFocus();
  renderWeek();
  document.getElementById('reassurance').textContent = state.reassurance || '';
}

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  for (const cat of state.categories) {
    const attention = cat.status === 'yellow' || cat.status === 'red';
    const card = document.createElement('div');
    card.className = `card status-color-${cat.status}` + (attention ? ' attention' : '');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${cat.label}: ${cat.summary}`);

    const itemCount = cat.items ? cat.items.length : 0;
    card.innerHTML = `
      <span class="card-light"></span>
      <span class="card-label">${escapeHtml(cat.label)}</span>
      <span class="card-summary">${escapeHtml(cat.summary || '')}</span>
      ${itemCount ? `<span class="card-count">${itemCount} ${itemCount === 1 ? 'detail' : 'details'}</span>` : ''}
      <span class="card-chevron">›</span>
    `;
    card.addEventListener('click', () => openPanel(cat));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(cat); }
    });
    board.appendChild(card);
  }
}

function renderFocus() {
  const list = document.getElementById('focus-list');
  list.innerHTML = '';
  const focus = state.focus || [];
  if (!focus.length) {
    list.innerHTML = '<li class="detail-empty">No priorities set.</li>';
    return;
  }
  focus.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'focus-item';
    li.innerHTML = `
      <span class="focus-num">${i + 1}</span>
      <div class="focus-body">
        <div class="focus-title">${escapeHtml(f.title)}</div>
        ${f.detail ? `<div class="focus-detail">${escapeHtml(f.detail)}</div>` : ''}
      </div>
    `;
    list.appendChild(li);
  });
}

function renderWeek() {
  const list = document.getElementById('week-list');
  list.innerHTML = '';
  const week = state.week || [];
  if (!week.length) {
    list.innerHTML = '<li class="week-empty">No tasks for the week.</li>';
    return;
  }
  for (const task of week) {
    const li = document.createElement('li');
    li.className = 'week-task status-color-' + task.status + (task.done ? ' done' : '');
    li.title = task.done ? 'Click to mark not done' : 'Click to mark complete';
    li.innerHTML = `
      <span class="week-dot"></span>
      <div class="week-text">
        <div class="week-title">${escapeHtml(task.title)}</div>
        ${task.meta ? `<div class="week-meta">${escapeHtml(task.meta)}</div>` : ''}
      </div>
    `;
    // Click a task to toggle completion (uses the same API an AI would).
    li.addEventListener('click', () => {
      patch(`/api/week/${task.id}`, { done: !task.done }).then(() => refresh());
    });
    list.appendChild(li);
  }
}

// ---------- expand panel ----------
function openPanel(cat) {
  document.getElementById('panel-title').textContent = cat.label;
  document.getElementById('panel-summary').textContent = cat.summary || '';
  const light = document.getElementById('panel-light');
  light.style.setProperty('--dotcolor', `var(--${cat.status})`);
  light.style.setProperty('--dotglow', `var(--${cat.status}-glow)`);

  const container = document.getElementById('panel-items');
  container.innerHTML = '';
  const items = cat.items || [];
  if (!items.length) {
    container.innerHTML = '<div class="detail-empty">Nothing to show — this category is clear.</div>';
  } else {
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'detail-item';
      row.style.setProperty('--dotcolor', `var(--${item.status})`);
      row.style.setProperty('--dotglow', `var(--${item.status}-glow)`);
      row.innerHTML = `
        <span class="detail-dot"></span>
        <div class="detail-text">
          <div class="detail-main">${escapeHtml(item.text)}</div>
          ${item.note ? `<div class="detail-note">${escapeHtml(item.note)}</div>` : ''}
        </div>
      `;
      container.appendChild(row);
    }
  }
  show('overlay');
}

// ---------- editor (local dev) ----------
function openEditor() {
  renderEditor();
  show('editor');
}

function renderEditor() {
  // Categories
  const cats = document.getElementById('editor-categories');
  cats.innerHTML = '';
  for (const cat of state.categories) {
    const row = document.createElement('div');
    row.className = 'editor-cat-row';
    const picker = ['green', 'yellow', 'red', 'purple'].map((s) =>
      `<span class="status-swatch ${s} ${cat.status === s ? 'active' : ''}" data-cat="${cat.id}" data-status="${s}" title="${s}"></span>`
    ).join('');
    row.innerHTML = `
      <span class="cat-name">${escapeHtml(cat.label)}</span>
      <span class="status-picker">${picker}</span>
      <input type="text" value="${escapeAttr(cat.summary || '')}" data-summary="${cat.id}" placeholder="Summary…" />
    `;
    cats.appendChild(row);
  }
  cats.querySelectorAll('.status-swatch').forEach((sw) => {
    sw.addEventListener('click', () =>
      patch(`/api/categories/${sw.dataset.cat}`, { status: sw.dataset.status }).then(afterEdit)
    );
  });
  cats.querySelectorAll('input[data-summary]').forEach((inp) => {
    inp.addEventListener('change', () =>
      patch(`/api/categories/${inp.dataset.summary}`, { summary: inp.value }).then(afterEdit)
    );
  });

  // Focus
  const focusBox = document.getElementById('editor-focus');
  focusBox.innerHTML = '';
  (state.focus || []).forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'editor-focus-row';
    row.innerHTML = `
      <span class="focus-num" style="min-width:26px;font-size:18px;">${i + 1}</span>
      <span class="ef-title">${escapeHtml(f.title)}</span>
      <span class="ef-detail">${escapeHtml(f.detail || '')}</span>
      <span class="ef-btns">
        ${i > 0 ? `<button class="btn btn-ghost" data-up="${f.id}">↑</button>` : ''}
        <button class="btn btn-danger" data-del="${f.id}">Remove</button>
      </span>
    `;
    focusBox.appendChild(row);
  });
  focusBox.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => del(`/api/focus/${b.dataset.del}`).then(afterEdit))
  );
  focusBox.querySelectorAll('[data-up]').forEach((b) =>
    b.addEventListener('click', () =>
      patch(`/api/focus/${b.dataset.up}`, { position: 'top' }).then(afterEdit)
    )
  );

  // This Week
  const weekBox = document.getElementById('editor-week');
  weekBox.innerHTML = '';
  (state.week || []).forEach((t) => {
    const row = document.createElement('div');
    row.className = 'editor-focus-row';
    const picker = ['green', 'yellow', 'red', 'purple'].map((s) =>
      `<span class="status-swatch ${s} ${t.status === s ? 'active' : ''}" data-week="${t.id}" data-status="${s}" title="${s}"></span>`
    ).join('');
    row.innerHTML = `
      <span class="ef-title">${escapeHtml(t.title)}${t.done ? ' ✓' : ''}</span>
      <span class="ef-detail">${escapeHtml(t.meta || '')}</span>
      <span class="status-picker">${picker}</span>
      <span class="ef-btns">
        <button class="btn btn-danger" data-week-del="${t.id}">Remove</button>
      </span>
    `;
    weekBox.appendChild(row);
  });
  weekBox.querySelectorAll('.status-swatch[data-week]').forEach((sw) =>
    sw.addEventListener('click', () =>
      patch(`/api/week/${sw.dataset.week}`, { status: sw.dataset.status }).then(afterEdit)
    )
  );
  weekBox.querySelectorAll('[data-week-del]').forEach((b) =>
    b.addEventListener('click', () => del(`/api/week/${b.dataset.weekDel}`).then(afterEdit))
  );

  document.getElementById('reassurance-input').value = state.reassurance || '';
}

function afterEdit() {
  return refresh().then(() => renderEditor());
}

// ---------- API helpers ----------
async function patch(url, body) {
  return fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function del(url) {
  return fetch(url, { method: 'DELETE' });
}

// ---------- overlay show/hide ----------
function show(id) { document.getElementById(id).hidden = false; }
function hide(id) { document.getElementById(id).hidden = true; }

document.getElementById('panel-close').addEventListener('click', () => hide('overlay'));
document.getElementById('overlay').addEventListener('click', (e) => {
  if (e.target.id === 'overlay') hide('overlay');
});
document.getElementById('editor-close').addEventListener('click', () => hide('editor'));
document.getElementById('editor').addEventListener('click', (e) => {
  if (e.target.id === 'editor') hide('editor');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hide('overlay'); hide('editor'); }
});

document.getElementById('edit-toggle').addEventListener('click', openEditor);

document.getElementById('add-focus').addEventListener('click', () => {
  const title = document.getElementById('new-focus-title').value.trim();
  const detail = document.getElementById('new-focus-detail').value.trim();
  if (!title) return;
  post('/api/focus', { title, detail }).then(() => {
    document.getElementById('new-focus-title').value = '';
    document.getElementById('new-focus-detail').value = '';
    afterEdit();
  });
});

document.getElementById('add-week').addEventListener('click', () => {
  const title = document.getElementById('new-week-title').value.trim();
  const meta = document.getElementById('new-week-meta').value.trim();
  if (!title) return;
  post('/api/week', { title, meta, status: 'green' }).then(() => {
    document.getElementById('new-week-title').value = '';
    document.getElementById('new-week-meta').value = '';
    afterEdit();
  });
});

document.getElementById('save-reassurance').addEventListener('click', () => {
  const text = document.getElementById('reassurance-input').value;
  patch('/api/reassurance', { text }).then(afterEdit);
});

// ---------- utils ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- go ----------
refresh();
setInterval(refresh, REFRESH_MS);

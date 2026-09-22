/* ===========================================================================
   Albany Data Systems — Command Center (frontend)
   Reads state from /api/state, renders the board, and lets a local editor
   drive the same API an AI Chief of Staff would use.
   =========================================================================== */

const STATUS_EMOJI = { green: '🟢', yellow: '🟡', red: '🔴', purple: '🟣' };
const REFRESH_MS = 5000;

let state = null;
let lastGood = 0;
let paused = false;      // true while inline-editing, so refresh won't wipe the form
let lastSig = '';        // signature of last rendered state (skip needless re-renders)
const expandedCards = new Set(); // category ids currently folded open
let currentWeekTask = null;      // the week task open in the modal (null = new)
let weekModalStatus = 'green';   // status selected in the modal
let currentProject = null;       // the project open in the modal (null = new)
let projectModalStatus = 'purple';
let projectModalGroup = 'long-term';

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
async function refresh(force) {
  if (paused && !force) return; // don't rebuild the DOM under an open edit form
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (res.status === 401) {
      show('lock');
      setConn(false);
      return;
    }
    if (!res.ok) throw new Error('bad response');
    hide('lock');
    const data = await res.json();
    lastGood = Date.now();
    setConn(true);
    // Only re-render when something actually changed, so expanded cards and
    // hovered controls don't flicker every 5 seconds.
    const sig = JSON.stringify(data);
    if (sig === lastSig && !force) return;
    lastSig = sig;
    state = data;
    render();
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
  renderProjects();
  document.getElementById('reassurance').textContent = state.reassurance || '';
  const n = state.completedCount || 0;
  document.getElementById('completed-link').textContent =
    n ? `Completed tasks (${n}) →` : 'Completed tasks →';
}

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  for (const cat of state.categories) {
    const attention = cat.status === 'yellow' || cat.status === 'red';
    const isOpen = expandedCards.has(cat.id);
    const card = document.createElement('div');
    card.className = `card status-color-${cat.status}` + (attention ? ' attention' : '') + (isOpen ? ' expanded' : '');

    const itemCount = cat.items ? cat.items.length : 0;
    card.innerHTML = `
      <div class="card-row" role="button" tabindex="0" aria-expanded="${isOpen}" aria-label="${escapeAttr(cat.label + ': ' + (cat.summary || ''))}">
        <span class="card-light"></span>
        <span class="card-label">${escapeHtml(cat.label)}</span>
        <span class="card-summary">${escapeHtml(cat.summary || '')}</span>
        ${itemCount ? `<span class="card-count">${itemCount} ${itemCount === 1 ? 'detail' : 'details'}</span>` : ''}
        <span class="card-chevron">›</span>
      </div>
      <div class="card-detail"><div class="card-detail-inner">${detailItemsHtml(cat)}</div></div>
    `;
    const row = card.querySelector('.card-row');
    const toggle = () => toggleCard(cat.id, card);
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    // Wire the task actions (edit / save / cancel / done) inside the fold-out.
    card.querySelector('.card-detail').addEventListener('click', (e) => handleDetailClick(e, cat));
    board.appendChild(card);
  }
}

function detailItemsHtml(cat) {
  const items = cat.items || [];
  const rows = items.length
    ? items.map((item) => `
        <div class="detail-item" data-item-id="${item.id}" style="--dotcolor: var(--${item.status}); --dotglow: var(--${item.status}-glow);">
          <span class="detail-dot"></span>
          <div class="detail-text">
            <div class="detail-main">${escapeHtml(item.text)}</div>
            ${item.note ? `<div class="detail-note">${escapeHtml(item.note)}</div>` : ''}
            ${item.projectId ? `<div class="detail-tags">${projectTagHtml(item.projectId)}</div>` : ''}
            ${addedMetaHtml(item)}
          </div>
          <div class="detail-actions">
            <button class="mini-btn" data-action="edit" title="Edit task and note">✎</button>
            <button class="mini-btn mini-done" data-action="done" title="Mark done">✓</button>
          </div>
        </div>`).join('')
    : '<div class="detail-empty">Nothing here — this category is clear.</div>';
  return rows + `
    <div class="detail-add">
      <button class="mini-btn add-task" data-action="add-task">+ Add task</button>
    </div>
  `;
}

function handleDetailClick(e, cat) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  // Add-task actions live outside any .detail-item.
  if (action === 'add-task') return enterAddTask(cat, btn.closest('.detail-add'));
  if (action === 'add-save') return saveAddTask(cat, btn.closest('.detail-add'));
  if (action === 'add-cancel') { paused = false; return refresh(true); }

  const itemEl = btn.closest('.detail-item');
  if (!itemEl) return;
  const itemId = itemEl.dataset.itemId;
  if (action === 'done') completeItem(cat, itemId);
  else if (action === 'edit') enterItemEdit(cat, itemId, itemEl);
  else if (action === 'save') saveItemEdit(cat, itemId, itemEl);
  else if (action === 'cancel') { paused = false; refresh(true); }
}

function enterAddTask(cat, addEl) {
  paused = true;
  addEl.classList.add('adding');
  addEl.innerHTML = `
    <input class="add-text edit-text" type="text" placeholder="New task…" />
    <textarea class="add-note edit-note" rows="2" placeholder="Note (optional)…"></textarea>
    <select class="add-project edit-project">${projectOptionsHtml('')}</select>
    <div class="edit-actions">
      <button class="mini-btn save" data-action="add-save">Add</button>
      <button class="mini-btn" data-action="add-cancel">Cancel</button>
    </div>
  `;
  const text = addEl.querySelector('.add-text');
  addEl.querySelectorAll('.add-text, .add-note').forEach((el) => {
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && el.classList.contains('add-text')) {
        ev.preventDefault();
        saveAddTask(cat, addEl);
      } else if (ev.key === 'Escape') {
        ev.stopPropagation();
        paused = false;
        refresh(true);
      }
    });
  });
  text.focus();
}

function saveAddTask(cat, addEl) {
  const textEl = addEl.querySelector('.add-text');
  const text = textEl.value.trim();
  const note = addEl.querySelector('.add-note').value.trim();
  const projectId = addEl.querySelector('.add-project').value;
  if (!text) { textEl.focus(); return; }
  paused = false;
  post(`/api/categories/${cat.id}/items`, { text, note, projectId, status: 'green', createdBy: 'Ben' }).then(() => refresh(true));
}

function completeItem(cat, itemId) {
  post(`/api/categories/${cat.id}/items/${itemId}/complete`, {}).then(() => refresh(true));
}

function enterItemEdit(cat, itemId, itemEl) {
  const item = (cat.items || []).find((i) => i.id === itemId);
  if (!item) return;
  paused = true; // freeze auto-refresh so the form isn't rebuilt under us
  itemEl.classList.add('editing');
  itemEl.innerHTML = `
    <span class="detail-dot"></span>
    <div class="detail-text">
      <input class="edit-text" type="text" value="${escapeAttr(item.text)}" />
      <textarea class="edit-note" rows="2" placeholder="Add a note…">${escapeHtml(item.note || '')}</textarea>
      <select class="edit-project">${projectOptionsHtml(item.projectId || '')}</select>
      <div class="edit-actions">
        <button class="mini-btn save" data-action="save">Save</button>
        <button class="mini-btn" data-action="cancel">Cancel</button>
      </div>
    </div>
  `;
  const text = itemEl.querySelector('.edit-text');
  itemEl.querySelectorAll('.edit-text, .edit-note').forEach((el) => {
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && el.classList.contains('edit-text')) {
        ev.preventDefault();
        saveItemEdit(cat, itemId, itemEl);
      } else if (ev.key === 'Escape') {
        ev.stopPropagation();
        paused = false;
        refresh(true);
      }
    });
  });
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
}

function saveItemEdit(cat, itemId, itemEl) {
  const textEl = itemEl.querySelector('.edit-text');
  const text = textEl.value.trim();
  const note = itemEl.querySelector('.edit-note').value.trim();
  const projectId = itemEl.querySelector('.edit-project').value;
  if (!text) { textEl.focus(); return; }
  paused = false;
  patch(`/api/categories/${cat.id}/items/${itemId}`, { text, note, projectId }).then(() => refresh(true));
}

function toggleCard(id, card) {
  if (expandedCards.has(id)) {
    expandedCards.delete(id);
    card.classList.remove('expanded');
    card.querySelector('.card-row').setAttribute('aria-expanded', 'false');
  } else {
    expandedCards.add(id);
    card.classList.add('expanded');
    card.querySelector('.card-row').setAttribute('aria-expanded', 'true');
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
    li.className = 'week-task status-color-' + task.status;
    li.title = 'Click to open';
    li.innerHTML = `
      <span class="week-dot"></span>
      <div class="week-text">
        <div class="week-title">${escapeHtml(task.title)}</div>
        ${task.meta ? `<div class="week-meta">${escapeHtml(task.meta)}</div>` : ''}
        ${task.projectId ? `<div class="week-tag">${projectTagHtml(task.projectId)}</div>` : ''}
        ${addedMetaHtml(task)}
      </div>
    `;
    // Click a task to open its detail modal (does NOT complete it).
    li.addEventListener('click', () => openWeekModal(task));
    list.appendChild(li);
  }
}

// ---------- weekly task modal ----------
function openWeekModal(task) {
  currentWeekTask = task; // null = creating a new one
  weekModalStatus = task ? task.status : 'green';
  document.getElementById('wm-heading').textContent = task ? 'Weekly task' : 'New weekly task';
  document.getElementById('wm-title').value = task ? task.title : '';
  document.getElementById('wm-meta').value = task ? (task.meta || '') : '';
  document.getElementById('wm-note').value = task ? (task.note || '') : '';
  document.getElementById('wm-project').innerHTML = projectOptionsHtml(task ? (task.projectId || '') : '');
  document.getElementById('wm-added').innerHTML = task ? addedMetaHtml(task) : '';
  document.getElementById('wm-complete').style.display = task ? '' : 'none';
  document.getElementById('wm-delete').style.display = task ? '' : 'none';
  renderWeekStatusPicker();
  paused = true; // don't let auto-refresh rebuild while the modal is open
  show('week-modal');
  document.getElementById('wm-title').focus();
}

function renderWeekStatusPicker() {
  const picker = document.getElementById('wm-status-picker');
  picker.innerHTML = ['green', 'yellow', 'red', 'purple'].map((s) =>
    `<span class="status-swatch ${s} ${weekModalStatus === s ? 'active' : ''}" data-status="${s}" title="${s}"></span>`
  ).join('');
  picker.querySelectorAll('.status-swatch').forEach((sw) =>
    sw.addEventListener('click', () => {
      weekModalStatus = sw.dataset.status;
      renderWeekStatusPicker();
    })
  );
  const dot = document.getElementById('wm-status-dot');
  dot.style.setProperty('--dotcolor', `var(--${weekModalStatus})`);
  dot.style.setProperty('--dotglow', `var(--${weekModalStatus}-glow)`);
}

function closeWeekModal() {
  paused = false;
  hide('week-modal');
  refresh(true);
}

const STATUS_CYCLE = ['green', 'yellow', 'red', 'purple'];

// Count open tasks (category items + weekly tasks) linked to each project.
function projectTaskCounts() {
  const counts = {};
  for (const cat of (state.categories || [])) {
    for (const it of (cat.items || [])) {
      if (it.projectId) counts[it.projectId] = (counts[it.projectId] || 0) + 1;
    }
  }
  for (const t of (state.week || [])) {
    if (t.projectId) counts[t.projectId] = (counts[t.projectId] || 0) + 1;
  }
  return counts;
}

function projectById(id) {
  return (state.projects || []).find((p) => p.id === id);
}
function projectTagHtml(id) {
  const p = id && projectById(id);
  return p ? `<span class="proj-tag">${escapeHtml(p.name)}</span>` : '';
}
function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function addedMetaHtml(o) {
  if (!o || (!o.createdBy && !o.createdAt)) return '';
  const who = o.createdBy ? escapeHtml(o.createdBy) : '—';
  const when = formatWhen(o.createdAt);
  return `<div class="added-meta">Added by ${who}${when ? ' · ' + when : ''}</div>`;
}

function projectOptionsHtml(selectedId) {
  const opts = [`<option value="">— No project —</option>`];
  for (const p of (state.projects || [])) {
    opts.push(`<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`);
  }
  return opts.join('');
}

function renderProjects() {
  const counts = projectTaskCounts();
  const fill = (elId, group) => {
    const el = document.getElementById(elId);
    el.innerHTML = '';
    const list = (state.projects || [])
      .filter((p) => (p.group || 'long-term') === group)
      .sort((a, b) => a.order - b.order);
    if (!list.length) { el.innerHTML = '<div class="project-empty">None yet</div>'; return; }
    for (const p of list) {
      const n = counts[p.id] || 0;
      const box = document.createElement('div');
      box.className = 'project-box status-color-' + p.status;
      box.title = 'Click to open';
      box.innerHTML = `
        ${p.logo
          ? `<img class="project-logo" src="${escapeAttr(p.logo)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'project-dot'}))" />`
          : '<span class="project-dot"></span>'}
        <span class="project-name">${escapeHtml(p.name)}</span>
        ${n ? `<span class="project-badge" title="${n} open task${n === 1 ? '' : 's'}">${n}</span>`
            : '<span class="project-status-dot"></span>'}
      `;
      box.addEventListener('click', () => openProjectModal(p));
      el.appendChild(box);
    }
  };
  fill('projects-immediate', 'immediate');
  fill('projects-longterm', 'long-term');
}

// ---------- project modal (large) ----------
function openProjectModal(project) {
  currentProject = project;
  projectModalStatus = project ? project.status : 'purple';
  const val = (id, v) => { document.getElementById(id).value = v; };
  document.getElementById('pm-heading') && (document.getElementById('pm-heading').textContent = '');
  val('pm-name', project ? project.name : '');
  val('pm-tagline', project ? (project.tagline || '') : '');
  val('pm-stage', project ? (project.stage || '') : '');
  val('pm-url', project ? (project.url || '') : '');
  val('pm-description', project ? (project.description || '') : '');
  val('pm-note', project ? (project.note || '') : '');
  val('pm-logo-input', project ? (project.logo || '') : '');
  updateProjectLogoPreview(project ? project.logo : '');
  projectModalGroup = project ? (project.group || 'long-term') : 'long-term';
  updateProjectGroupToggle();
  renderProjectStatusPicker();
  const open = document.getElementById('pm-open');
  if (project && project.url) { open.href = project.url; open.style.display = ''; }
  else open.style.display = 'none';
  document.getElementById('pm-delete').style.display = project ? '' : 'none';
  paused = true;
  show('project-modal');
  document.getElementById('pm-name').focus();
}

function updateProjectLogoPreview(logo) {
  const img = document.getElementById('pm-logo');
  if (logo) { img.src = logo; img.style.display = ''; }
  else img.style.display = 'none';
}

function renderProjectStatusPicker() {
  const picker = document.getElementById('pm-status-picker');
  picker.innerHTML = ['green', 'yellow', 'red', 'purple'].map((s) =>
    `<span class="status-swatch ${s} ${projectModalStatus === s ? 'active' : ''}" data-status="${s}" title="${s}"></span>`
  ).join('');
  picker.querySelectorAll('.status-swatch').forEach((sw) =>
    sw.addEventListener('click', () => {
      projectModalStatus = sw.dataset.status;
      renderProjectStatusPicker();
    })
  );
}

function updateProjectGroupToggle() {
  document.querySelectorAll('#pm-group-toggle .pm-group-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.group === projectModalGroup);
  });
}

function closeProjectModal() {
  paused = false;
  hide('project-modal');
  refresh(true);
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

  // Current Projects
  const projBox = document.getElementById('editor-projects');
  projBox.innerHTML = '';
  (state.projects || []).forEach((p) => {
    const row = document.createElement('div');
    row.className = 'editor-focus-row';
    const picker = ['green', 'yellow', 'red', 'purple'].map((s) =>
      `<span class="status-swatch ${s} ${p.status === s ? 'active' : ''}" data-proj="${p.id}" data-status="${s}" title="${s}"></span>`
    ).join('');
    row.innerHTML = `
      <span class="ef-title">${escapeHtml(p.name)}</span>
      <span class="status-picker">${picker}</span>
      <span class="ef-btns">
        <button class="btn btn-danger" data-proj-del="${p.id}">Remove</button>
      </span>
    `;
    projBox.appendChild(row);
  });
  projBox.querySelectorAll('.status-swatch[data-proj]').forEach((sw) =>
    sw.addEventListener('click', () =>
      patch(`/api/projects/${sw.dataset.proj}`, { status: sw.dataset.status }).then(afterEdit)
    )
  );
  projBox.querySelectorAll('[data-proj-del]').forEach((b) =>
    b.addEventListener('click', () => del(`/api/projects/${b.dataset.projDel}`).then(afterEdit))
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

document.getElementById('editor-close').addEventListener('click', () => hide('editor'));
document.getElementById('editor').addEventListener('click', (e) => {
  if (e.target.id === 'editor') hide('editor');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!document.getElementById('week-modal').hidden) { closeWeekModal(); return; }
    if (!document.getElementById('project-modal').hidden) { closeProjectModal(); return; }
    hide('editor');
    // Collapse any folded-open cards.
    if (expandedCards.size) {
      expandedCards.clear();
      document.querySelectorAll('.card.expanded').forEach((c) => {
        c.classList.remove('expanded');
        c.querySelector('.card-row').setAttribute('aria-expanded', 'false');
      });
    }
  }
});

document.getElementById('edit-toggle').addEventListener('click', openEditor);

// Weekly task modal wiring
document.getElementById('week-add').addEventListener('click', () => openWeekModal(null));
document.getElementById('wm-close').addEventListener('click', closeWeekModal);
document.getElementById('week-modal').addEventListener('click', (e) => {
  if (e.target.id === 'week-modal') closeWeekModal();
});
document.getElementById('wm-save').addEventListener('click', () => {
  const title = document.getElementById('wm-title').value.trim();
  const meta = document.getElementById('wm-meta').value.trim();
  const note = document.getElementById('wm-note').value.trim();
  if (!title) { document.getElementById('wm-title').focus(); return; }
  const projectId = document.getElementById('wm-project').value;
  const body = { title, meta, note, projectId, status: weekModalStatus };
  const req = currentWeekTask
    ? patch(`/api/week/${currentWeekTask.id}`, body)
    : post('/api/week', { ...body, createdBy: 'Ben' });
  req.then(closeWeekModal);
});
document.getElementById('wm-complete').addEventListener('click', () => {
  if (!currentWeekTask) return;
  post(`/api/week/${currentWeekTask.id}/complete`, {}).then(closeWeekModal);
});
document.getElementById('wm-delete').addEventListener('click', () => {
  if (!currentWeekTask) return;
  if (confirm('Delete this weekly task?')) {
    del(`/api/week/${currentWeekTask.id}`).then(closeWeekModal);
  }
});

// Project modal wiring
document.getElementById('project-add').addEventListener('click', () => openProjectModal(null));
document.querySelectorAll('#pm-group-toggle .pm-group-btn').forEach((b) => {
  b.addEventListener('click', () => { projectModalGroup = b.dataset.group; updateProjectGroupToggle(); });
});
document.getElementById('pm-close').addEventListener('click', closeProjectModal);
document.getElementById('project-modal').addEventListener('click', (e) => {
  if (e.target.id === 'project-modal') closeProjectModal();
});
document.getElementById('pm-logo-input').addEventListener('input', (e) => updateProjectLogoPreview(e.target.value.trim()));
document.getElementById('pm-save').addEventListener('click', () => {
  const name = document.getElementById('pm-name').value.trim();
  if (!name) { document.getElementById('pm-name').focus(); return; }
  const body = {
    name,
    tagline: document.getElementById('pm-tagline').value.trim(),
    stage: document.getElementById('pm-stage').value.trim(),
    url: document.getElementById('pm-url').value.trim(),
    description: document.getElementById('pm-description').value.trim(),
    note: document.getElementById('pm-note').value.trim(),
    logo: document.getElementById('pm-logo-input').value.trim(),
    group: projectModalGroup,
    status: projectModalStatus,
  };
  const req = currentProject
    ? patch(`/api/projects/${currentProject.id}`, body)
    : post('/api/projects', body);
  req.then(closeProjectModal);
});
document.getElementById('pm-delete').addEventListener('click', () => {
  if (!currentProject) return;
  if (confirm('Delete this project?')) {
    del(`/api/projects/${currentProject.id}`).then(closeProjectModal);
  }
});

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

document.getElementById('add-project').addEventListener('click', () => {
  const name = document.getElementById('new-project-name').value.trim();
  if (!name) return;
  post('/api/projects', { name }).then(() => {
    document.getElementById('new-project-name').value = '';
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

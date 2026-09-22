/* Completed tasks archive — the "holding bucket". */

const wrap = document.getElementById('completed-wrap');

async function load() {
  try {
    const res = await fetch('/api/completed', { cache: 'no-store' });
    if (res.status === 401) {
      wrap.innerHTML =
        '<p class="completed-lock">🔒 Locked. <a href="/">Open the dashboard</a> and unlock it first, then come back.</p>';
      return;
    }
    const data = await res.json();
    render(data.completed || []);
  } catch (e) {
    wrap.innerHTML = '<p class="completed-empty">Could not load completed tasks.</p>';
  }
}

function render(list) {
  if (!list.length) {
    wrap.innerHTML =
      '<p class="completed-empty">No completed tasks yet. Mark tasks done on the dashboard and they collect here.</p>';
    return;
  }
  // Group by the day they were completed (list is already newest-first).
  const groups = [];
  const byKey = {};
  for (const t of list) {
    const d = new Date(t.completedAt);
    const key = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (!byKey[key]) { byKey[key] = []; groups.push([key, byKey[key]]); }
    byKey[key].push(t);
  }
  wrap.innerHTML = groups.map(([date, items]) => `
    <div class="completed-group">
      <h2 class="completed-date">${escapeHtml(date)}</h2>
      ${items.map(itemHtml).join('')}
    </div>
  `).join('');
}

function itemHtml(t) {
  const time = new Date(t.completedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const meta = [t.categoryLabel, time].filter(Boolean).join(' · ');
  return `
    <div class="completed-item" data-id="${t.id}">
      <div class="completed-check">✓</div>
      <div class="completed-text">
        <div class="completed-main">${escapeHtml(t.text)}</div>
        ${t.note ? `<div class="completed-note">${escapeHtml(t.note)}</div>` : ''}
        <div class="completed-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="completed-actions">
        <button class="mini-btn" data-action="restore" data-id="${t.id}">Restore</button>
        <button class="mini-btn mini-danger" data-action="delete" data-id="${t.id}">Delete</button>
      </div>
    </div>
  `;
}

wrap.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'restore') {
    fetch(`/api/completed/${id}/restore`, { method: 'POST' }).then(load);
  } else if (btn.dataset.action === 'delete') {
    if (confirm('Permanently delete this completed task? This cannot be undone.')) {
      fetch(`/api/completed/${id}`, { method: 'DELETE' }).then(load);
    }
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

load();
setInterval(load, 8000);

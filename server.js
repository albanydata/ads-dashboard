/**
 * Albany Data Systems — Chief of Staff Dashboard
 * -------------------------------------------------
 * A zero-dependency Node.js server. It does two jobs:
 *
 *   1. Serves the dashboard UI (the /public folder).
 *   2. Exposes a simple, stable JSON API so an AI Chief of Staff
 *      (e.g. ChatGPT) can read and control the whole dashboard.
 *
 * State lives in data/state.json — a plain JSON file — so the
 * dashboard is really just a display surface over that document.
 *
 * Run with:  node server.js      (nothing to install)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID, timingSafeEqual } = require('crypto');

const ROOT = __dirname;

// --- Minimal .env loader (no dependencies) --------------------------------
// Lets you keep DASHBOARD_TOKEN / PORT in a .env file locally and on the server.
function loadEnv() {
  try {
    const file = path.join(ROOT, '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i === -1) continue;
      const key = s.slice(0, i).trim();
      let val = s.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) {
    /* ignore malformed .env */
  }
}
loadEnv();

const PORT = process.env.PORT || 4300;
// The shared secret. If unset, the server runs OPEN (fine for local dev only).
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');

const VALID_STATUSES = ['green', 'yellow', 'red', 'purple'];

// ---------------------------------------------------------------------------
// State store  (single JSON document, read/written atomically)
// ---------------------------------------------------------------------------

function loadState() {
  try {
    return normalizeShape(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (e) {
    // First run (or corrupt file): start from the seed.
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    saveState(seed);
    return normalizeShape(seed);
  }
}

// Guarantee the collections exist, so a state.json written by an older
// version never crashes a newer route.
function normalizeShape(state) {
  state.categories = state.categories || [];
  state.focus = state.focus || [];
  state.week = state.week || [];
  state.projects = state.projects || [];
  state.completed = state.completed || [];
  state.history = state.history || [];
  state.overall = state.overall || { override: null };
  return state;
}

function saveState(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE); // atomic-ish replace
}

function record(state, action, detail) {
  state.history = state.history || [];
  state.history.unshift({
    id: randomUUID(),
    at: new Date().toISOString(),
    action,
    detail,
  });
  state.history = state.history.slice(0, 200); // keep it bounded
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

// The overall banner is derived from the categories, unless a human/AI has
// pinned an explicit override in state.overall.override.
function deriveOverall(state) {
  const override = state.overall && state.overall.override;
  if (override && override.status) {
    return {
      status: override.status,
      message: override.message || defaultMessageFor(override.status, 0),
      overridden: true,
    };
  }
  const reds = state.categories.filter((c) => c.status === 'red').length;
  const yellows = state.categories.filter((c) => c.status === 'yellow').length;

  if (reds > 0) {
    return { status: 'red', message: 'Something needs attention now', overridden: false };
  }
  if (yellows > 0) {
    const n = yellows;
    return {
      status: 'yellow',
      message: `${n} ${n === 1 ? 'thing needs' : 'things need'} your attention`,
      overridden: false,
    };
  }
  return { status: 'green', message: 'Everything under control', overridden: false };
}

function defaultMessageFor(status) {
  if (status === 'red') return 'Something needs attention now';
  if (status === 'yellow') return 'Something needs your attention';
  if (status === 'purple') return 'Something is in progress';
  return 'Everything under control';
}

function publicState(state) {
  const categories = [...state.categories].sort((a, b) => a.order - b.order);
  const focus = [...state.focus].sort((a, b) => a.order - b.order);
  const week = [...state.week].sort((a, b) => a.order - b.order);
  const projects = [...state.projects].sort((a, b) => a.order - b.order);
  return {
    org: state.org,
    serverTime: new Date().toISOString(),
    overall: deriveOverall(state),
    reassurance: state.reassurance || '',
    categories,
    focus,
    week,
    projects,
    completedCount: state.completed.length,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function findCategory(state, key) {
  const k = String(key).toLowerCase();
  return state.categories.find(
    (c) => c.id.toLowerCase() === k || c.label.toLowerCase() === k
  );
}

function nextOrder(list) {
  return list.reduce((max, x) => Math.max(max, x.order + 1), 0);
}

function sendJson(res, code, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // basic guard
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function validateStatus(status) {
  if (status === undefined) return null;
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  return status;
}

// ---------------------------------------------------------------------------
// Auth  (single shared bearer token; open when DASHBOARD_TOKEN is unset)
// ---------------------------------------------------------------------------

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

// Pull the presented token from (in order): Authorization: Bearer,
// X-API-Key header, ?token= query, or the dash_token cookie.
function presentedToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  const q = new URL(req.url, 'http://x').searchParams.get('token');
  if (q) return q;
  const cookie = parseCookies(req)['dash_token'];
  if (cookie) return cookie;
  return null;
}

function tokenMatches(presented) {
  if (!DASHBOARD_TOKEN) return true; // open mode (local dev)
  if (!presented) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(DASHBOARD_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isHttps(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------

async function handleApi(req, res, segments, method) {
  const state = loadState();
  const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readBody(req) : {};

  // ---- /api/state -----------------------------------------------------------
  if (segments.length === 1 && segments[0] === 'state') {
    if (method === 'GET') return sendJson(res, 200, publicState(state));
    return sendJson(res, 405, { error: 'Use GET for /api/state' });
  }

  // ---- /api/health ----------------------------------------------------------
  if (segments.length === 1 && segments[0] === 'health') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  }

  // ---- /api/history ---------------------------------------------------------
  if (segments.length === 1 && segments[0] === 'history') {
    if (method === 'GET') {
      const limit = 50;
      return sendJson(res, 200, { history: (state.history || []).slice(0, limit) });
    }
    return sendJson(res, 405, { error: 'Use GET for /api/history' });
  }

  // ---- /api/overall ---------------------------------------------------------
  // PATCH to pin an override, or clear it with {"override": null}.
  if (segments.length === 1 && segments[0] === 'overall') {
    if (method === 'GET') return sendJson(res, 200, deriveOverall(state));
    if (method === 'PATCH') {
      if (Object.prototype.hasOwnProperty.call(body, 'override')) {
        if (body.override === null) {
          state.overall.override = null;
          record(state, 'overall.clear-override', {});
        } else {
          validateStatus(body.override.status);
          state.overall.override = {
            status: body.override.status,
            message: body.override.message || null,
          };
          record(state, 'overall.set-override', state.overall.override);
        }
        saveState(state);
      }
      return sendJson(res, 200, deriveOverall(state));
    }
    return sendJson(res, 405, { error: 'Use GET or PATCH for /api/overall' });
  }

  // ---- /api/reassurance -----------------------------------------------------
  if (segments.length === 1 && segments[0] === 'reassurance') {
    if (method === 'PATCH') {
      if (typeof body.text === 'string') {
        state.reassurance = body.text;
        record(state, 'reassurance.update', { text: body.text });
        saveState(state);
      }
      return sendJson(res, 200, { reassurance: state.reassurance });
    }
    return sendJson(res, 200, { reassurance: state.reassurance });
  }

  // ---- /api/categories ------------------------------------------------------
  if (segments[0] === 'categories') {
    // /api/categories
    if (segments.length === 1) {
      if (method === 'GET') {
        return sendJson(res, 200, {
          categories: [...state.categories].sort((a, b) => a.order - b.order),
        });
      }
      if (method === 'POST') {
        if (!body.label) return sendJson(res, 400, { error: 'label is required' });
        const cat = {
          id: (body.id || body.label).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          label: body.label,
          status: validateStatus(body.status) || 'green',
          summary: body.summary || '',
          order: body.order != null ? body.order : nextOrder(state.categories),
          items: [],
        };
        if (findCategory(state, cat.id)) {
          return sendJson(res, 409, { error: `Category "${cat.id}" already exists` });
        }
        state.categories.push(cat);
        record(state, 'category.create', { id: cat.id });
        saveState(state);
        return sendJson(res, 201, cat);
      }
    }

    const cat = findCategory(state, segments[1]);

    // /api/categories/:key
    if (segments.length === 2) {
      if (!cat) return sendJson(res, 404, { error: `No category "${segments[1]}"` });
      if (method === 'GET') return sendJson(res, 200, cat);
      if (method === 'PATCH') {
        if (body.status !== undefined) cat.status = validateStatus(body.status);
        if (body.summary !== undefined) cat.summary = body.summary;
        if (body.label !== undefined) cat.label = body.label;
        if (body.order !== undefined) cat.order = body.order;
        record(state, 'category.update', { id: cat.id, changes: body });
        saveState(state);
        return sendJson(res, 200, cat);
      }
      if (method === 'DELETE') {
        state.categories = state.categories.filter((c) => c !== cat);
        record(state, 'category.delete', { id: cat.id });
        saveState(state);
        return sendJson(res, 200, { deleted: cat.id });
      }
    }

    // /api/categories/:key/items ...
    if (segments.length >= 3 && segments[2] === 'items') {
      if (!cat) return sendJson(res, 404, { error: `No category "${segments[1]}"` });

      // /api/categories/:key/items
      if (segments.length === 3) {
        if (method === 'GET') return sendJson(res, 200, { items: cat.items });
        if (method === 'POST') {
          if (!body.text) return sendJson(res, 400, { error: 'text is required' });
          const item = {
            id: body.id || `${cat.id}-${randomUUID().slice(0, 8)}`,
            text: body.text,
            status: validateStatus(body.status) || 'green',
            note: body.note || '',
            projectId: body.projectId || '',
          };
          cat.items.push(item);
          record(state, 'item.create', { category: cat.id, id: item.id });
          saveState(state);
          return sendJson(res, 201, item);
        }
      }

      // /api/categories/:key/items/:itemId
      if (segments.length === 4) {
        const item = cat.items.find((i) => i.id === segments[3]);
        if (!item) return sendJson(res, 404, { error: `No item "${segments[3]}"` });
        if (method === 'GET') return sendJson(res, 200, item);
        if (method === 'PATCH') {
          if (body.text !== undefined) item.text = body.text;
          if (body.status !== undefined) item.status = validateStatus(body.status);
          if (body.note !== undefined) item.note = body.note;
          if (body.projectId !== undefined) item.projectId = body.projectId;
          record(state, 'item.update', { category: cat.id, id: item.id, changes: body });
          saveState(state);
          return sendJson(res, 200, item);
        }
        if (method === 'DELETE') {
          cat.items = cat.items.filter((i) => i !== item);
          record(state, 'item.delete', { category: cat.id, id: item.id });
          saveState(state);
          return sendJson(res, 200, { deleted: item.id });
        }
      }

      // /api/categories/:key/items/:itemId/complete  — archive to the bucket
      if (segments.length === 5 && segments[4] === 'complete' && method === 'POST') {
        const item = cat.items.find((i) => i.id === segments[3]);
        if (!item) return sendJson(res, 404, { error: `No item "${segments[3]}"` });
        cat.items = cat.items.filter((i) => i !== item);
        const rec = {
          id: item.id,
          text: item.text,
          note: item.note || '',
          status: item.status,
          categoryId: cat.id,
          categoryLabel: cat.label,
          source: 'category',
          completedAt: new Date().toISOString(),
        };
        state.completed.unshift(rec);
        record(state, 'item.complete', { category: cat.id, id: item.id });
        saveState(state);
        return sendJson(res, 200, rec);
      }
    }

    return sendJson(res, 405, { error: 'Unsupported categories route/method' });
  }

  // ---- /api/focus -----------------------------------------------------------
  if (segments[0] === 'focus') {
    // /api/focus/reorder
    if (segments.length === 2 && segments[1] === 'reorder' && method === 'POST') {
      const order = body.order || [];
      order.forEach((id, index) => {
        const f = state.focus.find((x) => x.id === id);
        if (f) f.order = index;
      });
      record(state, 'focus.reorder', { order });
      saveState(state);
      return sendJson(res, 200, { focus: [...state.focus].sort((a, b) => a.order - b.order) });
    }

    // /api/focus
    if (segments.length === 1) {
      if (method === 'GET') {
        return sendJson(res, 200, { focus: [...state.focus].sort((a, b) => a.order - b.order) });
      }
      if (method === 'POST') {
        if (!body.title) return sendJson(res, 400, { error: 'title is required' });
        const item = {
          id: body.id || `focus-${randomUUID().slice(0, 8)}`,
          title: body.title,
          detail: body.detail || '',
          // position: 'top' puts it first and bumps everything down.
          order: body.position === 'top' ? -1 : (body.order != null ? body.order : nextOrder(state.focus)),
        };
        state.focus.push(item);
        normalizeFocusOrder(state);
        record(state, 'focus.create', { id: item.id, title: item.title });
        saveState(state);
        return sendJson(res, 201, item);
      }
    }

    // /api/focus/:id
    if (segments.length === 2) {
      const item = state.focus.find((f) => f.id === segments[1]);
      if (!item) return sendJson(res, 404, { error: `No focus item "${segments[1]}"` });
      if (method === 'GET') return sendJson(res, 200, item);
      if (method === 'PATCH') {
        if (body.title !== undefined) item.title = body.title;
        if (body.detail !== undefined) item.detail = body.detail;
        if (body.position === 'top') item.order = -1;
        else if (body.order !== undefined) item.order = body.order;
        normalizeFocusOrder(state);
        record(state, 'focus.update', { id: item.id, changes: body });
        saveState(state);
        return sendJson(res, 200, item);
      }
      if (method === 'DELETE') {
        state.focus = state.focus.filter((f) => f !== item);
        normalizeFocusOrder(state);
        record(state, 'focus.delete', { id: item.id });
        saveState(state);
        return sendJson(res, 200, { deleted: item.id });
      }
    }

    return sendJson(res, 405, { error: 'Unsupported focus route/method' });
  }

  // ---- /api/week ------------------------------------------------------------
  // The "This Week" task list shown in the right column.
  if (segments[0] === 'week') {
    // /api/week/reorder
    if (segments.length === 2 && segments[1] === 'reorder' && method === 'POST') {
      const order = body.order || [];
      order.forEach((id, index) => {
        const t = state.week.find((x) => x.id === id);
        if (t) t.order = index;
      });
      record(state, 'week.reorder', { order });
      saveState(state);
      return sendJson(res, 200, { week: [...state.week].sort((a, b) => a.order - b.order) });
    }

    // /api/week/:id/complete  — archive a weekly task to the completed bucket
    if (segments.length === 3 && segments[2] === 'complete' && method === 'POST') {
      const task = state.week.find((t) => t.id === segments[1]);
      if (!task) return sendJson(res, 404, { error: `No week task "${segments[1]}"` });
      state.week = state.week.filter((t) => t !== task);
      normalizeWeekOrder(state);
      const rec = {
        id: task.id,
        text: task.title,
        note: task.note || '',
        meta: task.meta || '',
        status: task.status,
        categoryId: '__week__',
        categoryLabel: 'This Week',
        source: 'week',
        completedAt: new Date().toISOString(),
      };
      state.completed.unshift(rec);
      record(state, 'week.complete', { id: task.id });
      saveState(state);
      return sendJson(res, 200, rec);
    }

    // /api/week
    if (segments.length === 1) {
      if (method === 'GET') {
        return sendJson(res, 200, { week: [...state.week].sort((a, b) => a.order - b.order) });
      }
      if (method === 'POST') {
        if (!body.title) return sendJson(res, 400, { error: 'title is required' });
        const task = {
          id: body.id || `week-${randomUUID().slice(0, 8)}`,
          title: body.title,
          meta: body.meta || '',
          note: body.note || '',
          projectId: body.projectId || '',
          status: validateStatus(body.status) || 'green',
          done: !!body.done,
          order: body.position === 'top' ? -1 : (body.order != null ? body.order : nextOrder(state.week)),
        };
        state.week.push(task);
        normalizeWeekOrder(state);
        record(state, 'week.create', { id: task.id, title: task.title });
        saveState(state);
        return sendJson(res, 201, task);
      }
    }

    // /api/week/:id
    if (segments.length === 2) {
      const task = state.week.find((t) => t.id === segments[1]);
      if (!task) return sendJson(res, 404, { error: `No week task "${segments[1]}"` });
      if (method === 'GET') return sendJson(res, 200, task);
      if (method === 'PATCH') {
        if (body.title !== undefined) task.title = body.title;
        if (body.meta !== undefined) task.meta = body.meta;
        if (body.note !== undefined) task.note = body.note;
        if (body.projectId !== undefined) task.projectId = body.projectId;
        if (body.status !== undefined) task.status = validateStatus(body.status);
        if (body.done !== undefined) task.done = !!body.done;
        if (body.position === 'top') task.order = -1;
        else if (body.order !== undefined) task.order = body.order;
        normalizeWeekOrder(state);
        record(state, 'week.update', { id: task.id, changes: body });
        saveState(state);
        return sendJson(res, 200, task);
      }
      if (method === 'DELETE') {
        state.week = state.week.filter((t) => t !== task);
        normalizeWeekOrder(state);
        record(state, 'week.delete', { id: task.id });
        saveState(state);
        return sendJson(res, 200, { deleted: task.id });
      }
    }

    return sendJson(res, 405, { error: 'Unsupported week route/method' });
  }

  // ---- /api/projects --------------------------------------------------------
  // The "Current Projects" boxes shown in the right column.
  if (segments[0] === 'projects') {
    // /api/projects/reorder
    if (segments.length === 2 && segments[1] === 'reorder' && method === 'POST') {
      const order = body.order || [];
      order.forEach((id, index) => {
        const p = state.projects.find((x) => x.id === id);
        if (p) p.order = index;
      });
      record(state, 'project.reorder', { order });
      saveState(state);
      return sendJson(res, 200, { projects: [...state.projects].sort((a, b) => a.order - b.order) });
    }

    // /api/projects
    if (segments.length === 1) {
      if (method === 'GET') {
        return sendJson(res, 200, { projects: [...state.projects].sort((a, b) => a.order - b.order) });
      }
      if (method === 'POST') {
        if (!body.name) return sendJson(res, 400, { error: 'name is required' });
        const project = {
          id: body.id || `proj-${randomUUID().slice(0, 8)}`,
          name: body.name,
          logo: body.logo || '',
          tagline: body.tagline || '',
          stage: body.stage || '',
          url: body.url || '',
          description: body.description || '',
          group: body.group === 'immediate' ? 'immediate' : 'long-term',
          status: validateStatus(body.status) || 'purple',
          note: body.note || '',
          order: body.position === 'top' ? -1 : (body.order != null ? body.order : nextOrder(state.projects)),
        };
        state.projects.push(project);
        normalizeProjectsOrder(state);
        record(state, 'project.create', { id: project.id, name: project.name });
        saveState(state);
        return sendJson(res, 201, project);
      }
    }

    // /api/projects/:id
    if (segments.length === 2) {
      const project = state.projects.find((p) => p.id === segments[1]);
      if (!project) return sendJson(res, 404, { error: `No project "${segments[1]}"` });
      if (method === 'GET') return sendJson(res, 200, project);
      if (method === 'PATCH') {
        if (body.name !== undefined) project.name = body.name;
        if (body.logo !== undefined) project.logo = body.logo;
        if (body.tagline !== undefined) project.tagline = body.tagline;
        if (body.stage !== undefined) project.stage = body.stage;
        if (body.url !== undefined) project.url = body.url;
        if (body.description !== undefined) project.description = body.description;
        if (body.group !== undefined) project.group = body.group === 'immediate' ? 'immediate' : 'long-term';
        if (body.status !== undefined) project.status = validateStatus(body.status);
        if (body.note !== undefined) project.note = body.note;
        if (body.position === 'top') project.order = -1;
        else if (body.order !== undefined) project.order = body.order;
        normalizeProjectsOrder(state);
        record(state, 'project.update', { id: project.id, changes: body });
        saveState(state);
        return sendJson(res, 200, project);
      }
      if (method === 'DELETE') {
        state.projects = state.projects.filter((p) => p !== project);
        normalizeProjectsOrder(state);
        record(state, 'project.delete', { id: project.id });
        saveState(state);
        return sendJson(res, 200, { deleted: project.id });
      }
    }

    return sendJson(res, 405, { error: 'Unsupported projects route/method' });
  }

  // ---- /api/completed -------------------------------------------------------
  // The archive of finished tasks (the "holding bucket").
  if (segments[0] === 'completed') {
    // /api/completed
    if (segments.length === 1 && method === 'GET') {
      return sendJson(res, 200, { completed: state.completed });
    }

    // /api/completed/:id/restore  — put it back on its original category
    if (segments.length === 3 && segments[2] === 'restore' && method === 'POST') {
      const rec = state.completed.find((c) => c.id === segments[1]);
      if (!rec) return sendJson(res, 404, { error: `No completed task "${segments[1]}"` });
      state.completed = state.completed.filter((c) => c !== rec);
      if (rec.source === 'week') {
        state.week.push({
          id: rec.id,
          title: rec.text,
          meta: rec.meta || '',
          note: rec.note || '',
          status: rec.status || 'green',
          done: false,
          order: nextOrder(state.week),
        });
        normalizeWeekOrder(state);
        record(state, 'week.restore', { id: rec.id });
        saveState(state);
        return sendJson(res, 200, { restored: rec.id, into: 'week' });
      }
      let cat = findCategory(state, rec.categoryId) || state.categories[0];
      if (cat) {
        cat.items.push({ id: rec.id, text: rec.text, status: rec.status || 'green', note: rec.note || '' });
      }
      record(state, 'item.restore', { id: rec.id, category: cat ? cat.id : null });
      saveState(state);
      return sendJson(res, 200, { restored: rec.id, category: cat ? cat.id : null });
    }

    // /api/completed/:id  — permanently remove from the archive
    if (segments.length === 2 && method === 'DELETE') {
      const rec = state.completed.find((c) => c.id === segments[1]);
      if (!rec) return sendJson(res, 404, { error: `No completed task "${segments[1]}"` });
      state.completed = state.completed.filter((c) => c !== rec);
      record(state, 'completed.delete', { id: rec.id });
      saveState(state);
      return sendJson(res, 200, { deleted: rec.id });
    }

    return sendJson(res, 405, { error: 'Unsupported completed route/method' });
  }

  return sendJson(res, 404, { error: 'Unknown API route' });
}

function normalizeWeekOrder(state) {
  const sorted = [...state.week].sort((a, b) => a.order - b.order);
  sorted.forEach((t, i) => (t.order = i));
}

function normalizeProjectsOrder(state) {
  // Re-pack order within each group (immediate / long-term) independently.
  const groups = {};
  for (const p of state.projects) {
    const g = p.group || 'long-term';
    (groups[g] = groups[g] || []).push(p);
  }
  for (const g of Object.keys(groups)) {
    groups[g].sort((a, b) => a.order - b.order).forEach((p, i) => (p.order = i));
  }
}

// Re-pack focus order into 0..n after inserts/reorders that used -1 etc.
function normalizeFocusOrder(state) {
  const sorted = [...state.focus].sort((a, b) => a.order - b.order);
  sorted.forEach((f, i) => (f.order = i));
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    });
    return res.end();
  }

  const urlPath = req.url.split('?')[0];

  // ---- /unlock : one-time token entry that sets a cookie on this device ----
  // Used on the monitor so the browser can read the API without embedding the
  // token in client-side JS. GPT and curl just send the Bearer header instead.
  if (urlPath === '/unlock') {
    if (!DASHBOARD_TOKEN) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    const t = new URL(req.url, 'http://x').searchParams.get('token');
    if (t && tokenMatches(t)) {
      const secure = isHttps(req) ? ' Secure;' : '';
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `dash_token=${encodeURIComponent(t)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=31536000`,
      });
      return res.end();
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>Invalid token</h1><p>Append ?token=YOUR_TOKEN to the URL.</p>');
  }

  if (urlPath.startsWith('/api/')) {
    // Health is intentionally open so uptime checks don't need the secret.
    const isHealth = urlPath === '/api/health';
    if (!isHealth && !tokenMatches(presentedToken(req))) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendJson(res, 401, {
        error: 'unauthorized',
        hint: 'Send the token via "Authorization: Bearer <token>" (API/GPT) or visit /unlock?token=<token> once in a browser.',
      });
    }
    const segments = urlPath.replace(/^\/api\//, '').replace(/\/$/, '').split('/').filter(Boolean);
    try {
      await handleApi(req, res, segments, method);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  loadState(); // ensure state.json exists on boot
  console.log('');
  console.log('  ALBANY DATA SYSTEMS — Chief of Staff Dashboard');
  console.log('  ---------------------------------------------');
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  API:        http://localhost:${PORT}/api/state`);
  if (DASHBOARD_TOKEN) {
    console.log('  Auth:       ON  (token required — Bearer header, or /unlock?token=… in a browser)');
  } else {
    console.log('  Auth:       OFF (open mode — fine for local dev; set DASHBOARD_TOKEN before exposing)');
  }
  console.log('');
  console.log('  Put it full-screen on your monitor and sit back.');
  console.log('');
});

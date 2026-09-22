# Albany Data Systems — Chief of Staff Dashboard

A calm, full-screen **command center**. Leave it open on a dedicated monitor and,
from across the room, know two things instantly:

> **Is everything okay, and what should I be working on?**

It is *not* a CRM, project tracker, or analytics tool. It's a display surface and
persistent state store for an AI Chief of Staff (ChatGPT) to drive.

---

## Run it

No dependencies to install. Just:

```bash
node server.js
```

Then open **http://localhost:4300** and put it full-screen (F11).

- State lives in `data/state.json` (auto-created from `data/seed.json` on first run). This
  is the live database — all tasks, statuses, edits and completed items.
- The server auto-backs up `state.json` to `data/backups/` on start and every 6 hours (last
  20 kept), so an accidental delete is recoverable from the previous snapshot.
- To reset a **local/test** copy to demo data, delete `data/state.json` and refresh. **Do
  not do this on a live server** — it wipes real data (see [DEPLOY.md](DEPLOY.md)).
- The UI polls the API every 5 seconds, so changes made by the API (or ChatGPT)
  appear on the monitor within a few seconds automatically.

Set a different port with `PORT=8080 node server.js`.

---

## The idea

- **Header** — org name, live date/time, and one overall status line
  (🟢 Everything under control / 🟡 N things need your attention / 🔴 Something needs attention now).
  The overall status is **derived automatically** from the category statuses (red > yellow > green),
  unless you pin an override.
- **Status board** — one horizontal card per category. Green cards recede; yellow/red cards
  glow and pulse. Click any card to expand its underlying detail items, then close to return
  to the calm view.
- **Your Focus** — up to ~3 priorities, plus a reassuring "Everything else can wait." line.

### Status colors

| Color | Meaning |
|-------|---------|
| 🟢 `green` | Fine. Ignore this completely. |
| 🟡 `yellow` | Deserves attention, not an emergency. |
| 🔴 `red` | Needs attention today/now. |
| 🟣 `purple` | Something important is actively in progress — no problem. |

---

## Editing locally

Click **Edit** (bottom-right) for a lightweight panel to change category statuses/summaries,
add/remove/reorder focus priorities, and edit the reassurance line. It just calls the same API
described below.

---

## The API (for ChatGPT / any AI Chief of Staff)

Base URL: `http://localhost:4300/api`. All responses are JSON. CORS is open, so an
external agent can call it directly. Mutations are logged to a bounded history.

### Read everything
```
GET /api/state
```
Returns org, derived `overall`, `reassurance`, all `categories` (with `items`), and `focus`,
each sorted by display order. **This one call is enough to answer "what's yellow right now?"**

### Categories
```
GET    /api/categories                     # list
GET    /api/categories/:key                # one (key = id or label, case-insensitive)
POST   /api/categories                     # { label, status?, summary?, order? }
PATCH  /api/categories/:key                # { status?, summary?, label?, order? }
DELETE /api/categories/:key
```
`:key` matches either the id (`bmts`) or the label (`BMTS`, `CLIENTS / SALES`).

**Detail items** inside a category:
```
GET    /api/categories/:key/items
POST   /api/categories/:key/items          # { text, status?, note? }
PATCH  /api/categories/:key/items/:itemId  # { text?, status?, note? }
DELETE /api/categories/:key/items/:itemId
```

### Your Focus (priorities)
```
GET    /api/focus
POST   /api/focus            # { title, detail?, position? }   position:"top" makes it #1
PATCH  /api/focus/:id        # { title?, detail?, position?, order? }
DELETE /api/focus/:id
POST   /api/focus/reorder    # { order: ["focus-2","focus-1", ...] }
```

### Overall banner override
```
GET   /api/overall
PATCH /api/overall           # { override: { status, message? } }  or  { override: null } to clear
```

### Reassurance line
```
PATCH /api/reassurance       # { text }
```

### History
```
GET /api/history             # recent changes (newest first)
```

`status` is always one of: `green`, `yellow`, `red`, `purple`.

---

## Worked examples (the things Ben will actually say)

**"Make Margiasso my number-one priority."**
```bash
curl -X POST http://localhost:4300/api/focus \
  -H "Content-Type: application/json" \
  -d '{"title":"Margiasso","detail":"Top priority.","position":"top"}'
```

**"The PPA issue is handled."**
```bash
curl -X PATCH http://localhost:4300/api/categories/ppa \
  -H "Content-Type: application/json" \
  -d '{"status":"green","summary":"Operating normally"}'
```

**"What's yellow right now?"** — read state and filter client-side:
```bash
curl -s http://localhost:4300/api/state | jq '.categories[] | select(.status=="yellow") | .label'
```

**"Flag a new client inquiry."**
```bash
curl -X PATCH http://localhost:4300/api/categories/clients-sales \
  -H "Content-Type: application/json" \
  -d '{"status":"yellow","summary":"2 new ADS inquiries need review"}'

curl -X POST http://localhost:4300/api/categories/clients-sales/items \
  -H "Content-Type: application/json" \
  -d '{"text":"Margiasso website inquiry","status":"yellow","note":"Called Tuesday"}'
```

---

## Data model (`data/state.json`)

```jsonc
{
  "org": "ALBANY DATA SYSTEMS",
  "overall": { "override": null },          // or { override: { status, message } }
  "reassurance": "Everything else can wait.",
  "categories": [
    {
      "id": "bmts",
      "label": "BMTS",
      "status": "green",
      "summary": "14 active sites · 2 tasks · No critical issues",
      "order": 2,
      "items": [
        { "id": "bmts-1", "text": "2 open tasks", "status": "green", "note": "" }
      ]
    }
  ],
  "focus": [
    { "id": "focus-1", "title": "Social Platform Approvals", "detail": "…", "order": 0 }
  ],
  "history": []
}
```

Everything the screen shows is here — the frontend holds no hidden state. Point BMTS
(or Gmail, Calendar, QuickBooks, etc.) at this API later without touching the UI.

---

## What's intentionally *not* built yet

Live integrations (BMTS API, Gmail, Calendar, QuickBooks) — the spec says don't overbuild
these. The data model and API are already shaped so those become "write category summaries
and items into this API on a schedule," nothing more.

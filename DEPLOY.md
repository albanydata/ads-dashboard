# Deploying the ADS Dashboard & connecting ChatGPT

Three parts:
1. [Lightsail instance setup](#1-lightsail-instance-setup) — the permanent home.
2. [Quick test with ngrok](#2-quick-test-with-ngrok) — connect GPT in 5 minutes before DNS is ready.
3. [Connect the custom GPT](#3-connect-the-custom-gpt) — Actions + auth.

The app needs a **token** (so it isn't wide open) and **HTTPS** (so ChatGPT can reach it).

---

## 1. Lightsail instance setup

### 1a. Create the instance
1. AWS console → **Lightsail** → **Create instance**.
2. Platform **Linux/Unix**, blueprint **OS Only → Ubuntu 22.04 LTS**.
   (Node-only app; you don't need the Node blueprint.)
3. Plan: the smallest ($5/mo) is plenty. The $3.50 one works too.
4. Name it `ads-dashboard`, **Create**.

### 1b. Open the firewall
- Instance → **Networking** tab → under **IPv4 Firewall**, add rules:
  - **HTTP** — TCP **80**
  - **HTTPS** — TCP **443**
- Leave **SSH (22)** as is. Do **not** open 4300 — the app stays private behind Caddy.
- Attach a **Static IP** (Networking → Create static IP → attach). You'll point DNS at this.

### 1c. Install Node and Caddy
Open the browser SSH (the terminal icon on the instance), then:

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy (automatic HTTPS)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

### 1d. Get the code onto the instance
Easiest is git (push this folder to a private GitHub repo, then clone). Or scp it up. Then:

```bash
cd ~/ads-dashboard          # the project folder
cp .env.example .env
node -e "console.log('DASHBOARD_TOKEN=' + require('crypto').randomBytes(24).toString('hex'))"
nano .env                   # paste the DASHBOARD_TOKEN line above, save
```

Keep that token somewhere safe — you'll paste it into the GPT.

### 1e. Run it as a service (survives reboots/crashes)
```bash
sudo cp deploy/ads-dashboard.service /etc/systemd/system/
# edit the file if your user/path aren't ubuntu:/home/ubuntu/ads-dashboard
sudo nano /etc/systemd/system/ads-dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now ads-dashboard
systemctl status ads-dashboard      # should say "active (running)"
```

### 1f. DNS + HTTPS
1. Point a subdomain at the static IP: an **A record** for
   `dashboard.albanydata.com` → your Lightsail static IP (do this at your DNS host).
2. Put that same subdomain in `deploy/Caddyfile`, then:
```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```
Caddy fetches a Let's Encrypt cert automatically. After DNS propagates (minutes),
`https://dashboard.albanydata.com` shows the dashboard.

### 1g. Unlock the monitor
On the dedicated monitor's browser, visit once:
```
https://dashboard.albanydata.com/unlock?token=YOUR_TOKEN
```
It sets a cookie and redirects to the dashboard. From then on it just loads. (If the
token is ever wrong you'll see the lock screen — enter the token there.)

---

## 2. Quick test with ngrok

Use this to connect GPT immediately, before the domain/cert are set up. Run it against
either your local Windows machine or the Lightsail box.

```bash
# 1. Set a token so the tunnel isn't open to the world:
#    put DASHBOARD_TOKEN=something in .env (see .env.example)
node server.js

# 2. In another terminal, expose it:
ngrok http 4300
```
ngrok prints a public HTTPS URL like `https://abc123.ngrok-free.app`. That's your
temporary server URL for the GPT. To view the dashboard in a browser through the tunnel,
visit `https://abc123.ngrok-free.app/unlock?token=YOUR_TOKEN` once.

> The free ngrok URL changes each restart — you'll re-paste it into the GPT. That's why
> it's for testing; Lightsail + a domain is the stable home.

---

## 3. Connect the custom GPT

1. ChatGPT → **Explore GPTs → Create → Configure → Create new Action**.
2. **Schema**: paste the contents of [`openapi.yaml`](openapi.yaml). Then edit the
   `servers.url` at the top to your current public URL (ngrok URL for testing, or
   `https://dashboard.albanydata.com` in production).
3. **Authentication**: choose **API Key**, Auth Type **Bearer**, and paste your
   `DASHBOARD_TOKEN` as the key.
4. Save. Test with prompts like:
   - "What's yellow right now?" → calls `getState`
   - "Make Margiasso my number-one priority." → `addFocus` with position top
   - "The PPA issue is handled." → `updateCategory` bmts/ppa to green
   - "Mark the client emails done." → `updateWeekTask` done=true

Changes appear on the monitor within ~5 seconds (it polls the API).

---

## Updating a live server (data-safe)

Once the dashboard holds real data, deploy new code like this — it keeps your data:

```
cd ~/ads-dashboard && git pull && sudo systemctl restart ads-dashboard
```

`data/state.json` is your live database (every task, status, edit, completed item).
A `git pull` + restart never touches it; the app auto-adds any new fields/sections.

> ⚠️ **Do NOT run `rm data/state.json`** on a live server. That deletes your data and the
> app rebuilds it from the demo seed on restart. Only use it on a throwaway/test box, or
> the very first time you stand the server up.

New *demo* content from `data/seed.json` will not appear on an existing server (by design —
your real data wins). Add real projects and tasks through the UI or ChatGPT.

## Backups & restore

The server snapshots `state.json` into `data/backups/` on every start and every 6 hours,
keeping the last 20. That folder is separate from `state.json`, so even deleting the live
file leaves the previous snapshots intact.

To restore one:
```
ls -t ~/ads-dashboard/data/backups/          # newest first
cp ~/ads-dashboard/data/backups/state-<timestamp>.json ~/ads-dashboard/data/state.json
sudo systemctl restart ads-dashboard
```

---

## Security notes
- The token guards **all** of `/api/*` (reads and writes). `/api/health` is open for uptime checks.
- Never commit `.env` — it's gitignored.
- Rotate the token by changing `.env` and running `sudo systemctl restart ads-dashboard`
  (then update the GPT's key and re-`/unlock` the monitor).
- When you outgrow the JSON file (lots of history / BMTS data), switch the store to SQLite —
  still one file on this same instance, no new infrastructure.

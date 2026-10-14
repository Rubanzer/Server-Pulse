<div align="center">

# 📈 Server Pulse

**Live vitals and a year of history for your Ubuntu server — from anywhere, on free tiers.**

one command on the server · live logs and failure history · a Next.js dashboard on Vercel · history in Neon Postgres · Telegram & email alerts

[![Next.js](https://img.shields.io/badge/Next.js-App_Router-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vercel](https://img.shields.io/badge/Vercel-Hobby-000000?logo=vercel&logoColor=white)](https://vercel.com)
[![Neon](https://img.shields.io/badge/Neon-Postgres-00E599?logo=postgresql&logoColor=white)](https://neon.com)
[![Netdata](https://img.shields.io/badge/Netdata-metrics-00AB44?logo=netdata&logoColor=white)](https://www.netdata.cloud)
[![Tailscale](https://img.shields.io/badge/Tailscale-Funnel-242424?logo=tailscale&logoColor=white)](https://tailscale.com/kb/1223/funnel)
[![Cost](https://img.shields.io/badge/cost-%240%2Fmonth-brightgreen)](#-free-tier-budget)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#-license)

</div>

---

## 📑 Table of contents

- [What it does](#-what-it-does)
- [Architecture](#-architecture)
- [Tech stack](#-tech-stack)
- [Free-tier budget](#-free-tier-budget)
- [Project structure](#-project-structure)
- [Quick start](#-quick-start)
- [Part 1 — Server agent (Ubuntu)](#-part-1--server-agent-ubuntu)
- [Part 2 — Dashboard (Vercel)](#-part-2--dashboard-vercel)
- [Local development](#-local-development)
- [Configuration reference](#-configuration-reference)
- [How history works](#-how-history-works)
- [Data model](#-data-model)
- [API reference](#-api-reference)
- [Alerts](#-alerts)
- [30-day email report](#-30-day-email-report)
- [Security](#-security)
- [Troubleshooting](#-troubleshooting)
- [Roadmap](#-roadmap)
- [License](#-license)

---

## ✨ What it does

Server Pulse has two parts that only talk over one HTTPS link:

| Part           | Runs on             | What you get                                                                                                                                                                                                          |
| -------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server kit** | Your Ubuntu machine | btop live in the browser, Netdata metrics every second with a 30-day local store, one login via Caddy, a free tunnel (Tailscale Funnel or ngrok), real-time Telegram/email alerts, and a 30-day usage report by email |
| **Dashboard**  | Vercel (free)       | Live KPI cards and charts, history from 1 hour to 1 year, monthly reports, CSV export, owner + viewer passwords, installable as a phone app                                                                           |

**Highlights**

- 🔗 **One-link setup** — paste `SERVER_URL` into Vercel and the dashboard works.
- ⚡ **Live** — CPU, RAM, load, disk, network and temperature every second, streamed straight from your server (no request per reading).
- 🗄️ **History that outlives the server** — copied nightly into Postgres, 1-minute detail for 30 days and hourly for a year or more.
- 📊 **Reports** — monthly averages and peaks to decide when to upgrade.
- 🔔 **Alerts** — Telegram and email the moment a threshold is crossed.
- 🔒 **Read-only by design** — nothing in the dashboard can change the server.
- 💸 **$0/month** — every service stays inside its free tier.
- 🧪 **Demo mode** — runs locally with generated data before you connect anything.
- 👤 **Accounts** — sign up with email and password; each account gets its own server link and its own private history.
- 🔌 **Connect in the app** — paste your ngrok or Tailscale link on `/connect`; data starts flowing immediately, no redeploy.
- 🌗 **Light, dark or system theme**, and a layout that works from a 320 px phone to a 4K screen.
- 🖥️ **btop in the browser, done properly**: the Server page shows every core (heatmap with temperatures), memory, disks, network and processes, streamed live every second straight from your server.
- 🔗 **Add a server with one command**: a one-time code pairs the agent with your dashboard; you approve the server before it's saved.
- 🧭 **Honest history**: charts cover the range you pick, shade the time before monitoring started, and break at gaps with the reason (server off, agent stopped, filling from server). Every chart shows its coverage; Reports mark months that weren't monitored.
- 📈 **True peaks at any zoom**: a one-minute spike still shows as the peak on a 1-year view, because every hour keeps its peak minute.
- 🔁 **Gaps fill themselves**: when the internet, tunnel or dashboard was down but the server kept running, the missing time is copied from the server (it keeps 30 days) on the next sync or as soon as you open the dashboard.
- 🕰️ **Any time window, everywhere**: History, Logs and Failures share one _From … to …_ picker; open a failure to jump to the log lines or the CPU/memory/disk charts around it, and from History to the logs and failures of the same window.
- 📜 **Live logs and failure history**: the Logs page streams the server's system log live (filter by level, service, text) and keeps every failure (crashes, out-of-memory, failed services, disk errors, CPU/RAM/disk/temperature limits, offline) for 180 days. Secrets are removed on the server before anything is sent.
- 🎞️ **Smooth at 60 fps** — live charts scroll continuously with zero added delay; pages switch instantly.
- 🧭 **One-command setup** — _Add server_ shows one install command; you approve the server by name and live data starts.

---

## 🏗️ Architecture

```mermaid
flowchart LR
  B["👤 Browser or installed PWA"]

  subgraph S["🖥️ Ubuntu server — server kit"]
    TU["Tunnel agent<br/>Tailscale Funnel or ngrok<br/>outbound only, no open ports"]
    CA["Caddy :8080<br/>basic auth<br/>/ → btop · /history → Netdata"]
    TT["btop + ttyd :7681<br/>read-only live terminal"]
    ND["Netdata :19999<br/>1 s metrics · 30-day local DB"]
    AL["Netdata health alarms"]
    RP["30-day report timer<br/>Python → SMTP"]
    TU --> CA
    CA --> TT
    CA --> ND
    ND --> AL
    ND --> RP
  end

  subgraph C["☁️ Vercel — cloud dashboard"]
    UI["Next.js pages<br/>Live · History · Reports · Settings"]
    API["Route handlers<br/>/api/live · /api/history · /api/cron/sync"]
    CR["Vercel Cron<br/>daily 00:15 UTC"]
    DB[("Neon Postgres<br/>samples · sync_runs · settings")]
    UI --> API
    CR --> API
    API --> DB
  end

  B --> UI
  B -. "btop at /" .-> TU
  API -- "HTTPS + basic auth" --> TU
  AL --> TG["📱 Telegram / email"]
  RP --> M["📬 Mailbox"]
```

**Key ideas**

1. **The server never accepts inbound connections.** The tunnel agent dials out; every request (browser or Vercel) arrives through it and must pass Caddy's login.
2. **Netdata is the single source of truth.** It keeps 30 days of per-second data on the server, so the dashboard can copy history once a day without missing anything.
3. **The browser never talks to the server.** All server calls run in Vercel route handlers, so credentials never reach the client.
4. **The two sides are independent.** Alerts and the monthly email run on the server and keep working if Vercel is down; the dashboard keeps its history if the server dies.

### Live data flow

```mermaid
sequenceDiagram
  participant B as Browser
  participant V as Vercel /api/live
  participant T as Tunnel
  participant N as Netdata
  loop Every 2 s (10 s in ngrok budget mode), only while the tab is visible
    B->>V: GET /api/live
    alt Snapshot younger than the refresh interval
      V-->>B: Shared cached snapshot
    else
      V->>T: GET /history/api/v1/allmetrics (basic auth)
      T->>N: Proxied by Caddy
      N-->>V: Latest values (JSON)
      V-->>B: Normalized KPIs
    end
  end
```

### Nightly history sync

```mermaid
sequenceDiagram
  participant C as Vercel Cron (00:15 UTC)
  participant S as /api/cron/sync
  participant N as Netdata (via tunnel)
  participant D as Neon Postgres
  C->>S: GET with Bearer CRON_SECRET
  loop Each tracked chart
    S->>N: /api/v1/data — last 26 h at 60 s
    N-->>S: About 1,560 rows
    S->>D: Batched upsert, ON CONFLICT DO NOTHING
  end
  S->>D: Roll up rows older than 30 days to hourly
  S->>D: Record the run in sync_runs
  opt Server unreachable for 1 day or more
    S-->>S: Email the owner once via SMTP
  end
```

---

## 🧰 Tech stack

### Server kit (Ubuntu 22.04 / 24.04)

| Layer              | Choice                                       | Why                                                                          | Alternative                |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------- |
| Metrics + local DB | **Netdata**                                  | Per-second metrics with zero config, tiered on-disk database, REST API       | Prometheus + node_exporter |
| Live terminal view | **btop** via **ttyd 1.7.7**                  | Best-looking live process view; ttyd is read-only by default                 | Glances web mode           |
| Login + routing    | **Caddy**                                    | One basic-auth login for `/` and `/history/`, separate user for the app      | Nginx                      |
| Public access      | **Tailscale Funnel** (default)               | Free, stable `*.ts.net` HTTPS URL, no open ports, no published request quota | ngrok free in budget mode  |
| Supervision        | **systemd** services + timers                | Starts at boot, restarts on crash                                            | Docker Compose             |
| Alerts             | **Netdata health alarms** → Telegram + email | Real-time, runs on the server                                                | ntfy.sh                    |
| Monthly email      | **Python 3** standard library                | Nothing to install, any SMTP                                                 | msmtp                      |

### Dashboard (Vercel)

| Layer                 | Choice                                    | Why                                                     | Alternative             |
| --------------------- | ----------------------------------------- | ------------------------------------------------------- | ----------------------- |
| Framework             | **Next.js** (App Router) + **TypeScript** | Pages and API routes in one repo, first-class on Vercel | Remix, SvelteKit        |
| UI                    | **Tailwind CSS** + **shadcn/ui**          | Fast, consistent, dark mode built in                    | Mantine                 |
| Charts                | **Recharts**                              | Sparklines and line charts up to a few thousand points  | Apache ECharts, uPlot   |
| Data fetching         | **TanStack Query**                        | Polling, pause on hidden tab, retries                   | SWR                     |
| Database              | **Neon Postgres** (Vercel Marketplace)    | Free tier, one-click connect, scales to zero            | Supabase                |
| ORM + migrations      | **Drizzle ORM** + drizzle-kit             | Typed SQL, migrations run at build                      | Prisma                  |
| Validation            | **Zod**                                   | Validates Netdata responses and API input               | Valibot                 |
| Auth                  | Signed httpOnly cookie (**jose**)         | Owner + viewer passwords, no user table                 | Auth.js                 |
| Scheduling            | **Vercel Cron** (daily)                   | Free on Hobby                                           | GitHub Actions schedule |
| Email (offline alert) | **Nodemailer** + Gmail App Password       | Free SMTP                                               | Resend free tier        |
| PWA                   | Web manifest + service worker             | Installable on Android and iPhone                       | —                       |
| CI/CD                 | **GitHub → Vercel** Git integration       | Every push to `main` deploys                            | Vercel CLI              |

---

## 💸 Free-tier budget

| Service               | Free limit                                                                                     | How Server Pulse stays inside it                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Vercel Hobby cron     | [Once per day, ±59 min](https://vercel.com/docs/cron-jobs/usage-and-pricing)                   | Nightly job pulls 26 h from Netdata's own 30-day store                                                       |
| Vercel functions      | Per-request time cap                                                                           | Backfill runs one chart per request; every route stays well under 60 s                                       |
| Tailscale Funnel      | Free on the Personal plan; unpublished bandwidth limits                                        | Only small JSON passes through it                                                                            |
| ngrok free            | [20,000 requests + 1 GB out per month](https://ngrok.com/docs/pricing-limits/free-plan-limits) | **Budget mode**: 10 s shared polling, usage meter, live view pauses at 80 % (≈ 54 h of live viewing a month) |
| Neon free             | [100 CU-hours + 0.5 GB per project](https://neon.com/pricing), suspends after 5 min idle       | Live view never touches the DB; hourly rollup keeps a year near 100 MB                                       |
| Telegram / Gmail SMTP | Free                                                                                           | Alerts fire only on state changes; offline email once per outage                                             |

> **Personal use.** Vercel Hobby and Tailscale Personal are for non-commercial use. For business use, keep ngrok budget mode for the tunnel and host the app on a commercial-friendly free tier (e.g. Cloudflare Workers via OpenNext).

---

## 📁 Project structure

```text
server-pulse/
├── app/
│   ├── login/page.tsx            # Password login (owner or viewer)
│   ├── page.tsx                  # Live
│   ├── history/page.tsx          # History charts 1h → 1y
│   ├── reports/page.tsx          # Monthly table
│   ├── settings/page.tsx         # Link, sync, backfill, usage (owner only)
│   ├── setup/page.tsx            # Public server setup guide (commands generated in the browser)
│   ├── signup/page.tsx           # Create an account
│   ├── connect/page.tsx          # Paste a server link → live data
│   └── api/
│       ├── live/route.ts         # One allmetrics call, shared cache
│       ├── history/route.ts      # Bucketed series (Postgres or Netdata)
│       ├── reports/route.ts      # Monthly aggregates
│       ├── backfill/route.ts     # 30-day import, one chart per call
│       ├── cron/sync/route.ts    # Nightly 26 h sync + rollup + offline email
│       ├── login/route.ts        # Account (email) or shared-password login
│       ├── signup/route.ts
│       ├── account/route.ts      # Change password, delete account
│       ├── logout/route.ts
│       └── settings/
│           ├── route.ts          # Everything the Settings page shows
│           ├── link/route.ts     # Save server link (masked)
│           └── test/route.ts     # Connection test
├── components/                   # Live view, history view, charts, sparkline, setup guide, polling hook
├── lib/
│   ├── netdata.ts                # The ONLY module that talks to the server
│   ├── config.ts                 # SERVER_URL parsing, tunnel detection, every limit
│   ├── charts.ts                 # Metric catalogue + derivation from Netdata dimensions
│   ├── algo.ts                   # Ring buffer, quickselect p95, single-flight cache, limiter
│   ├── session.ts                # Signed session cookies (used by proxy.ts, no DB)
│   ├── auth.ts                   # Route guards, account re-checks, rate limit
│   ├── accounts.ts               # Sign-up, login, change password, delete (atomic SQL)
│   ├── crypto.ts                 # scrypt hashes, AES-GCM link encryption, private-address check
│   ├── settings.ts               # Key/value settings + per-server link resolution
│   ├── history.ts                # Netdata vs Postgres routing, date_bin bucketing
│   ├── reports.ts                # Monthly aggregates
│   ├── sync.ts                   # Sync, backfill, rollup, offline email
│   ├── usage.ts                  # ngrok request meter (budget mode)
│   ├── mail.ts                   # Offline email (Nodemailer)
│   ├── demo.ts                   # Deterministic demo data
│   ├── *.test.ts                 # Unit tests (node --test)
│   └── db/
│       ├── schema.ts             # Drizzle schema
│       └── index.ts              # Neon client
├── drizzle/                      # Generated SQL migrations
├── scripts/
│   ├── migrate.mjs               # Runs migrations at build (skips without a DB)
│   └── btop-report.py            # 30-day email report (installed on the server)
├── docs/PRD.md                   # Product requirements + v1 implementation notes
├── proxy.ts                      # Protects every route except login, setup + cron
├── vercel.json                   # Cron schedule
├── .env.example
└── README.md
```

---

## 🚀 Quick start

**Fastest: Add server (one command, nothing to copy back)**

1. Deploy the dashboard to Vercel and connect Neon (Storage → Neon) so accounts work.
2. Create your account, open **Add server**, and copy the command it shows:
   ```bash
   curl -fsSL https://<your-dashboard>/install.sh | sudo bash -s -- ABCD-1234
   ```
3. Paste it on your Ubuntu server. The first time it shows a Tailscale login link; open it and approve the machine. Back in the dashboard, check the server name and click **Approve and connect**; the page then opens the live **Server** view.

Already use ngrok? Point it at `127.0.0.1:19998` (without `--basic-auth`) and add your address at the end of the command: `… ABCD-1234 https://your-name.ngrok-free.dev`.

**Without a database: one owner, configured by env var**

1. **Server**: install the agent by hand ([Part 1](#-part-1--server-agent-ubuntu)). It prints a link like `https://dashboard:PASS@pulse-myserver.tailnet-name.ts.net/history`.
2. **Dashboard**: click **Import** on [vercel.com/new](https://vercel.com/new), add that link as `SERVER_URL`, connect Neon, deploy ([Part 2](#-part-2--dashboard-vercel)).
3. **Open the site** and log in. The 30-day backfill starts by itself.

---

## 🖥️ Part 1 — Server agent (Ubuntu)

Everything on the server is one program, [`server-pulse-agent`](agent/README.md). It records the vitals every second, keeps 30 days of history, reads the system logs for failures and publishes all of it over one HTTPS address. Nothing else is installed: no Netdata, Caddy or btop. It never updates, upgrades or reboots the machine.

**With an account (recommended):** open **Add server** in the dashboard and paste the command it shows (see [Quick start](#-quick-start)).

**By hand:** see [agent/README.md](agent/README.md#set-up-by-hand-about-5-minutes). In short:

```bash
chmod +x server-pulse-agent-linux-amd64
sudo ./server-pulse-agent-linux-amd64 install            # prints the dashboard link
```

**How it reaches the internet**, first match wins:

1. an address you give (`--public-url https://…`, e.g. your own ngrok pointing at `127.0.0.1:19998`);
2. an ngrok that is already running for the agent;
3. Tailscale that is already installed and logged in on the machine (it turns on Funnel for the agent);
4. the address saved by an earlier install;
5. Tailscale built into the agent: the first run prints a login link.

The agent starts within a second of boot, restarts by itself within 2 seconds, and sets up a `server-pulse-ngrok` service when it finds ngrok so the tunnel comes back after a power cut.

Servers set up with the earlier Netdata + Caddy kit keep working with the same `SERVER_URL`.

## ☁️ Part 2 — Dashboard (Vercel)

### 2.1 Push to GitHub

```bash
git init && git add -A && git commit -m "Initial commit: Server Pulse"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/server-pulse.git
git push -u origin main
```

### 2.2 Deploy

1. Go to [vercel.com/new](https://vercel.com/new) → pick `server-pulse` → **Import**.
2. Under **Environment Variables** add `SERVER_URL` (the link from Part 1). Mark it **Sensitive**.
3. Click **Deploy**.
4. Open the project → **Storage** → **Create Database** → **Neon** → connect it to this project (adds `DATABASE_URL`).
5. **Deployments** → ⋯ on the latest → **Redeploy** (creates the tables).
6. Open your `*.vercel.app` URL and log in with the password inside `SERVER_URL`. The 30-day backfill starts on its own.

Every later `git push` to `main` redeploys automatically.

---

## 💻 Local development

```bash
npm install
npm run dev              # http://localhost:3000 — demo mode, password "demo"
```

Accounts and history locally, with an embedded Postgres (no Neon account needed):

```bash
DATABASE_URL=pglite:./.data npm run dev
```

Use real data locally:

```bash
npm i -g vercel
vercel link
vercel env pull .env.local
npm run dev
```

| Script                | What it does                                       |
| --------------------- | -------------------------------------------------- |
| `npm run dev`         | Start the dev server                               |
| `npm run build`       | Run migrations (if a DB is set), then `next build` |
| `npm run lint`        | ESLint                                             |
| `npm run typecheck`   | TypeScript, no emit                                |
| `npm test`            | Unit tests (Node's built-in runner, no extra deps) |
| `npm run db:generate` | Generate a migration from `lib/db/schema.ts`       |

---

## ⚙️ Configuration reference

| Variable                                                             | Required    | Default                      | Description                                                                                                                                                  |
| -------------------------------------------------------------------- | ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SERVER_URL`                                                         | ✅          | —                            | `https://USER:PASS@host` (root or `/history`). Alias: `NGROK_URL`. Can be overridden in Settings.                                                            |
| `DATABASE_URL`                                                       | Auto        | —                            | Added by the Neon integration (also reads `POSTGRES_URL`).                                                                                                   |
| `DASHBOARD_PASSWORD`                                                 | —           | Password inside `SERVER_URL` | Owner login.                                                                                                                                                 |
| `VIEWER_PASSWORD`                                                    | —           | Off                          | Read-only login: Live, History, Reports.                                                                                                                     |
| `SESSION_SECRET`                                                     | Recommended | Derived from other secrets   | Signs session cookies and encrypts saved server links. Set it before creating accounts and never change it.                                                  |
| `CRON_SECRET`                                                        | —           | Off                          | If set, `/api/cron/sync` requires `Authorization: Bearer …`. If unset, the job is throttled to once per 10 min.                                              |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_TO` | —           | Off                          | Enables the "server offline" email to `ALERT_EMAIL_TO` for the env-configured server. (Account addresses are not verified yet, so accounts are not emailed.) |
| `DISABLE_SIGNUP`                                                     | —           | Off                          | `1` stops new accounts being created.                                                                                                                        |
| `ALLOW_PRIVATE_LINKS`                                                | —           | Off                          | `1` lets accounts use links to private / LAN addresses (self-hosted dashboards only).                                                                        |

`vercel.json`:

```json
{
  "regions": ["bom1"],
  "crons": [{ "path": "/api/cron/sync", "schedule": "15 0 * * *" }]
}
```

`regions` decides where the API runs, which is the biggest factor in live latency: keep it near you and your server (`bom1` Mumbai, `sin1` Singapore, `fra1` Frankfurt, `iad1` US East), and create the Neon database in the matching region.

---

## 🕰️ How history works

| Stage                    | Where                 | Resolution | Kept for        |
| ------------------------ | --------------------- | ---------- | --------------- |
| Collected                | Netdata on the server | 1 s        | 30 days         |
| Backfill (first connect) | Neon                  | 5 min      | until rolled up |
| Nightly sync (last 26 h) | Neon                  | 1 min      | 30 days         |
| Rollup                   | Neon                  | 1 hour     | 1 year +        |

- The 26-hour window overlaps the previous run by 2 hours, covering Hobby cron's ±59-minute timing and occasional missed runs.
- If the dashboard is down for days, the next sync and a manual **Backfill** fill the gap from Netdata (up to 30 days back).
- History queries bucket with `date_bin` + `avg` to about 500 points per chart; ranges inside the last 24 h read Netdata directly for full detail.

**Tracked charts**

| Netdata chart                            | Shown as                  | Unit              |
| ---------------------------------------- | ------------------------- | ----------------- |
| `system.cpu`                             | CPU % (sum of dimensions) | %                 |
| `system.ram`                             | used ÷ total              | %, GiB            |
| `system.load`                            | load1 / load5 / load15    | —                 |
| `system.io`                              | read / write (abs)        | KiB/s             |
| `system.net`                             | in / out (abs)            | kbit/s, GB totals |
| `disk_space./` (fallback `disk_space._`) | used ÷ (used + avail)     | %, GiB            |
| context `sensors.temperature`            | hottest sensor            | °C                |

---

## 🗃️ Data model

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,              -- scrypt
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE servers (                       -- one per account in v1
  id            TEXT PRIMARY KEY,
  user_id       TEXT UNIQUE,
  link_enc      TEXT,                        -- AES-256-GCM encrypted server link
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at  TIMESTAMPTZ
);

CREATE TABLE samples (
  id            BIGSERIAL PRIMARY KEY,
  server_id     TEXT        NOT NULL DEFAULT 'env',  -- 'env' = the server set by SERVER_URL
  chart         TEXT        NOT NULL,        -- cpu | ram | load | io | net | disk | temp
  ts            TIMESTAMPTZ NOT NULL,
  values        JSONB       NOT NULL,        -- { "user": 3.1, "system": 1.2, ... }
  resolution_s  INT         NOT NULL,        -- 60, 300 or 3600
  UNIQUE (server_id, chart, ts, resolution_s) -- also serves every range scan
);

CREATE TABLE sync_runs (
  id             BIGSERIAL PRIMARY KEY,
  server_id      TEXT        NOT NULL DEFAULT 'env',
  kind           TEXT        NOT NULL DEFAULT 'sync',  -- sync | backfill
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ,
  rows_inserted  INT,
  status         TEXT,                       -- ok | partial | error | offline
  error          TEXT
);
CREATE INDEX sync_runs_server_started ON sync_runs (server_id, started_at DESC);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,                   -- per-server keys are prefixed "<server_id>:"
  value  TEXT NOT NULL
);
```

---

## 🔌 API reference

**App routes** (all require a session unless noted)

| Route                                         | Method        | Access                     | Purpose                                                                                                       |
| --------------------------------------------- | ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/api/login`, `/api/logout`                   | POST          | Public / session           | Start or end a session (`email` + `password` for accounts, `password` alone for the shared login)             |
| `/api/signup`                                 | POST          | Public                     | Create an account                                                                                             |
| `/api/account`                                | POST / DELETE | Account                    | Change password / delete account and its history                                                              |
| `/api/live`                                   | GET           | Owner, viewer              | Latest values; one shared server request per interval                                                         |
| `/api/history?from=&to=[&chart=]`             | GET           | Owner, viewer              | Bucketed series for every chart (or one), with gaps and their reasons, where monitoring started, and coverage |
| `/api/reports`                                | GET           | Owner, viewer              | 12 months of aggregates                                                                                       |
| `/api/backfill`                               | GET           | Owner                      | Is the dashboard behind the server?                                                                           |
| `/api/backfill`                               | POST          | Owner                      | One 40-s step of copying missing history from the server                                                      |
| `/api/settings`                               | GET           | Owner                      | Status for the Settings page                                                                                  |
| `/api/settings/link`, `/api/settings/test`    | POST          | Owner                      | Save / test the server link (`DELETE` on link reverts to `SERVER_URL`)                                        |
| `/api/logs?prio=&unit=&after=&since=&until=`  | GET           | Owner                      | Recent log lines (fallback when the browser can't reach the agent), or a past window oldest first, 500 a page |
| `/api/logs/token`                             | POST          | Owner                      | 60-s single-use token for the live log stream                                                                 |
| `/api/events?before=&severity=&since=&until=` | GET           | Owner                      | Failure history (newest first) and per-severity counts for the window                                         |
| `/api/agent/pair-approve`                     | POST          | Owner                      | Approve or reject a server that redeemed a pairing code                                                       |
| `/api/cron/sync`                              | GET           | `CRON_SECRET` or throttled | Nightly sync, rollup, offline check                                                                           |

**Netdata endpoints used** (server, read-only)

| Endpoint                                                                                   | Used for                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `GET /api/v1/info`                                                                         | Hostname, OS, cores, RAM, uptime, connection test |
| `GET /api/v1/allmetrics?format=json`                                                       | All live values in one call                       |
| `GET /api/v1/data?chart=&after=&before=&points=&group=average&format=json&options=seconds` | Seeding charts, sync, backfill                    |
| `GET /api/v1/charts`                                                                       | Discovering temperature and disk charts           |

Every server call sends basic auth from the link plus `ngrok-skip-browser-warning: 1`, and times out after 8 s.

---

## 🔔 Alerts

Netdata's built-in health alarms watch CPU, RAM, disk and temperature and notify you in real time — even when Vercel is down.

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Send your bot a message, then get your chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`.
3. Edit the notification config:

```bash
cd /etc/netdata && sudo ./edit-config health_alarm_notify.conf
```

Set:

```bash
SEND_TELEGRAM="YES"
TELEGRAM_BOT_TOKEN="CHANGE_ME_bot_token"
DEFAULT_RECIPIENT_TELEGRAM="CHANGE_ME_chat_id"
```

4. Send a test alert:

```bash
sudo su -s /bin/bash netdata -c '/usr/libexec/netdata/plugins.d/alarm-notify.sh test'
```

The dashboard also emails you once if the server has been unreachable for a day (set the `SMTP_*` variables in Vercel).

---

## 📬 30-day email report

Every 30 days the server emails a summary of the last 30 days plus a zip of CSVs (one row per 5 minutes).

<details>
<summary>1. SMTP settings (Gmail shown — use an <a href="https://myaccount.google.com/apppasswords">App Password</a>)</summary>

```bash
sudo tee /etc/btop-report.env > /dev/null <<'EOF'
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=CHANGE_ME@gmail.com
SMTP_PASS=CHANGE_ME_app_password
MAIL_FROM=CHANGE_ME@gmail.com
MAIL_TO=CHANGE_ME@gmail.com
EOF
sudo chmod 600 /etc/btop-report.env
```

</details>

<details>
<summary>2. Report script — <code>/usr/local/bin/btop-report.py</code></summary>

```bash
sudo tee /usr/local/bin/btop-report.py > /dev/null <<'EOF'
#!/usr/bin/env python3
"""Every 30 days: export the last 30 days from Netdata as CSV and email it via SMTP.
   --now  send immediately (test) without changing the 30-day countdown"""
import csv, io, os, sys, time, socket, ssl, smtplib, zipfile
import urllib.request, urllib.parse, urllib.error
from datetime import datetime
from email.message import EmailMessage

NETDATA = "http://127.0.0.1:19999"
DAYS = 30
POINTS = DAYS * 24 * 12              # one row per 5 minutes
ENV_FILE = "/etc/btop-report.env"
STAMP = "/var/lib/btop-report/last_sent"
CHARTS = {
    "cpu": ["system.cpu"],
    "ram": ["system.ram"],
    "load": ["system.load"],
    "disk_io": ["system.io"],
    "network": ["system.net"],
    "disk_space_root": ["disk_space./", "disk_space._"],
}

def load_env():
    cfg = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg

def fetch(chart):
    q = urllib.parse.urlencode({"chart": chart, "after": -DAYS * 86400, "points": POINTS,
                                "group": "average", "format": "csv"})
    with urllib.request.urlopen(f"{NETDATA}/api/v1/data?{q}", timeout=120) as r:
        return r.read().decode()

def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0

def parse(text):
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        return [], []
    head = [h.strip() for h in rows[0][1:]]
    data = [[num(x) for x in r[1:]] for r in rows[1:] if r]
    return head, data

def col(head, name):
    return head.index(name) if name in head else None

def summary(results):
    out = []
    def line(label, vals, unit="%", fmt="{:.1f}"):
        if vals:
            out.append(f"{label:<14} avg {fmt.format(sum(vals)/len(vals))} {unit:<3} peak {fmt.format(max(vals))} {unit}")
    if "cpu" in results:
        h, d = results["cpu"]; line("CPU usage", [sum(r) for r in d])
    if "ram" in results:
        h, d = results["ram"]; u = col(h, "used")
        if u is not None:
            line("RAM usage", [100 * r[u] / sum(r) for r in d if sum(r) > 0])
    if "load" in results:
        h, d = results["load"]; i = col(h, "load1")
        if i is not None:
            line("Load (1 min)", [r[i] for r in d], unit="", fmt="{:.2f}")
    if "network" in results:
        h, d = results["network"]
        if d:
            step = DAYS * 86400 / len(d)
            gb = lambda i: sum(abs(r[i]) for r in d) * step / 8 / 1024 / 1024 if i is not None else 0
            out.append(f"{'Network':<14} in {gb(col(h, 'received')):.1f} GB   out {gb(col(h, 'sent')):.1f} GB")
    if "disk_space_root" in results:
        h, d = results["disk_space_root"]; u, a = col(h, "used"), col(h, "avail")
        if u is not None and a is not None:
            vals = [100 * r[u] / (r[u] + r[a]) for r in d if r[u] + r[a] > 0]
            if vals:
                out.append(f"{'Disk / used':<14} peak {max(vals):.1f} %")
    return "\n".join(out)

def send(cfg):
    results, zbuf, skipped = {}, io.BytesIO(), []
    with zipfile.ZipFile(zbuf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, ids in CHARTS.items():
            for cid in ids:
                try:
                    text = fetch(cid)
                except urllib.error.URLError:
                    continue
                z.writestr(f"{name}.csv", text)
                results[name] = parse(text)
                break
            else:
                skipped.append(name)
    if not results:
        sys.exit("Netdata returned no data - is it running on 127.0.0.1:19999?")

    host = socket.gethostname()
    end = datetime.now()
    start = datetime.fromtimestamp(end.timestamp() - DAYS * 86400)
    period = f"{start:%Y-%m-%d} -> {end:%Y-%m-%d} ({DAYS} days)"
    body = f"Server: {host}   Period: {period}\n\n{summary(results)}\n\n"
    body += "Attached: CSV files, one row per 5 minutes (averages).\n"
    if skipped:
        body += f"Not available on this server: {', '.join(skipped)}\n"

    msg = EmailMessage()
    msg["Subject"] = f"[{host}] 30-day utilization report {start:%d %b} - {end:%d %b %Y}"
    msg["From"] = cfg["MAIL_FROM"]
    msg["To"] = cfg["MAIL_TO"]
    msg.set_content(body)
    msg.add_attachment(zbuf.getvalue(), maintype="application", subtype="zip",
                       filename=f"{host}-usage-{end:%Y-%m-%d}.zip")

    port = int(cfg.get("SMTP_PORT", "587"))
    ctx = ssl.create_default_context()
    if port == 465:
        s = smtplib.SMTP_SSL(cfg["SMTP_HOST"], port, context=ctx, timeout=60)
    else:
        s = smtplib.SMTP(cfg["SMTP_HOST"], port, timeout=60)
        s.starttls(context=ctx)
    s.login(cfg["SMTP_USER"], cfg["SMTP_PASS"])
    s.send_message(msg)
    s.quit()
    print(f"Report for {period} sent to {cfg['MAIL_TO']}")

def main():
    cfg = load_env()
    if "--now" in sys.argv:
        send(cfg)
        return
    os.makedirs(os.path.dirname(STAMP), exist_ok=True)
    now = time.time()
    if not os.path.exists(STAMP):
        open(STAMP, "w").write(str(now))
        print(f"30-day countdown started; first report on {datetime.fromtimestamp(now + DAYS*86400):%Y-%m-%d}")
        return
    last = num(open(STAMP).read().strip())
    if now - last < DAYS * 86400 - 3600:
        print(f"Next report in {(last + DAYS*86400 - now) / 86400:.1f} days")
        return
    send(cfg)
    open(STAMP, "w").write(str(now))

if __name__ == "__main__":
    main()
EOF
sudo chmod 755 /usr/local/bin/btop-report.py
```

</details>

<details>
<summary>3. Daily timer (sends only when 30 days have passed)</summary>

```bash
sudo tee /etc/systemd/system/btop-report.service > /dev/null <<'EOF'
[Unit]
Description=Email 30-day utilization report
After=network-online.target netdata.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/bin/btop-report.py
EOF

sudo tee /etc/systemd/system/btop-report.timer > /dev/null <<'EOF'
[Unit]
Description=Daily check for the 30-day utilization report

[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now btop-report.timer
sudo /usr/local/bin/btop-report.py --now     # send a test email now
```

</details>

---

## 🔒 Security

- **Read-only everywhere.** The agent's API only reads; the dashboard has no write path to the server.
- **Nothing listens publicly.** The agent binds to `127.0.0.1:19998`; only the outbound tunnel reaches it. It runs as its own locked-down user (`DynamicUser`, read-only system, 300 MB memory cap).
- **Pairing** codes work once for 10 minutes and only their SHA-256 is stored; nothing connects until you approve the server by name.
- **Secrets stay server-side.** `SERVER_URL` lives in Vercel as a Sensitive env var; it never appears in client bundles, logs or API responses, and is masked in Settings.
- **Sessions** are httpOnly, Secure, SameSite=Lax cookies; viewers get 403 on Settings, Sync and Backfill. Changing a password (account or env) signs out other devices.
- **Accounts** are isolated: every query is scoped to the session's server. Passwords use scrypt; saved links are AES-256-GCM encrypted.
- **SSRF guard**: links typed by accounts must be HTTPS; the address is checked inside the socket's own DNS lookup (no DNS-rebinding window), private/IPv6/mapped literals are refused, redirects are never followed and responses are size-capped.
- **Cron** is protected by `CRON_SECRET`, or throttled to once per 10 minutes when unset (the job is idempotent).

---

## 🩺 Troubleshooting

| Symptom                                                  | Fix                                                                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard says **Server offline**                        | On the server: `systemctl is-active server-pulse-agent` and `tailscale funnel status` (or `systemctl status server-pulse-ngrok`); in the dashboard, **Settings → Test connection** shows the exact error |
| Connection test returns **401**                          | The saved link's password is wrong: run the **Add server** command again (it keeps your history)                                                                                                         |
| **Offline after months** of working (Tailscale)          | The machine's key expired: in the Tailscale admin console choose **Disable key expiry** for the machine, then run the **Add server** command again                                                       |
| Offline whenever the **laptop sleeps** or the lid closes | The agent turns sleep off when it installs; if you installed with `--no-keep-awake`, run the **Add server** command again without it                                                                     |
| Live view **paused**                                     | ngrok budget mode hit 80 % of the monthly quota; switch to Tailscale Funnel or wait for the reset date shown in Settings                                                                                 |
| History is **empty**                                     | Database not connected: Vercel → Storage → Neon → Redeploy; then **Settings → Fill missing history** (or just keep a page open: it fills in by itself)                                                   |
| Sync shows **errors**                                    | Check `sync_runs` in Settings; the next nightly run re-fills the last 26 h                                                                                                                               |
| No **Telegram** alerts                                   | Re-check the bot token and chat ID; run the test command in [Alerts](#-alerts)                                                                                                                           |
| Report email **not sent**                                | `journalctl -u btop-report -n 30`; Gmail needs an App Password, not your normal password                                                                                                                 |

**Useful commands**

```bash
systemctl status btop-web netdata caddy --no-pager
journalctl -u caddy -u netdata -f
sudo du -sh /var/cache/netdata          # local history size
sudo /usr/local/bin/btop-report.py      # days until the next report
```

---

## 🗺️ Roadmap

- [x] Server kit: btop + ttyd, Netdata, Caddy, tunnel, systemd
- [x] 30-day email report
- [x] Dashboard MVP: one-link setup, login, demo mode, Live page
- [x] History + reports: Neon, nightly sync, backfill, rollup, Reports page
- [x] Alerts (Telegram + email), viewer password, installable PWA
- [x] One-command server setup (_Add server_)
- [x] Accounts, in-app connect (`/connect`), light/dark theme, responsive 320 px → 4K
- [ ] v2: several servers, one link each, server switcher

---

## 📄 License

MIT © MonoEdge Solutions Pvt Ltd

---

<div align="center">

Built with [Netdata](https://www.netdata.cloud) · [btop](https://github.com/aristocratos/btop) · [ttyd](https://github.com/tsl0922/ttyd) · [Caddy](https://caddyserver.com) · [Tailscale](https://tailscale.com) · [Next.js](https://nextjs.org) · [Neon](https://neon.com) · [Vercel](https://vercel.com)

</div>

# Server Pulse — Product Requirements Document

Oct 11, 2026 · @Tushar Saini

## Overview

Server Pulse lets one person watch an Ubuntu server's utilization live from anywhere and keep a permanent history of it, on free tiers, with the cloud dashboard set up by pasting one server link into Vercel.

**Problem.** btop shows excellent live data, but only in a terminal on the machine itself. There is no history, no remote view without opening router ports, and no monthly summary. Netdata records history, but only about 30 days, and only on the same machine — if the disk dies, the history goes with it.

**Product.** Two independent parts that talk over one HTTPS link:

- **Server kit** (on the Ubuntu box): btop live in the browser, the Netdata collector with a local 30-day database, Caddy for a single login, a free tunnel (Tailscale Funnel by default, or ngrok in budget mode), Telegram and email alerts, and a 30-day email report over SMTP.
- **Cloud dashboard** (on Vercel): a Next.js app that reads Netdata through the tunnel link, shows live charts, stores long-term history in Postgres, and produces monthly reports.

**Goals for v1**

| Goal | Target |
| --- | --- |
| Dashboard setup time | 10 minutes or less, one required env var (`SERVER_URL`) |
| Live view freshness | New reading on screen within 2 s (Funnel) or 10 s (ngrok budget mode) |
| History completeness | No data lost for server or dashboard outages shorter than 30 days |
| History retention | 1 year or more (1-minute detail for 30 days, hourly after) |
| Running cost | $0/month for one server, with every service inside its free tier |

**Non-goals for v1:** monitoring several servers, phone-call paging, controlling the server (killing processes, restarting services), multi-user accounts and roles, a native mobile app. Multi-server support is the first candidate for v2.

## Users and user stories

The primary user is a **solo server owner**: a developer, student or small-business admin running one Ubuntu machine (home server, VPS or office box) who wants to see its health from a phone or laptop without learning Grafana. A secondary user is a **viewer** — a teammate or client given the dashboard password to check uptime and load.

| ID | As a… | I want to… | So that… |
| --- | --- | --- | --- |
| US-1 | Owner | see CPU, RAM, disk, network and temperature live from my phone | I know right away if the server is struggling |
| US-2 | Owner | open the classic btop screen in a browser | I can see per-process detail the way I'm used to |
| US-3 | Owner | look at any past hour, day, week or month on a chart | I can find when and why a spike happened |
| US-4 | Owner | connect the dashboard by pasting one link | setup takes minutes, not an afternoon |
| US-5 | Owner | receive a 30-day usage report by email automatically | I have a record even if I never open the dashboard |
| US-6 | Owner | export any chart's data as CSV | I can analyse it in Excel or share it |
| US-7 | Owner | see month-by-month averages and peaks | I can decide when to upgrade the server |
| US-8 | Owner | change the server link from inside the app | a new ngrok domain doesn't need a redeploy |
| US-9 | Viewer | log in with one shared password and only view | I can check the server without risking changes |

## Architecture

&#91;embedded content: System architecture · server kit and cloud dashboard\]

The server never accepts inbound connections: the tunnel agent (Tailscale Funnel by default, or ngrok) dials out, and both the owner's browser and the Vercel API routes reach the server only through that one HTTPS link and Caddy's login. Netdata is the single source of truth — the dashboard reads it live every 2 s and copies it to Neon once a day, while the server's own timer emails a 30-day report independently of the cloud side.

## Recommended stack

The stack below is the best fit for one server on free tiers: every piece is free, widely used and replaceable without touching the other side.

**Server kit (Ubuntu 22.04 / 24.04)**

| Layer | Choice | Why | Alternative |
| --- | --- | --- | --- |
| Metrics collector + local DB | Netdata | Per-second metrics with no config, built-in tiered database (30 days at 1 s), REST API | Prometheus + node\_exporter |
| Live terminal view | btop via ttyd 1.7.7 | Best-looking live process view; ttyd is read-only by default | Glances web mode |
| Single login + routing | Caddy | Basic-auth login for `/` (btop) and `/history/` (Netdata); a second, read-only user just for the app | Nginx |
| Public access | **Tailscale Funnel** (default) | Free Personal plan, stable `ts.net` HTTPS URL, no open ports, no published request quota | ngrok free in budget mode (20,000 requests/month) |
| Alerts | Netdata health alarms → Telegram bot + email | Real-time, runs on the server, free | ntfy.sh push notifications |
| Process supervision | systemd services + timers | Starts at boot, restarts on crash, built into Ubuntu | Docker Compose |
| Monthly email | Python 3 standard library (`smtplib`) | Nothing to install; works with Gmail App Passwords or any SMTP | msmtp + shell script |

**Cloud dashboard (Vercel)**

| Layer | Choice | Why | Alternative |
| --- | --- | --- | --- |
| Framework | Next.js (App Router) + TypeScript | Pages and API routes in one repo, first-class on Vercel | Remix, SvelteKit |
| UI | Tailwind CSS + shadcn/ui | Fast, consistent, dark mode built in | Mantine |
| Charts | Recharts | Simple API, good for KPI sparklines and line charts up to a few thousand points | Apache ECharts (larger series), uPlot |
| Client data fetching | TanStack Query | Polling, pause on hidden tab, caching, retries | SWR |
| Database | Neon Postgres (Vercel Marketplace) | Free tier, one-click connect, serverless driver | Supabase Postgres |
| ORM + migrations | Drizzle ORM + drizzle-kit | Typed SQL, light, migrations run at build | Prisma |
| Validation | Zod | Validates Netdata responses and API inputs | Valibot |
| Auth | Signed httpOnly cookie (`jose`) + one password | No user table needed for a single owner | Auth.js |
| Scheduling | Vercel Cron (daily) | Free on Hobby; daily pull of 26 h fits the once-a-day limit | Pro plan cron, external scheduler |
| Source + deploys | GitHub → Vercel Git integration | Every push to `main` deploys; previews per branch | Vercel CLI |

## Functional requirements

P0 ships in v1 and blocks launch; P1 ships in v1 if time allows; P2 is planned for v2.

**Server kit**

| ID | Requirement | Priority | Acceptance criteria |
| --- | --- | --- | --- |
| SRV-1 | btop is served in the browser via ttyd, read-only, bound to localhost | P0 | `https://SERVER/` shows btop live after login; typing has no effect |
| SRV-2 | Netdata collects system metrics every second and keeps 30 days at full detail | P0 | `/api/v1/info` returns 200; per-second data is available 30 days back |
| SRV-3 | Caddy puts btop at `/` and Netdata at `/history/` behind basic-auth login | P0 | Wrong password returns 401 on both paths; right password opens both |
| SRV-4 | Tailscale Funnel exposes Caddy on a stable `ts.net` HTTPS URL; ngrok (free static domain) supported as an alternative | P0 | Same URL works after `sudo reboot` with no manual steps |
| SRV-5 | All parts run as systemd services that start at boot and restart on failure | P0 | `systemctl is-active` reports `active` for every service after reboot |
| SRV-6 | Every 30 days, email the last 30 days (summary + CSV zip) over SMTP | P1 | Test send with `--now` arrives; timer sends exactly once per 30 days |
| SRV-7 | One uninstall block removes everything | P1 | After running it, no service, binary or config file remains |
| SRV-8 | A second, read-only Caddy user exists only for the dashboard app | P0 | App works with its own credential; changing it doesn't affect the owner login |

**Cloud dashboard — setup and access**

| ID | Requirement | Priority | Acceptance criteria |
| --- | --- | --- | --- |
| APP-1 | One required env var, `SERVER_URL` (alias `NGROK_URL`), in the form `https://USER:PASS@host`; root or `/history` link both accepted; tunnel type detected from the host | P0 | Fresh deploy with only `SERVER_URL` + Neon shows real data |
| APP-2 | Demo mode with generated data when no link is configured | P0 | Local `npm run dev` with no env vars shows a working dashboard and a "Demo data" banner |
| APP-3 | Owner password login; defaults to the password inside the link, overridable by `DASHBOARD_PASSWORD` | P0 | Every page and API route except login and cron returns 401 or redirects without a session |
| APP-4 | Server link can be changed in Settings, stored in the database, masked on screen | P1 | New link takes effect without redeploy; password never shown or sent to the browser |
| APP-5 | Optional `VIEWER_PASSWORD` gives read-only access to Live, History and Reports | P1 | A viewer session gets 403 on Settings, Sync and Backfill |
| APP-6 | Installable PWA: manifest, icons, service worker caching the app shell | P1 | "Add to Home Screen" works on Android and iPhone; app opens full-screen |

**Cloud dashboard — live**

| ID | Requirement | Priority | Acceptance criteria |
| --- | --- | --- | --- |
| LIV-1 | KPI cards: CPU %, RAM %, load 1/5/15, disk used %, network in/out, hottest temperature, each with a 60 s sparkline | P0 | Values match Netdata within one refresh |
| LIV-2 | Live line charts for the last 5 minutes: CPU, RAM, disk I/O, network | P0 | Charts are seeded on load and update every refresh interval |
| LIV-3 | Polling pauses when the tab is hidden and resumes on focus | P0 | No requests are sent from a background tab |
| LIV-4 | Clear offline state with last-seen time when the server or link is unreachable | P0 | Stopping the tunnel shows "Server offline" within 10 s; no blank page |
| LIV-5 | ngrok budget mode: 10 s refresh, a monthly request meter in Settings, live view pauses at 80 % of 20,000 requests and shows when it resets | P0 | Simulated usage at 80 % pauses live; daily sync still runs |
| LIV-6 | One shared server request per refresh interval for all viewers (server-side cache of `/api/live`) | P0 | Two open tabs produce the same request count as one |

**Cloud dashboard — history, reports and storage**

| ID | Requirement | Priority | Acceptance criteria |
| --- | --- | --- | --- |
| HIS-1 | Daily sync copies the last 26 h at 1-minute resolution from Netdata into Postgres | P0 | Each run adds rows; re-running adds no duplicates |
| HIS-2 | Automatic 30-day backfill at 5-minute resolution on first connection, one chart per request, with progress | P0 | Empty database fills with 30 days without a function timeout |
| HIS-3 | History page with ranges 1h–1y and custom dates, \~500 points per chart, drag-to-zoom | P0 | A 30-day chart renders in under 1.5 s |
| HIS-4 | Avg / peak / p95 stats and CSV export for the visible range | P1 | Exported CSV matches the chart's points |
| HIS-5 | Rollup: rows older than 30 days become hourly averages | P0 | 1-minute rows older than 30 days are gone; hourly rows cover the same span |
| HIS-6 | Reports page: last 12 months of avg/peak CPU, RAM, load, network GB, peak disk | P1 | Clicking a month opens History for that month |
| HIS-7 | Settings: connection test, sync status, Sync now, Backfill, storage used, free-tier usage | P0 | Connection test shows the exact error text when it fails |
| HIS-8 | Netdata health alarms send Telegram and email alerts for CPU, RAM, disk and temperature thresholds | P1 | A forced test alarm reaches Telegram and the mailbox within 1 minute |
| HIS-9 | Several servers, each with its own link | P2 | Out of scope for v1 |
| HIS-10 | Daily cron emails the owner when the server has been unreachable for 1 day or more (optional `SMTP_*` env vars) | P1 | Stopping the tunnel for a day produces one email; no repeat until it recovers |

## Data model and API

The database is three tables; the samples table stores one row per chart per timestamp, with all of that chart's dimensions in one `jsonb` column, so new charts need no schema change.

**Database (Postgres on Neon)**

| Table | Columns | Keys and indexes |
| --- | --- | --- |
| `samples` | `id` bigserial, `chart` text, `ts` timestamptz, `values` jsonb (`{dim: number}`), `resolution_s` int (60, 300 or 3600) | Unique (`chart`, `ts`, `resolution_s`); index (`chart`, `ts` desc) |
| `sync_runs` | `id`, `started_at`, `finished_at`, `rows_inserted`, `status`, `error` | Index (`started_at` desc) |
| `settings` | `key` text, `value` text | Primary key `key` (holds the in-app server link) |

All writes are batched upserts with `ON CONFLICT DO NOTHING`. History queries bucket with `date_bin` and `avg` to about 500 points per chart, whatever mix of resolutions exists in the range.

**Charts tracked**

| Netdata chart | Shown as | Unit |
| --- | --- | --- |
| `system.cpu` | CPU % = sum of all dimensions | % |
| `system.ram` | RAM % = used ÷ sum of dimensions | % and GiB |
| `system.load` | load1, load5, load15 | load |
| `system.io` | disk read / write (write negative → abs) | KiB/s |
| `system.net` | received / sent (sent negative → abs) | kilobits/s, totals in GB |
| `disk_space./` (fallback `disk_space._`) | used ÷ (used + avail) | % and GiB |
| context `sensors.temperature` | hottest sensor | °C |

**Netdata endpoints used (server, read-only)**

| Endpoint | Used for |
| --- | --- |
| `GET /api/v1/info` | Hostname, OS, cores, RAM, uptime, connection test |
| `GET /api/v1/allmetrics?format=json` | Every live value in one call (2 s polling) |
| `GET /api/v1/data?chart=&after=&before=&points=&group=average&format=json&options=seconds` | Seeding live charts, daily sync, backfill, last-24 h detail |
| `GET /api/v1/charts` | Discovering temperature and disk charts |

Every call sends basic auth from the link and `ngrok-skip-browser-warning: 1`, times out after 8 s, and runs only on the server side.

**App routes**

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/login`, `/api/logout` | POST | Public / session | Start and end a session |
| `/api/live` | GET | Session | Latest values (one `allmetrics` call) |
| `/api/history?chart=&from=&to=` | GET | Session | Bucketed series from Postgres or Netdata (last 24 h) |
| `/api/reports` | GET | Session | Monthly aggregates for 12 months |
| `/api/cron/sync` | GET | `CRON_SECRET` or 10-min throttle | Daily 26 h sync + rollup |
| `/api/backfill?chart=` | POST | Session | 30-day import for one chart |
| `/api/settings/link`, `/api/settings/test` | POST | Session | Save and test the server link |

## Non-functional requirements

The hard limits come from the free tiers, so the design keeps traffic and function time small rather than paying to raise them.

| Area | Requirement |
| --- | --- |
| Performance | Live page first paint under 2 s on 4G; History query for 30 days under 1.5 s; server-side overhead of the kit under 5 % CPU on a 2-core machine |
| Security | Credentials only in env vars or the database, never in client bundles, logs or responses; every server-side service bound to `127.0.0.1`; all public traffic over HTTPS; read-only everywhere (no write or control path to the server) |
| Reliability | Services restart within 5 s of a crash; a missed daily sync is recovered by the next one (26 h window + 30 days on the server); the dashboard never shows a blank page when the server is offline |
| Data integrity | Idempotent upserts; timestamps stored in UTC and shown in the viewer's time zone |
| Accessibility | Colour is never the only signal (values and labels shown); keyboard-navigable; WCAG AA contrast in light and dark themes |
| Responsiveness | Fully usable at 360 px wide (phone) up to 4K |
| Maintainability | All Netdata access in one module (`lib/netdata.ts`); typed with Zod; build passes with no env vars |

**Free-tier limits the design respects**

| Service | Free limit | How the design stays inside it |
| --- | --- | --- |
| Vercel Hobby cron | [Once per day, ±59 min](https://vercel.com/docs/cron-jobs/usage-and-pricing) | Daily job pulls 26 h from Netdata's own 30-day store, so nothing is missed |
| Vercel functions | Execution-time cap per request | Backfill runs one chart per request; every route kept well under 60 s |
| Tailscale Funnel (default tunnel) | Free on the Personal plan; bandwidth limits exist but aren't published | Only small JSON goes through it (one shared live request per 2 s, \~10 sync requests a day) |
| ngrok free (alternative tunnel) | [20,000 requests and 1 GB out per month; 1 dev domain](https://ngrok.com/docs/pricing-limits/free-plan-limits) | Budget mode: 10 s shared polling, usage meter, live pauses at 80 %; one domain for everything via Caddy paths; warning page skipped with a header |
| Neon free | [100 CU-hours and 0.5 GB per project; suspends after 5 min idle](https://neon.com/pricing) | Live never touches the database; hourly rollup keeps a year near 100 MB |
| Alerts and email | Telegram bots and Gmail SMTP (App Password) are free | Alerts fire only on threshold changes; offline email sent once per outage |

## Success metrics

v1 is a success when the owner trusts the dashboard enough to stop SSH-ing in just to check load.

| Metric | Target | How it's measured |
| --- | --- | --- |
| Setup time, fresh repo to live data | ≤ 10 min | Timed run-through of the README |
| History coverage | ≥ 99 % of 1-minute buckets present for the last 30 days | SQL count of buckets vs expected |
| Sync success rate | ≥ 95 % of daily runs succeed | `sync_runs.status` |
| Live freshness | p95 age of the newest reading ≤ 4 s (Funnel) or ≤ 12 s (ngrok budget mode) | "Updated Xs ago" sampled on the Live page |
| Server overhead | Kit uses < 5 % CPU and < 300 MB RAM | Netdata's own per-app charts |
| Free-tier headroom | Every quota stays under 80 % each month | Free-tier usage panel in Settings |
| Monthly cost | $0 | Vercel, Neon, Tailscale and ngrok bills |

## Roadmap

&#91;embedded content: Roadmap · 4 phases, 3 gates\]

Each phase starts only when the gate before it passes. The MVP is useful on its own (live view from anywhere); history and reports build on it without changing the server kit.

## Risks and decisions (all resolved, all free)

Every risk below has a free fix built into v1. The biggest one is ngrok's free quota of [20,000 HTTP requests and 1 GB out per month](https://ngrok.com/docs/pricing-limits/free-plan-limits): live polling every 2 s would use it up in about 11 hours. It is solved by making Tailscale Funnel the default tunnel and adding a budget mode for anyone who stays on ngrok.

In ngrok budget mode, about 19,700 requests a month are left for live viewing after the daily sync. At one shared request every 10 s (360 an hour), that is roughly 54 hours of live viewing a month, or about 1 h 45 min a day.

| Risk | Free resolution | Covered by |
| --- | --- | --- |
| ngrok free quota (20,000 requests, 1 GB a month) runs out from live polling | **Default tunnel = Tailscale Funnel**: free Personal plan, stable `https://<machine>.<tailnet>.ts.net` URL, no published request quota. ngrok stays supported in **budget mode**: 10 s polling, one shared request per interval for all viewers, a usage meter, and live view pauses at 80 % of the quota so the daily sync always has room | SRV-4, LIV-5, LIV-6 |
| Tunnel URL or account changes | Link is editable in Settings with no redeploy; a Funnel URL is tied to the machine name, so it doesn't change on restart | APP-4 |
| Netdata's own UI breaks under `/history/` | The app uses only Netdata's REST API, which works under a path, so Netdata's UI isn't needed. If wanted, serve it on its own Funnel port (8443) at the root path | SRV-3 |
| Server off for more than 30 days leaves a gap | Daily cron sees the server is unreachable and emails the owner from Vercel after 1 day offline (nodemailer + Gmail App Password), long before Netdata's 30-day buffer runs out. Any gap that remains is shown as empty, not filled in | HIS-10 |
| Server credential leaks | A dedicated read-only Caddy user just for the app, separate from the owner's login; stored as a Sensitive env var in Vercel; can be rotated without touching the owner login; nothing on the server can be changed through it | SRV-8, APP-3 |
| Neon free compute (100 CU-hours a month, suspends after 5 min idle) | Only the daily sync and History/Reports views wake the database; the Live page never touches it. 100 CU-hours = 400 h at 0.25 CU, far above expected use | HIS-1, LIV-6 |
| Neon free storage (0.5 GB) fills up | Hourly rollup after 30 days keeps about a year of history near 100 MB (≈ 350k one-minute rows + ≈ 70k hourly rows a year) | HIS-5 |
| A free tier changes its limits | All limits live in one config file; tested free fallbacks: Supabase Free for the database, a GitHub Actions scheduled workflow as a second scheduler, ngrok budget mode for the tunnel | NFR |
| Personal-use terms: Vercel Hobby and Tailscale Personal are for non-commercial use | Fine for a personal server. For business use, keep ngrok budget mode as the tunnel and host the app on a commercial-friendly free tier (Cloudflare Workers via OpenNext) | — |

**Decisions (formerly open questions)**

| Question | Decision | Why it stays free |
| --- | --- | --- |
| Separate read-only password for viewers? | **Yes, in v1** (APP-5). Optional `VIEWER_PASSWORD`: viewers see Live, History and Reports; Settings, Sync and Backfill are owner-only | Two env vars, no user table or auth service |
| Installable app (PWA)? | **Yes, P1** (APP-6). Web manifest, icons and a service worker that caches the app shell; installs to the Android or iPhone home screen | No app store fees |
| Alerts: email, Telegram or WhatsApp? | **Telegram + email, moved into v1** (HIS-8), using Netdata's built-in health alarms on the server, so alerts are real-time and work even when Vercel is down. WhatsApp is excluded because its Business API charges per message | Telegram bots and Gmail SMTP cost nothing |


## v1 implementation (PR #1 — full app)

Oct 12, 2026. The whole v1 dashboard ships in one pull request. This section records what was built, what changed from the plan above, and the features added along the way.

**Status of requirements**

| Area | IDs | Status |
| --- | --- | --- |
| Setup and access | APP-1, APP-2, APP-3, APP-4, APP-5, APP-6 | Done |
| Live | LIV-1 to LIV-6 | Done |
| History, reports, storage | HIS-1 to HIS-7, HIS-10 | Done |
| Alerts | HIS-8 | Done via the server kit (Telegram + email through msmtp), generated by the new setup guide |
| Server kit | SRV-1 to SRV-8 | Done; SRV-7 uninstall block is on `/setup` |
| Multi-server | HIS-9 | v2, unchanged |

**Added features (not in the original PRD)**

| ID | Feature | Why |
| --- | --- | --- |
| NEW-1 | **In-app server setup guide** at `/setup` (public, no login). The owner picks passwords (generated with a cryptographic RNG), tunnel, optional Telegram and SMTP; the page builds every command, a "check it worked" command per step, a downloadable `server-pulse-setup.sh`, the final `SERVER_URL`, a troubleshooting table and the uninstall block. Everything runs in the browser; nothing typed is sent anywhere | Anyone can set up the server side without reading the README |
| NEW-2 | **Email alerts from Netdata** via `msmtp-mta`, configured by the setup guide alongside Telegram | Netdata email alarms need a local MTA; msmtp is the smallest one |
| NEW-3 | **"Open btop" button** on Live and Settings | One click from the dashboard to the per-process view (US-2) |
| NEW-4 | **Login rate limit**: 10 attempts per 15 min per IP, plus a fixed delay on a wrong password | The login is public; brute force must be slow |
| NEW-5 | **Security headers** (HSTS, nosniff, frame deny, same-origin referrer) | Free hardening |
| NEW-6 | **Sync runs log shows backfills too** (`sync_runs.kind`) | Settings shows one history of all import jobs |
| NEW-7 | `scripts/btop-report.py` in the repo (was only inside the README) | The setup guide downloads it from GitHub |

**Decisions made during the build**

| Topic | Decision | Reason |
| --- | --- | --- |
| Next.js 16 | `proxy.ts` replaces `middleware.ts` | `middleware` is deprecated in Next 16 |
| `samples.chart` | Stores the canonical metric key (`cpu`, `ram`, `load`, `io`, `net`, `disk`, `temp`) instead of the Netdata chart id | `disk_space./` vs `disk_space._` and per-machine temperature chart ids would otherwise split one metric across several keys |
| Indexes | Dropped the separate `(chart, ts)` index | The unique `(chart, ts, resolution_s)` index already serves every range scan; one index less to write and store |
| Backfill vs sync overlap | Backfill stops at the oldest 1-minute row of that metric | 5-minute and 1-minute rows never cover the same time, so network GB totals are never double-counted |
| Report averages | Weighted by `resolution_s` | Months that mix 1-minute and hourly rows are not skewed |
| Rollup | One atomic statement (`DELETE … RETURNING` → `INSERT … SELECT`), whole hours only | No window where rows are deleted but not yet rolled up; re-running is a no-op |
| History without a database | Ranges older than 24 h read Netdata's own 30 days | The dashboard is useful before Neon is connected |
| Settings link save | Allowed only when `SERVER_URL` or `DASHBOARD_PASSWORD` is set | Otherwise the public demo password could be used to point the app at a real server |
| Session secret | `SESSION_SECRET`, else derived from `DASHBOARD_PASSWORD` or the link | No extra required env var |
| shadcn/ui, TanStack Query | Not used | Plain Tailwind and a 50-line polling hook cover every need with less bundle and fewer dependencies |
| Sparklines | Inline SVG, no chart library | Thirty points do not need Recharts |
| ngrok meter | Counted per instance, flushed to Postgres every 10 requests | Live view does not touch the DB on every poll; it can under-read by a few requests when an instance is recycled |

**Algorithms and data structures**

| Where | Technique | Cost |
| --- | --- | --- |
| Live sparklines and 5-minute charts | Fixed-capacity ring buffer per metric | O(1) per reading, constant memory |
| `/api/live` shared cache (LIV-6) | TTL cache with single-flight: concurrent requests share one in-flight upstream call; failures are not cached | One Netdata request per interval regardless of viewers |
| p95 on History (HIS-4) | Iterative Hoare quickselect, median-of-three pivot | O(n) average, no full sort |
| Avg / min / peak | One pass | O(n) |
| History from Postgres (HIS-3) | `date_bin` + `avg` in SQL, linear pivot of ordered rows | Database does the aggregation; ≈500 points whatever the range |
| Temperature | Hash-map merge of all sensor series, max per timestamp | O(n) |
| Inserts | Chunked batched upserts, `ON CONFLICT DO NOTHING` | Idempotent; well below Postgres' parameter cap |
| Login limiter | Fixed-window counter map with amortised cleanup | O(1) per attempt |
| Generated passwords | Rejection sampling over `crypto.getRandomValues` | Uniform, no modulo bias |
| Demo data | Deterministic hash of the timestamp | Live, history and reports agree with each other |

**Verification done for this PR**

- Unit tests (`npm test`, Node's built-in runner): ring buffer, quickselect against a sort, stats, single-flight cache, limiter, metric derivation, link parsing, setup-script quoting (shell-injection case included). 13 / 13 pass.
- `tsc --noEmit`, ESLint (Next 16 + React compiler rules) and `next build` with no env vars: all clean.
- Demo mode in a browser: login, Live, History (30 days), setup guide at 375 px width with no horizontal scroll, no console errors.
- Real mode against a mock Netdata with the real API shapes: live snapshot, temperature discovery by context, disk fallback id, io dimension names, connection test with exact 401 / unreachable errors, masked link.
- Rollup, history bucketing and monthly report SQL executed on embedded Postgres (PGlite): rollup is atomic and idempotent, history returns exactly 500 buckets, report averages are correct.

**Known limits (tracked as `ponytail:` comments in code)**

- Login limiter and ngrok counter are per serverless instance. Upgrade path: Vercel WAF rate-limit rule; ngrok's usage API.
- ngrok's quota resets on its billing cycle; the meter resets on the calendar month (UTC).
- Not yet run against a live Neon database and a real Ubuntu box: first deploy is the end-to-end check.

### Update in the same PR: accounts, in-app connect, themes, responsive

Requested during the build and added to the same PR.

**Added features**

| ID | Feature | Notes |
| --- | --- | --- |
| NEW-8 | **Accounts**: sign up / log in with email + password, change password, delete account | scrypt password hashes; each account has its **own server link and its own history**, fully isolated; needs a database; `DISABLE_SIGNUP=1` closes sign-up |
| NEW-9 | **Connect in the app** (`/connect`): paste an ngrok / Tailscale / any HTTPS link, it is tested and saved, live data starts at once and the 30-day import runs in the background | No redeploy, no env var. Works for accounts and for the env-configured server (Settings) |
| NEW-10 | **Light / dark / system theme** switch in the header | Applied before first paint (no flash), remembered per browser |
| NEW-11 | **Responsive layout** from 320 px phones to 4K | Two-row header on phones, 1→2→3→6 column KPI grid, wider canvas on 4K, safe-area insets for notched phones; verified with no horizontal overflow on 8 pages × 6 widths |
| NEW-12 | KPI tiles open that metric's 24 h history; skeleton loading on Live | |
| NEW-13 | Local development with an embedded Postgres: `DATABASE_URL=pglite:./.data` | Accounts, sync and history work locally without a Neon account; never bundled into the Vercel build |

**Security decisions for accounts**

| Risk | Decision |
| --- | --- |
| Any account can make the app fetch a URL (SSRF) | Account links must be HTTPS. The address is validated inside the socket's DNS lookup, so the checked IP is the IP connected to (no DNS-rebinding window); IP literals (incl. bracketed / mapped IPv6) are checked directly. Loopback, RFC 1918, CGNAT, link-local / cloud metadata, multicast and IPv6 private ranges are blocked with Node's `net.BlockList`; redirects are never followed; responses are capped at 8 MB. `ALLOW_PRIVATE_LINKS=1` opts out for self-hosted LAN setups |
| Outbound mail abuse (unverified emails) | Offline emails go only to the owner-configured `ALERT_EMAIL_TO` (env server). Per-account alerts wait for email verification (v2) |
| Account re-check when the DB is briefly down | Uses this instance's last verified answer; never trusts an account it has not verified (fails closed) |
| Server links in the database | Encrypted with AES-256-GCM (key derived from `SESSION_SECRET`, else other server-only secrets) |
| Changed / removed passwords | Sessions carry a fingerprint of the credential: changing an account password or a shared env password signs out other devices |
| Brute force | Shared login + sign-up rate limit; equal work for unknown emails (dummy hash) |
| Partial writes | Sign-up (user + server) and account deletion (samples, runs, settings, server, user) are single atomic SQL statements |

**Data model change**: `users`, `servers` tables; `samples` and `sync_runs` gain `server_id` (`env` = the server configured by env vars). The unique key is now `(server_id, chart, ts, resolution_s)`. Per-server settings keys are prefixed `<server_id>:`.

**Review fixes** (independent code review of the first commit, all confirmed and fixed): open redirect on login (`/\evil.com`), sessions surviving a password change, live cache reusing an old link password, backfill and first sync double-counting traffic, offline email ~48 h late on Hobby cron, unescaped ngrok domain in the generated script, Tailscale's interactive login stalling the one-file script.

**Verification for the update**: 18 unit tests (adds password hashing, encryption tamper detection, private-address blocking, setup-script injection cases); end-to-end against embedded Postgres + mock Netdata: sign-up, duplicate / weak password, SSRF blocks (localhost, 169.254.169.254, plain http), env-server sync and backfill, account isolation, password change signs out the other device, account deletion; browser run of sign-up → connect → live, theme switch, and overflow check across 320 / 375 / 768 / 1024 / 1440 / 2560 px.

**Known limits**: account emails are not verified yet (an address can be registered by someone else; no account emails are sent); one server per account in v1 (schema ready for several); nightly job syncs ≈20–40 servers per run within the 60 s cap (least-recently-synced first, so none starve); account-session revocation reaches other serverless instances within 5 minutes.

### Update: smoothness and latency

Requested after v1: "no lag, no glitches, latency as low as possible".

| Area | Change | Measured |
| --- | --- | --- |
| Live charts | Custom SVG chart replaces Recharts on Live. React renders only when data arrives; each animation frame updates a single `transform` (GPU compositing, no layout), so lines scroll continuously instead of jumping every refresh | 60 fps over 6 s spanning 3 data refreshes: 361 frames, p99 17.0 ms, worst 17.2 ms, 0 frames > 34 ms |
| Curves | Monotone cubic interpolation (Fritsch–Carlson): smooth "waves" that never overshoot the data (no fake peaks, never below 0) | unit-tested |
| Y scale | Eases toward a "nice" maximum instead of jumping | — |
| Numbers | KPI values ease to each new reading (250 ms, written straight to the DOM, no re-render per frame) | — |
| Re-renders | "Updated N s ago" ticks in its own component; tiles and charts are memoized, so the page no longer re-renders every second | — |
| Page changes | Nav links fully prefetched; Live keeps its data in memory across pages (no skeleton, no re-seed on return); pending-link indicator if a page isn't ready yet | 0 skeleton frames returning to Live |
| History | Each chart updates as soon as its own data arrives; the previous range stays visible (dimmed) until replaced; LRU cache (O(1)) of fetched ranges; drag-to-zoom draws a lightweight overlay instead of re-rendering the 500-point chart | 0 blank frames on range switch, 52 ms back to a cached range, worst frame while dragging 16.9 ms |
| Latency: display | Zero added delay: the newest reading is drawn on arrival and the line holds its last value out to "now" (no one-interval buffering) | — |
| Latency: polling | Fixed-rate polling (next request due one interval after the previous *started*) | — |
| Latency: network | Proxy no longer runs in front of API routes (each route checks the session itself): one hop less per poll. `allmetrics` filtered to the 7 charts used (was every chart on the server). Caddy `encode zstd gzip` in the server kit. Vercel function region `bom1` (Mumbai) in `vercel.json` | — |

Recharts is now loaded only by the History page.

**Deployment note:** keep the Vercel region (`vercel.json → regions`) and the Neon region close to where you and your server are; `bom1` + Neon `aws-ap-south-1` for India. Change `bom1` to the nearest region elsewhere (e.g. `iad1`, `fra1`, `sin1`).

### Update: always-on (24/7) setup

| Gap | Fix |
| --- | --- |
| Tailscale machine keys expire after ~180 days by default, silently breaking the Funnel link | The setup guide's Tailscale step shows a "Needed for 24/7" callout to disable key expiry, with a check command; the downloadable script reminds you at the end; README + troubleshooting updated |
| A laptop or desktop that sleeps drops the tunnel and stops recording | New setup step "Keep the machine awake 24/7": masks sleep / suspend / hibernate targets and ignores the lid switch (logind drop-in, applied at the next reboot so a desktop session isn't killed). Included in the one-file script; undone by the uninstall block |
| Unclear what "24/7" means on ngrok | Documented: the tunnel itself is always up (systemd, free static domain); only the dashboard's live view is rationed by budget mode |

### Update: one-file server agent (`agent/`)

Requested: "a single file I start on Ubuntu that runs 24/7 in the background and publishes the analytics through Tailscale for the Vercel app to fetch".

| Decision | Choice | Why |
| --- | --- | --- |
| Data flow | **Pull**: the agent serves the stats, the dashboard fetches them | Live every 2 s and $0. Push would need hosted storage written every few seconds (Neon free compute can't stay awake 24/7) |
| Language / packaging | **Go**, one static binary per arch (linux amd64, arm64; ~22 MB) | No runtime or dependencies on the server |
| Public link | **Embedded Tailscale (`tsnet`) + Funnel** | No separate Tailscale install, no open ports; stable `https://<name>.<tailnet>.ts.net` |
| API | **Netdata-compatible subset** (`info`, `allmetrics` incl. `filter`, `data`, `charts`) at `/api/v1` and `/history/api/v1` | The existing dashboard works unchanged (verified) |
| Metrics | Read directly from `/proc` and `/sys` every second; physical disks and NICs only | Replaces Netdata for the 8 charts the dashboard uses |
| History | Two O(1) ring tiers: 1 s for 1 h, 1 min for 30 days (~9 MB); 30-day tier saved atomically every 5 min and on shutdown | Survives reboots; Netdata-style "30 days on the server" for the nightly sync and backfill |
| Service | `install` sets up systemd: `Restart=always`, `DynamicUser`, `ProtectSystem=strict`, `NoNewPrivileges`, config passed via `LoadCredential`; keeps the machine awake | 24/7 with least privilege |
| Releases | GitHub Actions builds, tests and attaches both binaries + `SHA256SUMS` to `agent-v*` tags | Download instead of build |

**Verified:** unit tests (parsers against real `/proc` text, CPU % math, rate math, ring buckets and gaps, minute roll-up, save/load, API auth, Netdata shapes, NaN→null, filter, 404, read-only) on Linux. On a real Ubuntu 24.04 (WSL): the agent served live metrics, and the **unchanged dashboard** read it (live, 5-minute history, connection test). `install` created the hardened service (dynamic user, root-only config), it came back 5 s after `SIGKILL`, history was saved on stop, and `uninstall --purge` removed everything.

**Not yet verified:** the Funnel connection itself (needs a Tailscale auth key from the owner's tailnet).

The classic server kit (Netdata + Caddy + tunnel) remains supported; the agent is the simpler path.

### Update: live server view (btop in the product) and "easy as possible" onboarding

Two design councils (UX/data-viz, systems/free-tier, security/ops; then onboarding, install/connectivity, product simplicity) reviewed the plan before it was built.

**Live server view (`/server`)**: per-core CPU heatmap (8×8 for 64 threads, Usage / Temperature toggle, absolute thermal thresholds, per-physical-core temps mapped through `core_id`), KPI tiles with 5-min sparklines, memory + swap, every real filesystem with usage and per-disk I/O, per-interface network, and a process table (top 25 by CPU, grouped by program, search, sort, order frozen while the pointer is over it). Streams **1 frame/s straight from the agent to the browser** (gzip NDJSON over `fetch`, 60-s single-use HMAC token in a header, CORS origin allow-list); falls back to a dashboard-side snapshot every 2 s when the browser can't reach the agent (e.g. ngrok's browser warning). Pauses 30 s after the tab is hidden, dims stale data, reconnects with backoff.

**Agent v2**: `/api/v1/pulse` (snapshot) and `/api/v1/pulse/stream`; one sampler fanned out to ≤ 8 viewers (≤ 3 per IP), latest-frame-wins, 5-s write deadline, 15-min sessions; 5 bad tokens/min → 10-min block; process scan reads only `stat`/`statm`, only while someone watches; command lines hidden by default (opt-in `--show-args` with a tested scrubber); `/agent/status` answered only to local requests.

**Pairing (no links, no passwords)**: *Add server* shows `curl -fsSL <dashboard>/install.sh | sudo bash -s -- CODE`. The code is 8 characters, valid 10 minutes, single use, stored only as a SHA-256. `install.sh` downloads the agent from GitHub Releases and **verifies its SHA-256** before running it. The agent installs itself, opens its Tailscale link (no auth key needed: it shows a Tailscale **login link** to approve the machine) or uses `--public-url` for ngrok, then registers its link with the dashboard. The link is tested before the code is spent; a single atomic `UPDATE` makes reuse impossible. The page follows along (Waiting → Connected → Live data) and opens the server view.

**No dead ends**: sign-up without a database shows a 3-step *Finish setup*; login no longer explains "the password inside your server link"; manual connect has **Address / Username / Password** fields; pasting a Tailscale auth key, invite link, ngrok token or btop address gets a plain explanation; connection errors say what is actually answering (a different login such as ngrok `--basic-auth`, a web page such as btop, or an ngrok error code).

**Decided not to do (yet)**: agent *push* to the dashboard (needs Upstash Redis + Vercel invocation budget, 30-s live start; planned as an option for servers that can't run a tunnel); removing the classic kit / env-var mode (kept, demoted to Advanced).

**Verified**: 17 Go tests on Linux (tokens, replay, tamper, scrubber, `/proc/[pid]/stat` parsing, mount filter, hyperthread temp mapping, end-to-end gzip stream with CORS and bad-token rejection, status locality, pairing client); 31 JS tests (incl. paste guard, link composer); end-to-end on Ubuntu 24.04 (WSL) + embedded Postgres: wrong code refused, wrong password reported while the code stays usable, pairing succeeds once and only once, live data flows, stream token + fallback work; browser: `/server` streams at "Live · 1 s", 60 fps (worst frame 17.1 ms), 64-core demo in dark mode, no console errors.

**Needs the owner**: make the GitHub repository public and push a tag `agent-v1.1.0` so the release workflow publishes the binaries the installer downloads.

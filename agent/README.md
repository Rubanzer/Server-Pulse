# server-pulse-agent

One file that runs 24/7 on your Ubuntu server, records its vitals every second, and publishes them over **Tailscale Funnel** for the Server Pulse dashboard to read. No Netdata, Caddy, ttyd or separate Tailscale install, and no open ports.

```text
Ubuntu server                                   Vercel
┌──────────────────────────────────┐          ┌───────────────────────┐
│ server-pulse-agent (systemd)     │          │ Server Pulse dashboard│
│  /proc, /sys every 1 s           │◀── HTTPS ┤ /api/live  every 2 s  │
│  1 h at 1 s · 30 days at 1 min   │  Funnel  │ nightly history sync  │
│  embedded Tailscale (tsnet)      │          └───────────────────────┘
└──────────────────────────────────┘
https://pulse-myserver.<tailnet>.ts.net  (basic auth, read-only)
```

## Easiest: Add server (one command)

In the dashboard open **Add server** and paste the command it shows on your server:

```bash
curl -fsSL https://<your-dashboard>/install.sh | sudo bash -s -- ABCD-1234
```

It downloads this agent from GitHub Releases, checks its SHA-256, installs it, shows a Tailscale login link the first time (no auth key needed), and connects itself to your dashboard. With your own tunnel (ngrok pointing at `127.0.0.1:19998`, no `--basic-auth`) add its address: `… ABCD-1234 https://name.ngrok-free.dev`.

The agent also streams the live **Server** view: `GET /api/v1/pulse/stream` (1 frame/s, gzip NDJSON, 60-s single-use token from the dashboard in the `Authorization` header) and `GET /api/v1/pulse` (one frame, basic auth). Process command lines are hidden unless you install with `--show-args`.

## Set up by hand (about 5 minutes)

**1. Prepare Tailscale (once, in the browser)**

1. Create a free account at [tailscale.com](https://tailscale.com).
2. [Admin console → DNS](https://login.tailscale.com/admin/dns) → **Enable HTTPS**.
3. [Admin console → Settings → Keys](https://login.tailscale.com/admin/settings/keys) → **Generate auth key** (defaults are fine). Copy the `tskey-auth-…` value.

Funnel is allowed by the default policy of new tailnets. If yours was customised, add this to [Access controls](https://login.tailscale.com/admin/acls):

```json
"nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]
```

**2. Install on the server**

Use `amd64` for most servers and `arm64` for Raspberry Pi / Ampere (`uname -m` prints `x86_64` or `aarch64`).

```bash
# copy the file to the server first, e.g.:  scp server-pulse-agent-linux-amd64 you@server:~
chmod +x server-pulse-agent-linux-amd64
sudo ./server-pulse-agent-linux-amd64 install --authkey tskey-auth-PASTE_YOURS
```

It installs itself, starts at boot, restarts on crash, turns off sleep, and prints:

```text
  ✓ Server Pulse agent is running and online.

  Paste this link in the dashboard (Connect, or SERVER_URL in Vercel):

      https://dashboard:Xk3…@pulse-myserver.tail1234.ts.net/history
```

**3. Make it 24/7.** In [Machines](https://login.tailscale.com/admin/machines) open **⋯** next to the new machine → **Disable key expiry**. Otherwise the link stops working after about 180 days.

**4. Connect the dashboard.** Paste the link on **Connect** (accounts) or set it as `SERVER_URL` in Vercel.

## Everyday commands

| Command | What it does |
| --- | --- |
| `server-pulse-agent status` | Service state, tunnel state, the public address, and the exact problem if it's offline |
| `sudo server-pulse-agent link` | Print the dashboard link again (includes the password) |
| `sudo server-pulse-agent install --name NAME` | Re-install / update in place (keeps the password and history); `--name` changes the address |
| `sudo server-pulse-agent uninstall [--purge]` | Remove it; `--purge` also deletes history and the Tailscale identity |
| `journalctl -u server-pulse-agent -f` | Live log |

Updating: copy the new file over and run `install` again. The password, history and Tailscale identity are kept.

## What it measures

The agent speaks the same API as Netdata (`/api/v1/info`, `allmetrics`, `data`, `charts`), so the dashboard needs no changes.

| Chart | Source | Unit |
| --- | --- | --- |
| `system.cpu` | `/proc/stat` (user, system, nice, iowait, irq, softirq, steal) | % |
| `system.ram` | `/proc/meminfo` (free, used, cached, buffers) | MiB |
| `system.load` | `/proc/loadavg` | load |
| `system.io` | `/proc/diskstats`, physical disks only | KiB/s |
| `system.net` | `/proc/net/dev`, physical interfaces only | kbit/s |
| `disk_space._` | `statfs("/")` | GiB |
| `sensors.temperature` | `/sys/class/hwmon` (or thermal zones) | °C |
| `system.uptime` | `/proc/uptime` | s |

History: 1-second detail for the last hour and 1-minute averages for 30 days, about 9 MB in memory. The 30-day tier is saved to `/var/lib/private/server-pulse/history.gob` every 5 minutes and on shutdown, so reboots keep it.

## Security

- Read-only: every request needs the `dashboard` password (constant-time check), and only `GET` is allowed.
- No inbound ports. Funnel dials out, and the local API listens on `127.0.0.1:19998` only.
- The service runs as a throwaway user (`DynamicUser`) with a read-only system (`ProtectSystem=strict`), no home access and `NoNewPrivileges`. The config (password, auth key) is root-only and handed to the service as a systemd credential.
- `--no-tunnel` skips Tailscale and serves only on `127.0.0.1:19998`, if you bring your own tunnel or reverse proxy.

## Troubleshooting

`server-pulse-agent status` shows the exact problem.

| Problem says | Fix |
| --- | --- |
| `… Enable HTTPS` | Admin console → DNS → Enable HTTPS |
| `… allow Funnel` | Add the `nodeAttrs` rule above in Access controls |
| `could not log in to Tailscale in time` | The auth key is expired or was single-use and already used: generate a new one and run `install --authkey …` again |
| Works, then stops after months | Key expiry: disable it for the machine (step 3) |

## Build from source

```bash
cd agent
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=1.0.0" -o server-pulse-agent-linux-amd64 .
go test ./...   # on Linux
```

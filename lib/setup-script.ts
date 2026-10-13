// Builds the server-kit install steps from the owner's choices. Pure, runs in the browser:
// passwords typed on /setup never leave the page.

export type SetupInput = {
  ownerPass: string;
  appPass: string;
  tunnel: "tailscale" | "ngrok";
  ngrokToken: string;
  ngrokDomain: string;
  telegramToken: string;
  telegramChat: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPass: string;
  mailTo: string;
};

export type Step = {
  id: string;
  title: string;
  why: string;
  script: string;
  verify?: string;
  optional?: boolean;
  /** Something to do outside the terminal (shown as a highlighted callout). */
  note?: string;
};

/** A plain DNS name: safe to place unquoted in the generated script. */
export const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Letters and digits only: they go inside a URL later and must survive shell quoting. */
export const SAFE_PASSWORD = /^[A-Za-z0-9]{12,128}$/;

export function randomPassword(len = 24): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const out: string[] = [];
  const buf = new Uint8Array(len * 2);
  crypto.getRandomValues(buf);
  // rejection sampling keeps every character equally likely (no modulo bias)
  for (const b of buf) {
    if (out.length === len) break;
    if (b < 256 - (256 % abc.length)) out.push(abc[b % abc.length]!);
  }
  return out.length === len ? out.join("") : randomPassword(len);
}

/** Single-quote for bash: safe for any input. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function serverLink(i: SetupInput, host: string) {
  return `https://dashboard:${i.appPass}@${host || "YOUR-HOST"}/history`;
}

export function buildSteps(i: SetupInput): Step[] {
  // only a validated host name ever reaches the unquoted heredoc below
  const ngrokDomain = HOST.test(i.ngrokDomain) ? i.ngrokDomain : "YOUR-DOMAIN.ngrok-free.app";
  const mail = !!(i.smtpHost && i.smtpUser && i.smtpPass && i.mailTo);
  const steps: Step[] = [
    {
      id: "btop",
      title: "Install btop and serve it in the browser",
      why: "ttyd shows btop as a read-only web page on localhost. Nothing is exposed yet.",
      script: `sudo apt update && sudo apt install -y btop curl wget
sudo wget -qO /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.$(uname -m)"
sudo chmod +x /usr/local/bin/ttyd

sudo tee /etc/systemd/system/btop-web.service > /dev/null <<EOF
[Unit]
Description=btop live in browser (ttyd)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
Environment=TERM=xterm-256color
ExecStart=/usr/local/bin/ttyd -p 7681 -i lo -t titleFixed=btop-live -t fontSize=14 -t disableLeaveAlert=true btop
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload && sudo systemctl enable --now btop-web`,
      verify: `systemctl is-active btop-web   # → active`,
    },
    {
      id: "netdata",
      title: "Install Netdata with a 30-day local history",
      why: "Netdata records every metric each second and keeps 30 days on disk. The dashboard reads it through its API.",
      script: `wget -qO /tmp/netdata-kickstart.sh https://get.netdata.cloud/kickstart.sh
sh /tmp/netdata-kickstart.sh --stable-channel --disable-telemetry --non-interactive

sudo tee -a /etc/netdata/netdata.conf > /dev/null <<'EOF'

[web]
    bind to = 127.0.0.1

[db]
    mode = dbengine
    dbengine tier 0 retention time = 30d
EOF

sudo systemctl restart netdata`,
      verify: `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:19999/api/v1/info   # → 200`,
    },
    {
      id: "caddy",
      title: "Put one login in front of both",
      why: "Caddy asks for a password before showing anything. You log in as owner; the dashboard uses its own dashboard user, so either password can change without touching the other.",
      script: `sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
sudo apt update && sudo apt install -y caddy

OWNER_HASH=$(caddy hash-password --plaintext ${q(i.ownerPass)})
APP_HASH=$(caddy hash-password --plaintext ${q(i.appPass)})

sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
:8080 {
    bind 127.0.0.1
    encode zstd gzip
    basic_auth {
        owner \${OWNER_HASH}
        dashboard \${APP_HASH}
    }
    redir /history /history/
    handle_path /history/* {
        reverse_proxy 127.0.0.1:19999
    }
    handle {
        reverse_proxy 127.0.0.1:7681
    }
}
EOF

caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy && sudo systemctl restart caddy`,
      verify: `curl -s -o /dev/null -w '%{http_code}\\n' -u dashboard:${q(i.appPass)} http://127.0.0.1:8080/history/api/v1/info   # → 200`,
    },
  ];

  if (i.tunnel === "tailscale") {
    steps.push({
      id: "tunnel",
      title: "Open a private HTTPS link with Tailscale Funnel",
      why: "Funnel gives the server a fixed https://<machine>.<tailnet>.ts.net address. The server only dials out, so no router ports are opened.",
      script: `curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up              # open the login link it prints
sudo tailscale funnel --bg 8080  # first time: open the link it prints to enable HTTPS + Funnel, then run it again
tailscale funnel status        # shows your https://….ts.net address`,
      note: "Turn off key expiry, or the link stops working after about 180 days: in the Tailscale admin console open Machines → ⋯ next to this server → Disable key expiry.",
      verify: `tailscale funnel status
tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"].get("KeyExpiry") or "key expiry disabled ✓")'`,
    });
  } else {
    steps.push({
      id: "tunnel",
      title: "Open a public HTTPS link with ngrok",
      why: "ngrok's free plan allows 20,000 requests a month, so the dashboard switches to budget mode: it refreshes every 10 s and pauses live view at 80% of the quota.",
      script: `curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc > /dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" | sudo tee /etc/apt/sources.list.d/ngrok.list > /dev/null
sudo apt update && sudo apt install -y ngrok
ngrok config add-authtoken ${q(i.ngrokToken || "PASTE_YOUR_NGROK_AUTHTOKEN")}

sudo tee /etc/systemd/system/ngrok-pulse.service > /dev/null <<EOF
[Unit]
Description=ngrok tunnel for Server Pulse
After=network-online.target caddy.service
Wants=network-online.target

[Service]
User=$USER
ExecStart=$(command -v ngrok) http 8080 --url=https://${ngrokDomain} --log=stdout
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload && sudo systemctl enable --now ngrok-pulse`,
      verify: `systemctl is-active ngrok-pulse   # → active`,
    });
  }

  if (i.telegramToken && i.telegramChat) {
    steps.push({
      id: "telegram",
      title: "Send alerts to Telegram",
      why: "Netdata's built-in alarms for CPU, RAM, disk and temperature message you the moment a threshold is crossed. This runs on the server, so it works even if the dashboard is down.",
      optional: true,
      script: `sudo tee -a /etc/netdata/health_alarm_notify.conf > /dev/null <<'EOF'
SEND_TELEGRAM="YES"
TELEGRAM_BOT_TOKEN=${q(i.telegramToken)}
DEFAULT_RECIPIENT_TELEGRAM=${q(i.telegramChat)}
EOF
sudo systemctl restart netdata`,
      verify: `sudo su -s /bin/bash netdata -c '/usr/libexec/netdata/plugins.d/alarm-notify.sh test'`,
    });
  }

  if (mail) {
    const port = i.smtpPort || "587";
    steps.push({
      id: "mail",
      title: "Email alerts and a 30-day usage report",
      why: "msmtp lets Netdata email alerts through your SMTP account. A daily timer emails a summary plus CSVs every 30 days.",
      optional: true,
      script: `sudo apt install -y msmtp msmtp-mta python3
sudo tee /etc/msmtprc > /dev/null <<'EOF'
defaults
auth on
tls on
tls_trust_file /etc/ssl/certs/ca-certificates.crt
${port === "465" ? "tls_starttls off\n" : ""}account default
host ${i.smtpHost}
port ${port}
user ${i.smtpUser}
password ${i.smtpPass}
from ${i.smtpUser}
EOF
sudo chown root:netdata /etc/msmtprc && sudo chmod 640 /etc/msmtprc

sudo tee -a /etc/netdata/health_alarm_notify.conf > /dev/null <<'EOF'
SEND_EMAIL="YES"
DEFAULT_RECIPIENT_EMAIL=${q(i.mailTo)}
EOF
sudo systemctl restart netdata

sudo tee /etc/btop-report.env > /dev/null <<'EOF'
SMTP_HOST=${i.smtpHost}
SMTP_PORT=${port}
SMTP_USER=${i.smtpUser}
SMTP_PASS=${i.smtpPass}
MAIL_FROM=${i.smtpUser}
MAIL_TO=${i.mailTo}
EOF
sudo chmod 600 /etc/btop-report.env

sudo curl -fsSL -o /usr/local/bin/btop-report.py https://raw.githubusercontent.com/Rubanzer/Server-Pulse/main/scripts/btop-report.py
sudo chmod 755 /usr/local/bin/btop-report.py

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

sudo systemctl daemon-reload && sudo systemctl enable --now btop-report.timer`,
      verify: `sudo /usr/local/bin/btop-report.py --now   # sends a test report now`,
    });
  }

  steps.push({
    id: "awake",
    title: "Keep the machine awake 24/7",
    why: "A server that sleeps drops the tunnel and stops recording. This turns off sleep, suspend and hibernate, and stops a closed laptop lid from suspending. Harmless on a VPS.",
    script: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo mkdir -p /etc/systemd/logind.conf.d
sudo tee /etc/systemd/logind.conf.d/server-pulse.conf > /dev/null <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
# the lid setting applies the next time the machine starts; the masked sleep targets above already keep it awake`,
    verify: `systemctl is-enabled sleep.target suspend.target   # both → masked`,
  });

  steps.push({
    id: "verify",
    title: "Check everything is running",
    why: "Every part runs as a systemd service that starts by itself with the machine, so the same link keeps working with no manual steps.",
    script: `systemctl is-active btop-web netdata caddy${i.tunnel === "ngrok" ? " ngrok-pulse" : ""}
systemctl is-enabled btop-web netdata caddy${i.tunnel === "ngrok" ? " ngrok-pulse" : ""}`,
    verify: `systemctl is-enabled btop-web netdata caddy${i.tunnel === "ngrok" ? " ngrok-pulse" : ""}   # all → enabled (they start with the machine)`,
  });
  return steps;
}

/**
 * Everything in one file, stopping at the first failure. Tailscale's login and Funnel approval open links in
 * a browser and wait, so for Tailscale the script installs it and prints the two commands to run by hand.
 */
export function fullScript(i: SetupInput): string {
  const tailscale = i.tunnel === "tailscale";
  const body = buildSteps(i)
    .filter((s) => s.id !== "verify" && !(tailscale && s.id === "tunnel"))
    .map((s) => `# ---- ${s.title} ----\n${s.script}`)
    .join("\n\n");
  return `#!/usr/bin/env bash
# Server Pulse — server kit installer. Generated in your browser; contains your passwords, keep it private.
# Run as your normal sudo user on Ubuntu 22.04 / 24.04:  bash server-pulse-setup.sh
set -euo pipefail

${body}
${tailscale ? TAILSCALE_INSTALL : ""}
echo
echo "Done. Services:"
systemctl is-active btop-web netdata caddy || true
${tailscale ? TAILSCALE_FINISH : ""}`;
}

const TAILSCALE_INSTALL = `
# ---- Tailscale (finish by hand: it opens login links) ----
curl -fsSL https://tailscale.com/install.sh | sh
`;

const TAILSCALE_FINISH = `echo
echo "Last step, run these two and open the links they print:"
echo "  sudo tailscale up"
echo "  sudo tailscale funnel --bg 8080"
echo "Then, for 24/7: Tailscale admin console > Machines > this server > Disable key expiry"
echo "(otherwise the link stops working after about 180 days)."
`;

export const UNINSTALL = `sudo systemctl disable --now btop-web caddy netdata btop-report.timer ngrok-pulse 2>/dev/null || true
sudo tailscale funnel reset 2>/dev/null || true
sudo rm -f /etc/systemd/system/btop-web.service /etc/systemd/system/ngrok-pulse.service \\
  /etc/systemd/system/btop-report.service /etc/systemd/system/btop-report.timer \\
  /usr/local/bin/ttyd /usr/local/bin/btop-report.py /etc/btop-report.env /etc/msmtprc
sudo rm -rf /var/lib/btop-report /etc/systemd/logind.conf.d/server-pulse.conf
sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo systemctl daemon-reload
sudo apt purge -y caddy ngrok msmtp msmtp-mta 2>/dev/null || true
[ -x /usr/libexec/netdata/netdata-uninstaller.sh ] && sudo /usr/libexec/netdata/netdata-uninstaller.sh --yes --force || sudo apt purge -y netdata`;

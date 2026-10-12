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

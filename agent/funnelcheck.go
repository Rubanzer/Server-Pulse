package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Self-healing Funnel. When the agent is published through this machine's own Tailscale, the public
// address depends on a Funnel setting kept by tailscaled. If that setting disappears (`tailscale serve
// reset`, `tailscale up --reset`, a Tailscale reinstall…) nothing would notice and the dashboard would just
// see the connection cut. A root timer checks it every 10 minutes:
//   - the agent's Funnel is missing and its port is free → turn it on again (never takes a port that
//     another service uses);
//   - the public address doesn't reach the agent → an error line in the system journal, which the agent's
//     failure watcher turns into an entry on the Failures page.
// It never restarts, updates or reconfigures anything else.

const (
	funnelCheckName  = "server-pulse-funnel"
	funnelCheckSvc   = "/etc/systemd/system/" + funnelCheckName + ".service"
	funnelCheckTimer = "/etc/systemd/system/" + funnelCheckName + ".timer"
)

func funnelCheckUnits() (svc, timer string) {
	svc = `[Unit]
Description=Server Pulse: keep the agent's Tailscale Funnel in place
After=tailscaled.service

[Service]
Type=oneshot
ExecStart=` + binPath + ` funnel-check
TimeoutStartSec=120
# root only for the tailscale CLI: a fixed PATH and nothing else it needs
Environment=PATH=/usr/sbin:/usr/bin:/sbin:/bin
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
`
	timer = `[Unit]
Description=Server Pulse: check the agent's Tailscale Funnel every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
`
	return
}

func setupFunnelCheck() {
	// it runs the agent binary as root on a schedule: only if nobody else can replace that file
	if !rootOwnedPath(binPath) {
		fmt.Println("  ! Not adding the Funnel watchdog: " + binPath + " or its folder can be changed by other users.")
		return
	}
	svc, timer := funnelCheckUnits()
	if os.WriteFile(funnelCheckSvc, []byte(svc), 0o644) != nil || os.WriteFile(funnelCheckTimer, []byte(timer), 0o644) != nil {
		return
	}
	run("systemctl", "daemon-reload")
	if run("systemctl", "enable", "--now", funnelCheckName+".timer") == nil {
		step("Funnel watchdog on: it turns the agent's Funnel on again if it ever disappears (to turn it off: sudo systemctl disable --now " + funnelCheckName + ".timer)")
	}
}

func removeFunnelCheck() {
	_, errT := os.Stat(funnelCheckTimer)
	_, errS := os.Stat(funnelCheckSvc)
	if errT != nil && errS != nil {
		return
	}
	stopFunnelCheck()
	run("systemctl", "disable", funnelCheckName+".timer")
	os.Remove(funnelCheckTimer)
	os.Remove(funnelCheckSvc)
	run("systemctl", "daemon-reload")
}

// stopFunnelCheck stops the timer and any check in progress, so it can't put a Funnel back while the
// installer or uninstall is changing it.
func stopFunnelCheck() {
	if _, err := os.Stat(funnelCheckSvc); err == nil {
		run("systemctl", "stop", funnelCheckName+".timer", funnelCheckName+".service")
	}
}

// funnelOn: is the agent served on exactly this port, and is the port free for it?
func funnelOn(serveJSON []byte, host string, port int) (served, free bool) {
	var sc struct {
		TCP map[string]json.RawMessage `json:"TCP"`
		Web map[string]struct {
			Handlers map[string]struct {
				Proxy string `json:"Proxy"`
			} `json:"Handlers"`
		} `json:"Web"`
	}
	_ = json.Unmarshal(serveJSON, &sc)
	if w, ok := sc.Web[host+":"+strconv.Itoa(port)]; ok {
		for _, h := range w.Handlers {
			if p := strings.TrimSuffix(h.Proxy, "/"); p == agentTarget || p == "http://localhost:19998" {
				return true, false
			}
		}
	}
	_, used := sc.TCP[strconv.Itoa(port)]
	return false, !used
}

// journal priorities understood by systemd on stdout (sd-daemon prefixes)
const (
	prioErr    = "<3>"
	prioNotice = "<5>"
)

// cmdFunnelCheck is what the timer runs (as root). Quiet when all is well.
func cmdFunnelCheck() error {
	cfg, err := loadConfig(configPath)
	if err != nil || cfg.FunnelPort == 0 || cfg.PublicURL == "" {
		return nil // not published through this machine's Tailscale: nothing to look after
	}
	if _, err := exec.LookPath("tailscale"); err != nil {
		fmt.Println(prioErr + "Server Pulse: Tailscale is no longer installed, so the dashboard can't reach this server. Run the Add server command again.")
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	status, _ := exec.CommandContext(ctx, "tailscale", "status", "--json").Output()
	host := tsHost(status)
	if host == "" {
		fmt.Println(prioErr + "Server Pulse: Tailscale on this machine is logged out or not running, so the dashboard can't reach it. Check with: tailscale status")
		return nil
	}
	want := strings.TrimPrefix(cfg.PublicURL, "https://")
	if h, _, _ := strings.Cut(want, ":"); h != host {
		fmt.Println(prioErr + "Server Pulse: this machine's Tailscale name is now " + cleanLine(host) + ", but the dashboard uses " + cleanLine(want) + ". Run the Add server command again.")
		return nil
	}
	serve, _ := exec.CommandContext(ctx, "tailscale", "serve", "status", "--json").Output()
	served, free := funnelOn(serve, host, cfg.FunnelPort)
	switch {
	case served:
		// in place
	case free:
		// gone, and its port is free: put it back (bounded: if Tailscale wants Funnel approved in the
		// browser, this only reports it)
		fctx, fcancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer fcancel()
		cmd := exec.CommandContext(fctx, "tailscale", "funnel", "--bg", "--https="+strconv.Itoa(cfg.FunnelPort), agentTarget)
		cmd.WaitDelay = 5 * time.Second
		if out, err := cmd.CombinedOutput(); err != nil || fctx.Err() != nil {
			stopSystemFunnel(cfg.FunnelPort) // no half-made handler left behind; the next run tries again
			fmt.Println(prioErr + "Server Pulse: the agent's Tailscale Funnel was missing and couldn't be turned on again: " + firstLine(string(out)))
			return nil
		}
		fmt.Println(prioNotice + "Server Pulse: the agent's Tailscale Funnel was missing; turned it on again at " + cleanLine(cfg.PublicURL) +
			" (to keep it off: sudo systemctl disable --now " + funnelCheckName + ".timer)")
	default:
		fmt.Println(prioErr + "Server Pulse: Funnel port " + strconv.Itoa(cfg.FunnelPort) + " is now used by another service, so the dashboard can't reach the agent. Run the Add server command again to pick a free port.")
		return nil
	}
	pctx, pcancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer pcancel()
	if err := probePublic(pctx, cfg.PublicURL); err != nil {
		fmt.Println(prioErr + "Server Pulse: " + cleanLine(cfg.PublicURL) + " doesn't reach the agent: " + plainNetErr(err) + ". Check: tailscale funnel status")
	}
	return nil
}

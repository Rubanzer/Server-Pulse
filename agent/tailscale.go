package main

import (
	"context"
	"encoding/json"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Tailscale already installed and logged in on this machine: publish the agent through it with Funnel
// (`tailscale funnel --bg`, which tailscaled keeps across restarts), instead of starting the agent's own
// embedded Tailscale node that would need a second login. The local tailscaled is root's, so its answers
// can be trusted the same way the installer trusts its own files.

const agentTarget = "http://127.0.0.1:19998"

var funnelPorts = []int{443, 8443, 10000} // the ports Tailscale Funnel allows

type tsStatus struct {
	BackendState string `json:"BackendState"`
	Self         struct {
		DNSName      string         `json:"DNSName"`
		CapMap       map[string]any `json:"CapMap"`
		Capabilities []string       `json:"Capabilities"`
	} `json:"Self"`
}

// tsHost returns this machine's tailnet name ("host.tailnet.ts.net") when Tailscale is logged in.
func tsHost(statusJSON []byte) string {
	var st tsStatus
	if json.Unmarshal(statusJSON, &st) != nil || st.BackendState != "Running" {
		return ""
	}
	h := strings.TrimSuffix(st.Self.DNSName, ".")
	if !strings.HasSuffix(h, ".ts.net") {
		return ""
	}
	return h
}

// pickFunnelPort chooses a Funnel port from `tailscale serve status --json`: the one already serving the
// agent if any (reuse=true), else the first port nothing else on this machine is published on.
// 0 = all three are taken by other services (never overwrite someone's setup).
func pickFunnelPort(serveJSON []byte, host string) (port int, reuse bool) {
	var sc struct {
		TCP map[string]json.RawMessage `json:"TCP"`
		Web map[string]struct {
			Handlers map[string]struct {
				Proxy string `json:"Proxy"`
			} `json:"Handlers"`
		} `json:"Web"`
	}
	_ = json.Unmarshal(serveJSON, &sc) // empty or "{}" when nothing is served
	for _, p := range funnelPorts {
		if w, ok := sc.Web[host+":"+strconv.Itoa(p)]; ok {
			for _, h := range w.Handlers {
				if strings.TrimSuffix(h.Proxy, "/") == agentTarget || strings.TrimSuffix(h.Proxy, "/") == "http://localhost:19998" {
					return p, true
				}
			}
		}
	}
	for _, p := range funnelPorts {
		if _, used := sc.TCP[strconv.Itoa(p)]; !used {
			return p, false
		}
	}
	return 0, false
}

var tsAdminLink = regexp.MustCompile(`https://login\.tailscale\.com/\S+`)

// systemTailscale publishes the agent through an existing, logged-in Tailscale. It returns the public
// address, or "" with a note to show (empty note: Tailscale isn't installed or logged in here).
func systemTailscale() (publicURL, note string, port int) {
	if _, err := exec.LookPath("tailscale"); err != nil {
		return "", "", 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tailscale", "status", "--json").Output()
	host := tsHost(out)
	if err != nil || host == "" {
		return "", "", 0
	}
	serve, _ := exec.CommandContext(ctx, "tailscale", "serve", "status", "--json").Output()
	port, reuse := pickFunnelPort(serve, host)
	if port == 0 {
		return "", "Tailscale is installed, but Funnel ports 443, 8443 and 10000 are all used by your other services here", 0
	}
	if !reuse {
		// --bg: tailscaled keeps it after the installer exits and across restarts; only this one port is touched
		msg, err := exec.CommandContext(ctx, "tailscale", "funnel", "--bg", "--https="+strconv.Itoa(port), agentTarget).CombinedOutput()
		if err != nil || ctx.Err() != nil {
			if link := tsAdminLink.Find(msg); link != nil {
				return "", "Tailscale needs Funnel allowed for this machine first. Open " + string(link) + ", allow it, then run the command again", 0
			}
			return "", "Tailscale is installed, but turning on Funnel failed (" + firstLine(string(msg)) + ")", 0
		}
	}
	u := "https://" + host
	if port != 443 {
		u += ":" + strconv.Itoa(port)
	}
	return u, "", port
}

// stopSystemFunnel undoes what systemTailscale set up (uninstall).
func stopSystemFunnel(port int) {
	if port == 0 {
		return
	}
	if _, err := exec.LookPath("tailscale"); err == nil {
		run("tailscale", "funnel", "--https="+strconv.Itoa(port), "off")
	}
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 160 {
		s = s[:160] + "…"
	}
	if s == "" {
		return "no output"
	}
	return s
}

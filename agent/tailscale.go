package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

// URL characters only: no control characters (terminal escape sequences) can ride along when it's printed
var tsAdminLink = regexp.MustCompile(`https://login\.tailscale\.com/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+`)

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
		step("Turning on Tailscale Funnel for the agent")
		// --bg: tailscaled keeps it after the installer exits and across restarts; only this one port is touched.
		// The first time, Tailscale waits until Funnel is allowed in the browser: show its link at once and
		// give the owner time to click it, instead of a silent wait.
		fctx, fcancel := context.WithTimeout(context.Background(), funnelWait)
		defer fcancel()
		w := &linkWatch{onLink: func(link string) {
			fmt.Printf("\n  Tailscale needs Funnel allowed for this machine (once). Open this link and press Allow:\n\n      %s\n\n  Waiting for you (up to %d minutes). If the dashboard says the command expired, get a new one there.\n\n", link, int(funnelWait/time.Minute))
		}}
		cmd := exec.CommandContext(fctx, "tailscale", "funnel", "--bg", "--https="+strconv.Itoa(port), agentTarget)
		cmd.Stdout, cmd.Stderr = w, w   // the same writer: exec then uses a single goroutine, no race
		cmd.WaitDelay = 5 * time.Second // never hang past the timeout on a pipe something else kept open
		err := cmd.Run()
		msg := w.buf.Bytes()
		if err != nil || fctx.Err() != nil {
			// it may have opened the port before failing or timing out: close it, nothing records it
			stopSystemFunnel(port)
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

// funnelWait: how long the installer waits for the owner to allow Funnel in the browser.
// Shorter than the pairing code's 10 minutes, so the code still works when the owner allowed it in time.
const funnelWait = 8 * time.Minute

// linkWatch collects a command's output and reports the first complete Tailscale admin link it prints.
type linkWatch struct {
	buf    bytes.Buffer
	shown  bool
	onLink func(string)
}

func (w *linkWatch) Write(p []byte) (int, error) {
	if w.buf.Len() < 64<<10 { // bounded: tailscale prints a few lines
		w.buf.Write(p)
	}
	if !w.shown {
		b := w.buf.Bytes()
		if i := bytes.LastIndexByte(b, '\n'); i >= 0 { // complete lines only: never a half-printed link
			if link := tsAdminLink.Find(b[:i]); link != nil {
				w.shown = true
				w.onLink(string(link))
			}
		}
	}
	return len(p), nil
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

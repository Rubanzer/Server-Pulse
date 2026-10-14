package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// The dashboard reaches the agent through a public address (Tailscale Funnel, ngrok, your own proxy).
// Before pairing, the installer calls that address the way the dashboard will, so a tunnel that doesn't
// pass connections is explained right here, in plain words, instead of surfacing later as a bare
// "ECONNRESET" on the Add server page.

// reachWait: a brand-new Funnel address gets its HTTPS certificate on its first request (10-20 s).
const reachWait = 90 * time.Second

// probePublic asks the agent's info endpoint through the public address. The agent answers 401 without
// the dashboard password, which proves the whole path (DNS, tunnel, TLS, agent) works.
func probePublic(ctx context.Context, publicURL string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(publicURL, "/")+"/api/v1/info", nil)
	if err != nil {
		return err
	}
	req.Header.Set("ngrok-skip-browser-warning", "1")
	c := http.Client{
		Timeout: 20 * time.Second,
		// a redirect means something else answers at that address
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusOK {
		return nil
	}
	if code := res.Header.Get("ngrok-error-code"); code != "" {
		return fmt.Errorf("ngrok answered %s instead of the agent (%s)", res.Status, code)
	}
	return fmt.Errorf("the address answered %s instead of the agent", res.Status)
}

// checkPublic runs probePublic until it works or reachWait passes (at most ~2 minutes: pairing goes ahead
// either way, well inside the code's 10 minutes). It reports whether the address works; on failure it has
// already printed what to check.
func checkPublic(cfg Config) bool {
	step("Checking that " + cfg.PublicURL + " answers from the internet")
	deadline := time.Now().Add(reachWait)
	var last error
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		last = probePublic(ctx, cfg.PublicURL)
		cancel()
		if last == nil {
			step("It answers: the dashboard can reach this server")
			return true
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Second)
	}
	fmt.Println("\n  ! " + cfg.PublicURL + " doesn't reach the agent yet: " + plainNetErr(last))
	for _, l := range reachHints(cfg) {
		fmt.Println("    " + l)
	}
	fmt.Println()
	return false
}

// reachHints: what to look at for the tunnel in use, as commands that only show information.
func reachHints(cfg Config) []string {
	switch {
	case cfg.FunnelPort != 0 || strings.Contains(cfg.PublicURL, ".ts.net"):
		out := []string{
			"Tailscale Funnel isn't passing connections to this server. Check:",
			"  tailscale status          this machine must be listed and not \"offline\"",
			"  tailscale funnel status   must show " + strings.TrimPrefix(cfg.PublicURL, "https://") + " (Funnel on) → " + agentTarget,
			"  Tailscale admin console → Access controls: Funnel must be allowed for this machine",
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "tailscale", "funnel", "status")
		cmd.WaitDelay = 2 * time.Second
		if st, err := cmd.CombinedOutput(); err == nil || len(st) > 0 {
			out = append(out, "Funnel status now:")
			for _, l := range strings.Split(strings.TrimSpace(firstLines(string(st), 6)), "\n") {
				out = append(out, "  "+cleanLine(l))
			}
		}
		return out
	case strings.Contains(cfg.PublicURL, ".ngrok"):
		return []string{
			"ngrok isn't forwarding to the agent. ngrok must be running and pointing at " + localAddr + ":",
			"  ngrok http " + localAddr + " --url=" + cfg.PublicURL,
		}
	default:
		return []string{"Your tunnel or proxy must forward " + cfg.PublicURL + " to " + localAddr + " (without a password of its own)."}
	}
}

// plainNetErr turns transport errors into words; the raw text stays in brackets for searching.
func plainNetErr(err error) string {
	if err == nil {
		return ""
	}
	m := err.Error()
	low := strings.ToLower(m)
	var why string
	switch {
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(low, "timeout"):
		why = "no answer in time"
	case strings.Contains(low, "no such host"):
		why = "the name doesn't exist in public DNS (yet)"
	case strings.Contains(low, "connection reset") || strings.Contains(low, "eof") || strings.Contains(low, "handshake"):
		why = "the connection was cut before the agent answered (the tunnel isn't forwarding to this machine)"
	case strings.Contains(low, "connection refused"):
		why = "nothing accepts connections at that address"
	case strings.Contains(low, "certificate"):
		why = "its HTTPS certificate isn't valid yet"
	default:
		return cleanLine(m)
	}
	return why + " [" + cleanLine(m) + "]"
}

func firstLines(s string, n int) string {
	lines := strings.SplitN(s, "\n", n+1)
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "\n")
}

// cleanLine drops control characters, so nothing printed from another program can steer the terminal.
func cleanLine(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\t' || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return -1
		}
		return r
	}, s)
}

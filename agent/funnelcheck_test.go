package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestFunnelOnLooksAtTheConfiguredPort(t *testing.T) {
	h := "antpc.tail1234.ts.net"
	ours := []byte(`{"Web":{"antpc.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:19998"}}}}}`)
	if s, _ := funnelOn(ours, h, 8443); !s {
		t.Fatal("agent on 8443 not seen")
	}
	// after `tailscale serve reset`: 8443 is free again, even though 443 would be picked first
	if s, f := funnelOn([]byte(`{}`), h, 8443); s || !f {
		t.Fatal("empty config: 8443 must be free and not served")
	}
	other := []byte(`{"TCP":{"8443":{"HTTPS":true}},"Web":{"antpc.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}`)
	if s, f := funnelOn(other, h, 8443); s || f {
		t.Fatal("8443 used by another service must be neither ours nor free")
	}
}

func TestFunnelCheckUnitsAreValid(t *testing.T) {
	svc, timer := funnelCheckUnits()
	if !strings.Contains(svc, "ExecStart="+binPath+" funnel-check") || !strings.Contains(timer, "OnUnitActiveSec=10min") {
		t.Fatalf("units:\n%s\n%s", svc, timer)
	}
	if _, err := exec.LookPath("systemd-analyze"); err != nil {
		t.Skip("no systemd-analyze")
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, funnelCheckName+".service"), []byte(svc), 0o644)
	os.WriteFile(filepath.Join(dir, funnelCheckName+".timer"), []byte(timer), 0o644)
	out, _ := exec.Command("systemd-analyze", "verify", filepath.Join(dir, funnelCheckName+".timer"), filepath.Join(dir, funnelCheckName+".service")).CombinedOutput()
	// the binary path only exists on an installed machine; anything else is a real unit error
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l != "" && !strings.Contains(l, binPath) {
			t.Fatalf("systemd-analyze: %s", out)
		}
	}
}

package main

import (
	"bufio"
	"encoding/gob"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
)

func TestOnlyARealKeyRefusalIsFinal(t *testing.T) {
	for msg, want := range map[string]bool{
		"tsnet.Up: backend: invalid key: API key kH3dWCpXg221CNTRL not valid": true,
		"auth key expired": true,
		"x509: certificate has expired or is not yet valid":                          false, // wrong clock at boot
		"Get https://controlplane.tailscale.com: x509: certificate is not valid yet": false,
		"context deadline exceeded":                                                  false,
	} {
		if got := keyRejected(errors.New(msg)); got != want {
			t.Errorf("%q → final=%v, want %v", msg, got, want)
		}
	}
}

func TestWriteAtomicKeepsTheOldFileOnError(t *testing.T) {
	p := filepath.Join(t.TempDir(), "events.jsonl")
	os.WriteFile(p, []byte("good history\n"), 0o600)
	err := writeAtomic(p, func(w *bufio.Writer) error { w.WriteString("half"); return errors.New("disk full") })
	if err == nil {
		t.Fatal("error swallowed")
	}
	if b, _ := os.ReadFile(p); string(b) != "good history\n" {
		t.Fatalf("history replaced by a failed write: %q", b)
	}
	if _, err := os.Stat(p + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("temporary file left behind")
	}
	if err := writeAtomic(p, func(w *bufio.Writer) error { _, err := w.WriteString("new\n"); return err }); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "new\n" {
		t.Fatalf("got %q", b)
	}
}

func TestDamagedHistoryFileStartsFresh(t *testing.T) {
	p := filepath.Join(t.TempDir(), "history.gob")
	bad := newTier(coarseCap, testCharts)
	bad.Head, bad.Len = coarseCap+5, coarseCap+9 // would index past the ring on every start
	f, _ := os.Create(p)
	gob.NewEncoder(f).Encode(bad)
	f.Close()
	s := NewStore(testCharts)
	if err := s.Load(p); err != nil {
		t.Fatal(err)
	}
	s.Add(1000, map[string][]float64{}) // must not panic
	if s.coarse.Head != 0 && s.coarse.Len > coarseCap {
		t.Fatalf("damaged ring kept: head %d len %d", s.coarse.Head, s.coarse.Len)
	}
}

func TestNgrokUnitFlagsAndUnsafePaths(t *testing.T) {
	u := ngrokUnit("antpc", "/usr/local/bin/ngrok", "https://bunch-numbly-accent.ngrok-free.dev", true)
	if !strings.Contains(u, "ExecStart=/usr/local/bin/ngrok http 19998 --url=https://bunch-numbly-accent.ngrok-free.dev --log=stdout") || !strings.Contains(u, "User=antpc") {
		t.Fatalf("unit:\n%s", u)
	}
	old := ngrokUnit("antpc", "/usr/local/bin/ngrok", "https://bunch-numbly-accent.ngrok-free.dev", false)
	if !strings.Contains(old, " --domain=bunch-numbly-accent.ngrok-free.dev ") {
		t.Fatalf("older ngrok needs --domain:\n%s", old)
	}
	// a file in a world-writable directory is never run as root at boot
	dir := t.TempDir()
	os.Chmod(dir, 0o777)
	p := filepath.Join(dir, "ngrok")
	os.WriteFile(p, []byte("x"), 0o755)
	if rootOwnedPath(p) {
		t.Fatal("a world-writable directory was accepted")
	}
	if !rootOwnedPath("/") {
		t.Fatal("/ should be root-owned")
	}
	for _, bad := range []string{"https://x.ngrok-free.dev\nExecStartPre=/bin/sh", "https://a b.dev", "https://%h.dev", "https://$x.dev"} {
		if safeHost.MatchString(bad) {
			t.Fatalf("unsafe address accepted: %q", bad)
		}
	}
}

func TestNgrokProbeNeverRunsAsRootForAUsersFile(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root (the installer runs as root)")
	}
	// t.TempDir's parent is private (0700): "nobody" couldn't even reach the file. Use an open folder.
	dir, err := os.MkdirTemp("/tmp", "ngrok-probe-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	os.Chmod(dir, 0o777)
	out := filepath.Join(dir, "who")
	script := filepath.Join(dir, "ngrok")
	// uid, every group, then its session id and its own pid (equal: it leads a session of its own, no terminal)
	os.WriteFile(script, []byte("#!/bin/sh\nread -r _ _ _ _ _ sid _ < /proc/$$/stat\necho $(id -u) $(id -G) $sid $$ > "+out+"\necho '--url'\n"), 0o755)
	nobody := &user.User{Uid: "65534", Gid: "65534", HomeDir: "/"}
	if !ngrokHasURLFlag(script, nobody) {
		t.Fatal("probe output not read")
	}
	b, _ := os.ReadFile(out)
	f := strings.Fields(string(b)) // uid, groups..., sid, pid
	if len(f) != 4 || f[0] != "65534" || f[1] != "65534" {
		t.Fatalf("the probe ran as %q, want only the file owner's uid and group (never root's)", b)
	}
	if f[2] != f[3] {
		t.Fatalf("the probe shares the installer's session (%q): it could reach the root terminal", b)
	}
}

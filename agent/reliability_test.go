package main

import (
	"bufio"
	"encoding/gob"
	"errors"
	"os"
	"path/filepath"
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

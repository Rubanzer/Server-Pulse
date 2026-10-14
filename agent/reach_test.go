package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProbePublicAcceptsOnlyTheAgent(t *testing.T) {
	for _, c := range []struct {
		status int
		header string
		ok     bool
		want   string
	}{
		{401, "", true, ""}, // the agent asks for the dashboard password: the path works
		{200, "", true, ""},
		{502, "", false, "502"},
		{404, "ERR_NGROK_3200", false, "ERR_NGROK_3200"},
		{302, "", false, "302"}, // something else answers there
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/v1/info" {
				t.Errorf("asked %s", r.URL.Path)
			}
			if c.header != "" {
				w.Header().Set("ngrok-error-code", c.header)
			}
			if c.status == 302 {
				w.Header().Set("Location", "/elsewhere")
			}
			w.WriteHeader(c.status)
		}))
		err := probePublic(context.Background(), srv.URL+"/")
		srv.Close()
		if (err == nil) != c.ok || (err != nil && !strings.Contains(err.Error(), c.want)) {
			t.Fatalf("status %d: got %v", c.status, err)
		}
	}
}

func TestPlainNetErrAndCleanLine(t *testing.T) {
	if m := plainNetErr(errors.New("read tcp 1.2.3.4:443: connection reset by peer")); !strings.HasPrefix(m, "the connection was cut") {
		t.Fatalf("reset: %q", m)
	}
	if m := plainNetErr(errors.New("dial tcp: lookup x.ts.net: no such host")); !strings.HasPrefix(m, "the name doesn't exist") {
		t.Fatalf("dns: %q", m)
	}
	if got := cleanLine("ok\x1b]8;;https://evil\x07 \u009b2J end"); got != "ok]8;;https://evil 2J end" {
		t.Fatalf("control characters kept: %q", got)
	}
}

func TestFirstLineKeepsOnlyTheFirstCleanLine(t *testing.T) {
	if got := firstLine("error: funnel not allowed\x1b[2J\nsecond line"); got != "error: funnel not allowed[2J" {
		t.Fatalf("got %q", got)
	}
}

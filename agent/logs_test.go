package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseJournalLine(t *testing.T) {
	// real shape from Ubuntu: MESSAGE as a byte array containing ANSI color codes
	line := `{"__CURSOR":"s=abc;i=1","__REALTIME_TIMESTAMP":"1791881320569957","PRIORITY":"6","_SYSTEMD_UNIT":"wsl-pro.service","MESSAGE":[27,91,51,54,109,73,78,70,79,27,91,48,109,32,82,101,99,111,110,110,101,99,116,105,110,103]}`
	e, ok := parseJournalLine([]byte(line))
	if !ok || e.Unit != "wsl-pro.service" || e.Prio != 6 || e.T != 1791881320569 || e.Msg != "INFO Reconnecting" {
		t.Fatalf("got %+v ok=%v", e, ok)
	}
	k, ok := parseJournalLine([]byte(`{"__CURSOR":"x","_TRANSPORT":"kernel","PRIORITY":"3","MESSAGE":"nvme0n1: I/O error"}`))
	if !ok || k.Unit != "kernel" || k.Prio != 3 {
		t.Fatalf("kernel line %+v", k)
	}
	u, _ := parseJournalLine([]byte(`{"__CURSOR":"y","_SYSTEMD_UNIT":"init.scope","UNIT":"nginx.service","PRIORITY":"3","MESSAGE":"nginx.service: Failed with result 'exit-code'."}`))
	if u.Unit != "nginx.service" {
		t.Fatalf("systemd message should name the failed unit, got %q", u.Unit)
	}
	s, _ := parseJournalLine([]byte(`{"__CURSOR":"z","_SYSTEMD_UNIT":"session-4.scope","SYSLOG_IDENTIFIER":"backup.sh","PRIORITY":"3","MESSAGE":"rsync failed"}`))
	if s.Unit != "backup.sh" {
		t.Fatalf("session scope should yield the program name, got %q", s.Unit)
	}
	if _, ok := parseJournalLine([]byte("not json")); ok {
		t.Fatal("garbage parsed")
	}
}

func TestScrubLog(t *testing.T) {
	in := `login ok user=bob password=hunter2 token: abc.def Authorization: Bearer eyJhbGciOi.xyz connecting to postgres://app:s3cr3t@db:5432/x key tskey-auth-kH3dWCpXg221CNTRL-Ge8N api_key="QWERTY123"`
	out := scrubLog(in)
	for _, leak := range []string{"hunter2", "abc.def", "eyJhbGciOi", "s3cr3t", "tskey-auth-kH3d", "QWERTY123"} {
		if strings.Contains(out, leak) {
			t.Fatalf("leaked %q: %s", leak, out)
		}
	}
	for _, keep := range []string{"login ok user=bob", "postgres://", "@db:5432/x"} {
		if !strings.Contains(out, keep) {
			t.Fatalf("over-scrubbed, lost %q: %s", keep, out)
		}
	}
	more := []struct{ in, leak string }{
		{`{"user":"bob","password":"hunter2"}`, "hunter2"},
		{`mysql -u root --password Sup3rS3cret db`, "Sup3rS3cret"},
		{`got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`, "dozjgNryP4J3"},
		{`Authorization: Token 9f8e7d6c5b4a39281706f5e4d3c2b1a0`, "9f8e7d6c5b4a"},
		{`MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvuNMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s`, "MIIEvQIBADAN"},
		{`-----BEGIN OPENSSH PRIVATE KEY-----`, "BEGIN"},
		{`key ASIAIOSFODNN7EXAMPLE github_pat_11ABCDEFG0123456789abcdef sk_live_51Habcdefghijklmnop AIzaSyD-abcdefghijklmnopqrstuvwxyz12345`, "EXAMPLE"},
	}
	for _, m := range more {
		if out := scrubLog(m.in); strings.Contains(out, m.leak) {
			t.Fatalf("leaked %q: %s", m.leak, out)
		}
	}
	for _, leak := range []string{"github_pat_11", "sk_live_51", "AIzaSyD"} {
		if strings.Contains(scrubLog(more[6].in), leak) {
			t.Fatalf("leaked %q", leak)
		}
	}
	// a sha256 digest is not key material
	if got := scrubLog("pulled sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"); !strings.Contains(got, "9f86d081884c") {
		t.Fatalf("scrubbed a digest: %s", got)
	}
	// ordinary ids and hashes stay readable
	if got := scrubLog("container 3f2a9c1b7d4e5f60718293a4b5c6d7e8 started"); !strings.Contains(got, "3f2a9c1b7d4e") {
		t.Fatalf("scrubbed a plain id: %s", got)
	}
}

func TestClassify(t *testing.T) {
	cases := []struct {
		msg       string
		prio      int
		sev, kind string
		isFailure bool
	}{
		{"Out of memory: Killed process 1234 (python3)", 6, "critical", "memory", true},
		{"blk_update_request: I/O error, dev sda, sector 12", 3, "critical", "disk", true},
		{"nginx.service: Failed with result 'exit-code'.", 5, "error", "service", true},
		{"python3[99]: segfault at 0 ip 000", 6, "error", "crash", true},
		{"something broke", 3, "error", "log", true},
		{"disk nearly full", 2, "critical", "log", true},
		{"Accepted publickey for antpc", 6, "", "", false},
		{"slow query 1800ms", 4, "", "", false}, // warnings are shown live, not stored
	}
	for _, c := range cases {
		sev, kind, ok := classify(LogEntry{Prio: c.prio, Msg: c.msg})
		if ok != c.isFailure || sev != c.sev || kind != c.kind {
			t.Errorf("%q → %s/%s/%v, want %s/%s/%v", c.msg, sev, kind, ok, c.sev, c.kind, c.isFailure)
		}
	}
}

func TestEventLogRepeatsFloodAndPersistence(t *testing.T) {
	dir := t.TempDir()
	l := OpenEventLog(dir)
	epoch := l.Epoch
	if len(epoch) < 8 {
		t.Fatalf("epoch %q", epoch)
	}
	l.Add(1000, "error", "service", "nginx.service", "worker 123 exited")
	l.Add(1100, "error", "service", "nginx.service", "worker 456 exited") // same message except digits → repeat
	l.Add(1200, "critical", "memory", "kernel", "Out of memory")
	got := l.Since(0, 0, 100)
	if len(got) != 2 || got[0].Count != 2 || got[0].Last != 1100 {
		t.Fatalf("repeat counting: %+v", got)
	}
	// a repeat more than 10 minutes later is a new event
	l.Add(1100+601, "error", "service", "nginx.service", "worker 789 exited")
	if n := len(l.Since(0, 0, 100)); n != 3 {
		t.Fatalf("want 3 events, got %d", n)
	}
	// only new events after a cursor, plus ones whose count changed since `updated`
	if got := l.Since(2, 0, 100); len(got) != 1 || got[0].ID != 3 {
		t.Fatalf("since cursor: %+v", got)
	}
	if got := l.Since(3, 1050, 100); len(got) != 1 || got[0].ID != 1 {
		t.Fatalf("updated since: %+v", got)
	}
	// flood guard: at most 60 new failures per minute
	for i := 0; i < 100; i++ {
		l.Add(5000, "error", "log", fmt.Sprintf("spam-%d", i), "unique message "+strings.Repeat("x", i))
	}
	if n := len(l.Since(3, 0, 1000)); n != 60 {
		t.Fatalf("flood guard kept %d", n)
	}
	// a flood of non-critical failures can't crowd out an OOM kill
	if !l.Add(5001, "critical", "memory", "kernel", "Out of memory: Killed process 1") {
		t.Fatal("critical event dropped by the flood guard")
	}
	// survives a restart with the same epoch, ids continue
	r := OpenEventLog(dir)
	if r.Epoch != epoch || len(r.Since(0, 0, 1000)) != 64 {
		t.Fatalf("after reopen: epoch %q, %d events", r.Epoch, len(r.Since(0, 0, 1000)))
	}
	if first := r.Since(0, 0, 1)[0]; first.Count != 2 {
		t.Fatalf("repeat count lost on reload: %+v", first)
	}
	r.Add(9000, "warning", "cpu", "server-pulse", "CPU at 97%")
	if last := r.Recent(1)[0]; last.ID != 65 {
		t.Fatalf("ids restarted: %d", last.ID)
	}
}

func TestRepeatsDontGrowTheFile(t *testing.T) {
	dir := t.TempDir()
	l := OpenEventLog(dir)
	for i := int64(0); i < 5000; i++ {
		l.Add(1000+i/100, "error", "service", "nginx", "connect() failed (111) client 1.2.3.4")
	}
	b, _ := os.ReadFile(filepath.Join(dir, "events.jsonl"))
	if n := strings.Count(string(b), "\n"); n > 3 {
		t.Fatalf("5000 repeats over 50 s wrote %d lines", n)
	}
	if e := l.Recent(1)[0]; e.Count != 5000 {
		t.Fatalf("count %d", e.Count)
	}
	for i := 0; i < 3000; i++ { // the file is compacted, not grown forever
		l.Add(int64(100000+i*700), "error", "service", "nginx", "connect() failed (111) client 1.2.3.4")
	}
	b, _ = os.ReadFile(filepath.Join(dir, "events.jsonl"))
	if n := strings.Count(string(b), "\n"); n > maxEvents*2 {
		t.Fatalf("file has %d lines", n)
	}
}

func TestThresholdsHoldAndHysteresis(t *testing.T) {
	l := OpenEventLog(t.TempDir())
	var th thresholds
	for s := int64(0); s < 299; s++ {
		th.check(l, s, map[string]float64{"cpu": 97})
	}
	if len(l.Recent(10)) != 0 {
		t.Fatal("fired before 5 minutes")
	}
	th.check(l, 300, map[string]float64{"cpu": 97})
	th.check(l, 400, map[string]float64{"cpu": 96})
	if n := len(l.Recent(10)); n != 1 {
		t.Fatalf("want exactly one CPU event, got %d", n)
	}
	th.check(l, 401, map[string]float64{"cpu": 94}) // inside the hysteresis band: still armed-off
	th.check(l, 402, map[string]float64{"cpu": 97})
	th.check(l, 800, map[string]float64{"cpu": 97})
	if n := len(l.Recent(10)); n != 1 {
		t.Fatalf("flapped: %d events", n)
	}
	th.check(l, 801, map[string]float64{"cpu": 50}) // back to normal: re-armed
	for s := int64(802); s <= 1110; s++ {
		th.check(l, s, map[string]float64{"cpu": 99})
	}
	if n := len(l.Recent(10)); n != 2 {
		t.Fatalf("should fire again after recovery, got %d", n)
	}
}

func TestLogFilterValidation(t *testing.T) {
	if _, err := parseFilter(map[string][]string{"unit": {"nginx.service; rm -rf /"}}); err == nil {
		t.Fatal("accepted a dangerous unit name")
	}
	if _, err := parseFilter(map[string][]string{"prio": {"9"}}); err == nil {
		t.Fatal("accepted prio 9")
	}
	f, err := parseFilter(map[string][]string{"unit": {"postgresql@16-main.service"}, "prio": {"3"}})
	if err != nil || f.Prio != 3 {
		t.Fatal(err)
	}
	args := strings.Join(journalArgs(f, "-n", "5"), " ")
	if !strings.Contains(args, "-u postgresql@16-main.service") || !strings.Contains(args, "-p 3") {
		t.Fatalf("args %s", args)
	}
	r, err := parseFilter(map[string][]string{"since": {"1790000000"}, "until": {"1790003600"}})
	if err != nil || !strings.Contains(strings.Join(journalArgs(r), " "), "--since @1790000000 --until @1790003600") {
		t.Fatalf("range args %v %v", journalArgs(r), err)
	}
	for _, bad := range []map[string][]string{{"since": {"-5"}}, {"since": {"yesterday"}}, {"since": {"100"}, "until": {"50"}}} {
		if _, err := parseFilter(bad); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
	if args := strings.Join(journalArgs(logFilter{Prio: 6, Unit: "sshd"}), " "); !strings.Contains(args, "-t sshd") {
		t.Fatalf("identifier filter: %s", args)
	}
}

func TestTokenScopes(t *testing.T) {
	const pw = "scope-test-password"
	key := streamKey(pw)
	now := time.Now().Unix()
	var nc nonceCache
	pulseTok := mintToken(pw, now+60, "nonce-pulse-0000000")
	if verifyToken(pulseTok, key, &nc, now, "logs") == nil {
		t.Fatal("a live-view token opened the logs")
	}
	logsTok := mintScoped(pw, "logs", now+60, "nonce-logs-00000000")
	if err := verifyToken(logsTok, key, &nc, now, "logs"); err != nil {
		t.Fatal(err)
	}
	if verifyToken(mintScoped(pw, "logs", now+60, "nonce-logs-11111111"), key, &nc, now, "pulse") == nil {
		t.Fatal("a logs token opened the live view")
	}
	// the logs stream endpoint rejects a pulse token before running anything
	hub := NewHub(NewPulse("/", false), pw, nil)
	api := NewAPI(hub, NewStore(testCharts), testCharts, "dashboard", pw, func() map[string]any { return nil })
	srv := httptest.NewServer(api.Handler())
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/api/v1/logs/stream", nil)
	req.Header.Set("Authorization", "Bearer "+mintToken(pw, now+60, "nonce-pulse-2222222"))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 401 {
		t.Fatalf("pulse token on logs stream → %d", res.StatusCode)
	}
	// and the basic-auth endpoints still need the password
	if r, _ := http.Get(srv.URL + "/api/v1/events"); r.StatusCode != 401 {
		t.Fatalf("events without password → %d", r.StatusCode)
	}
	if r, _ := http.Get(srv.URL + "/history/api/v1/logs"); r.StatusCode != 401 {
		t.Fatalf("logs without password → %d", r.StatusCode)
	}
}

func TestOneCrashIsOneFailure(t *testing.T) {
	l := OpenEventLog(t.TempDir())
	crash := func(at int64) {
		// what ngrok-pulse.service printed each time it died, then systemd's verdict
		l.Add(at, "error", "log", "ngrok-pulse.service", "t=2026-10-13T16:35:38+0530 lvl=eror msg=\"session closing\" err=\"failed to start tunnel\"")
		l.Add(at, "error", "log", "ngrok-pulse.service", "ERROR: failed to start tunnel: Only paid plans may create endpoints with custom subdomains.")
		l.Add(at+1, "error", "service", "ngrok-pulse.service", "ngrok-pulse.service: Failed with result 'exit-code'.")
	}
	for i := int64(0); i < 50; i++ {
		crash(1000 + i*5)
	}
	got := l.Recent(10)
	if len(got) != 1 {
		t.Fatalf("one crash loop should be one failure, got %d: %+v", len(got), got)
	}
	e := got[0]
	if e.Kind != "service" || !strings.Contains(e.Msg, "Failed with result") || len(e.More) != 2 || e.Count != 50 {
		t.Fatalf("headline/companions/count wrong: %+v", e)
	}
	// a different service failing at the same moment stays its own failure
	l.Add(1300, "error", "service", "nginx.service", "nginx.service: Failed with result 'exit-code'.")
	if n := len(l.Recent(10)); n != 2 {
		t.Fatalf("want 2 failures, got %d", n)
	}
}

func TestRepeatHoldAndHiddenServices(t *testing.T) {
	q := newQuieter(logFilter{Quiet: true, Exclude: []string{"ngrok-pulse.service"}})
	line := func(sec int64, unit, msg string) *LogEntry { return &LogEntry{T: sec * 1000, Unit: unit, Msg: msg} }
	if q.keep(line(0, "ngrok-pulse.service", "ERROR: ERR_NGROK_313")) {
		t.Fatal("a hidden service was shown")
	}
	shown := 0
	var start *LogEntry
	for s := int64(0); s < 30; s += 5 { // same error every 5 s (digits differ)
		e := line(1000+s, "app.service", fmt.Sprintf("worker %d crashed", s))
		if q.keep(e) {
			shown++
			if e.Hold > 0 {
				start = e
			}
		}
	}
	if shown != 5 || start == nil || start.Hold != 600 {
		t.Fatalf("5 copies in a minute then hold: shown %d, hold %+v", shown, start)
	}
	for s := int64(30); s < 620; s += 5 { // still repeating during the hold (5th copy at +20 s, so until +620 s)
		if q.keep(line(1000+s, "app.service", "worker 9 crashed")) {
			t.Fatalf("shown during the hold at +%d s", s)
		}
	}
	after := line(1000+620, "app.service", "worker 1 crashed")
	if !q.keep(after) || after.Held == 0 {
		t.Fatalf("after the hold the line returns with the held count: %+v", after)
	}
	if !q.keep(line(1000, "other.service", "different line")) {
		t.Fatal("other lines must not be affected")
	}
	if _, err := parseFilter(map[string][]string{"exclude": {"ngrok-pulse.service,bad;rm"}}); err == nil {
		t.Fatal("accepted an invalid service name")
	}
}

package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestParseCPUAndPercent(t *testing.T) {
	a := parseCPU([]byte("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4 5 6 7 8 9 10\n"))
	b := parseCPU([]byte("cpu  160 0 70 900 60 5 5 0 0 0\n"))
	if a == nil || b == nil {
		t.Fatal("parse failed")
	}
	p := cpuPercent(a, b) // deltas: user 60 nice 0 system 20 idle 100 iowait 10 irq 5 softirq 5 steal 0 → total 200
	want := []float64{30, 10, 0, 5, 2.5, 2.5, 0}
	for i := range want {
		if !near(p[i], want[i]) {
			t.Fatalf("dim %d = %v, want %v (all %v)", i, p[i], want[i], p)
		}
	}
	if parseCPU([]byte("garbage")) != nil {
		t.Fatal("garbage should not parse")
	}
	if z := cpuPercent(b, b); z[0] != 0 {
		t.Fatal("no time passed → zeros")
	}
}

func TestParseMeminfoSumsToTotal(t *testing.T) {
	m := parseMeminfo([]byte(`MemTotal:       16384000 kB
MemFree:         2048000 kB
Buffers:          512000 kB
Cached:          4096000 kB
Shmem:            100000 kB
SReclaimable:     300000 kB
`))
	sum := m[0] + m[1] + m[2] + m[3]
	if !near(sum, 16384000.0/1024) {
		t.Fatalf("free+used+cached+buffers = %v MiB, want MemTotal", sum)
	}
	if !near(m[2], (4096000+300000-100000)/1024.0) {
		t.Fatalf("cached = %v", m[2])
	}
}

func TestParseDiskstatsAndNetdev(t *testing.T) {
	ds := []byte(`   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0
   8       1 sda1 90 0 1800 0 40 0 3000 0 0 0 0
   7       0 loop0 5 0 999 0 0 0 999 0 0 0 0
`)
	rd, wr := parseDiskstats(ds, []string{"sda"})
	if rd != 2000 || wr != 4000 {
		t.Fatalf("whole disk only: got %d %d", rd, wr)
	}
	nd := []byte(`Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0
  eth0: 1000 10 0 0 0 0 0 0 500 5 0 0 0 0 0 0
docker0: 77 1 0 0 0 0 0 0 77 1 0 0 0 0 0 0
`)
	rx, tx := parseNetdev(nd, []string{"eth0"})
	if rx != 1000 || tx != 500 {
		t.Fatalf("physical iface only: got %d %d", rx, tx)
	}
}

func TestCollectorOnFixtureRoot(t *testing.T) {
	root := t.TempDir()
	write := func(p, s string) {
		full := filepath.Join(root, p)
		os.MkdirAll(filepath.Dir(full), 0o755)
		os.WriteFile(full, []byte(s), 0o644)
	}
	write("proc/stat", "cpu  100 0 50 800 50 0 0 0 0 0\n")
	write("proc/meminfo", "MemTotal: 1024 kB\nMemFree: 512 kB\n")
	write("proc/loadavg", "0.50 0.40 0.30 1/100 1234\n")
	write("proc/uptime", "3600.5 100.0\n")
	write("proc/diskstats", "8 0 sda 1 0 1024 0 1 0 2048 0 0 0 0\n")
	write("proc/net/dev", "h\nh\n eth0: 1000 0 0 0 0 0 0 0 1000 0 0 0 0 0 0 0\n")
	write("sys/block/sda/device/x", "")
	write("sys/class/net/eth0/device/x", "")
	write("sys/class/hwmon/hwmon0/name", "coretemp\n")
	write("sys/class/hwmon/hwmon0/temp1_input", "45000\n")
	write("sys/class/hwmon/hwmon0/temp1_label", "Package id 0\n")

	c := NewCollector(root)
	if got := c.Charts()[len(c.Charts())-1]; got.ID != "sensors.temperature" || got.Dims[0] != "coretemp_package_id_0" {
		t.Fatalf("temperature chart = %+v", got)
	}
	c.Sample(100)
	write("proc/stat", "cpu  150 0 75 825 50 0 0 0 0 0\n")                          // 100 ticks: 50 user, 25 system, 25 idle
	write("proc/diskstats", "8 0 sda 1 0 3072 0 1 0 2048 0 0 0 0\n")                // +2048 sectors read = 1 MiB
	write("proc/net/dev", "h\nh\n eth0: 126000 0 0 0 0 0 0 0 1000 0 0 0 0 0 0 0\n") // +125000 B
	s := c.Sample(102)                                                              // 2 s later
	if !near(s["system.cpu"][0], 50) || !near(s["system.cpu"][1], 25) {
		t.Fatalf("cpu %v", s["system.cpu"])
	}
	if !near(s["system.io"][0], 512) { // 1 MiB over 2 s = 512 KiB/s
		t.Fatalf("io %v", s["system.io"])
	}
	if !near(s["system.net"][0], 500) { // 125000 B * 8 / 1000 / 2 s = 500 kbit/s
		t.Fatalf("net %v", s["system.net"])
	}
	if !near(s["system.load"][0], 0.5) || !near(s["system.uptime"][0], 3600.5) || !near(s["sensors.temperature"][0], 45) {
		t.Fatalf("load/uptime/temp %v %v %v", s["system.load"], s["system.uptime"], s["sensors.temperature"])
	}
}

var testCharts = []chartDef{{"system.cpu", "system.cpu", []string{"user", "system"}}}

func TestStoreQueryBucketsAndGaps(t *testing.T) {
	s := NewStore(testCharts)
	for ts := int64(1000); ts < 1010; ts++ {
		s.Add(ts, map[string][]float64{"system.cpu": {float64(ts - 1000), 1}})
	}
	s.Add(1010, map[string][]float64{}) // missing reading → gap, not zero
	rows := s.Query("system.cpu", 1000, 1009, 5)
	if len(rows) != 5 {
		t.Fatalf("want 5 buckets, got %d", len(rows))
	}
	if rows[0][0] < rows[len(rows)-1][0] {
		t.Fatal("newest first")
	}
	if !near(rows[len(rows)-1][1], 0.5) { // oldest bucket: avg(0,1)
		t.Fatalf("oldest bucket %v", rows[len(rows)-1])
	}
	if got := s.Query("system.cpu", 1010, 1010, 1); len(got) != 0 {
		t.Fatalf("a gap must not become a row: %v", got)
	}
	if s.Query("nope", 0, 2000, 10) != nil {
		t.Fatal("unknown chart → nil")
	}
}

func TestStoreMinuteRollupAndPersistence(t *testing.T) {
	s := NewStore(testCharts)
	for ts := int64(6000); ts < 6000+180; ts++ { // 3 minutes at 1 s
		s.Add(ts, map[string][]float64{"system.cpu": {float64((ts - 6000) / 60), 2}})
	}
	if s.coarse.Len != 2 { // two finished minutes; the third is still accumulating
		t.Fatalf("coarse len %d", s.coarse.Len)
	}
	file := filepath.Join(t.TempDir(), "h.gob")
	if err := s.Save(file); err != nil {
		t.Fatal(err)
	}
	r := NewStore(testCharts)
	if err := r.Load(file); err != nil {
		t.Fatal(err)
	}
	rows := r.Query("system.cpu", 5000, 7000, 2000) // 1 s buckets, older than the fine tier → coarse
	if len(rows) != 2 || !near(rows[0][1], 1) || !near(rows[1][1], 0) {
		t.Fatalf("restored minutes %v", rows)
	}
}

func TestAPIAuthAndNetdataShapes(t *testing.T) {
	s := NewStore(testCharts)
	s.Add(1000, map[string][]float64{"system.cpu": {3.5, math.NaN()}})
	api := NewAPI(nil, s, testCharts, "dashboard", "secret-password", func() map[string]any { return map[string]any{} })
	srv := httptest.NewServer(api.Handler())
	defer srv.Close()

	get := func(path, pass string) (*http.Response, map[string]any) {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		if pass != "" {
			req.SetBasicAuth("dashboard", pass)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		json.NewDecoder(res.Body).Decode(&body)
		res.Body.Close()
		return res, body
	}
	if r, _ := get("/history/api/v1/info", ""); r.StatusCode != 401 {
		t.Fatalf("no auth → %d", r.StatusCode)
	}
	if r, _ := get("/history/api/v1/info", "wrong"); r.StatusCode != 401 {
		t.Fatalf("wrong password → %d", r.StatusCode)
	}
	_, all := get("/history/api/v1/allmetrics?format=json&filter=system.cpu", "secret-password")
	dims := all["system.cpu"].(map[string]any)["dimensions"].(map[string]any)
	if dims["user"].(map[string]any)["value"].(float64) != 3.5 || dims["system"].(map[string]any)["value"] != nil {
		t.Fatalf("allmetrics %v (NaN must be null)", all)
	}
	_, filtered := get("/api/v1/allmetrics?format=json&filter=disk_space.*", "secret-password")
	if len(filtered) != 0 {
		t.Fatalf("filter ignored: %v", filtered)
	}
	_, data := get("/history/api/v1/data?chart=system.cpu&after=990&before=1010&points=10&options=seconds&format=json", "secret-password")
	if l := data["labels"].([]any); l[0] != "time" || l[1] != "user" || len(data["data"].([]any)) != 1 {
		t.Fatalf("data %v", data)
	}
	if r, _ := get("/history/api/v1/data?chart=missing", "secret-password"); r.StatusCode != 404 {
		t.Fatalf("unknown chart → %d (dashboard falls back on 404)", r.StatusCode)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/info", nil)
	req.SetBasicAuth("dashboard", "secret-password")
	if res, _ := http.DefaultClient.Do(req); res.StatusCode != 405 {
		t.Fatalf("read-only: POST → %d", res.StatusCode)
	}
}

func TestRandomPasswordAndHostname(t *testing.T) {
	p := randomPassword(24)
	if len(p) != 24 {
		t.Fatal("length")
	}
	for _, r := range p {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			t.Fatalf("URL-unsafe char %q", r)
		}
	}
	if got := sanitizeHost("pulse-My_Server.local"); got != "pulse-my-server-local" {
		t.Fatalf("hostname %q", got)
	}
}

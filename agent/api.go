package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// API serves the subset of Netdata's REST API the dashboard uses, at both /api/v1/* and /history/api/v1/*
// (a dashboard link may point at the host root or at /history).
type API struct {
	hub      *Hub
	events   *EventLog
	store    *Store
	charts   []chartDef
	user     string
	pass     string
	info     map[string]any
	statusFn func() map[string]any // tunnel state for /agent/status (local only)
	runs     []Run                 // agent starts, for /api/v1/coverage
}

func NewAPI(hub *Hub, store *Store, charts []chartDef, user, pass string, statusFn func() map[string]any) *API {
	return &API{hub: hub, store: store, charts: charts, user: user, pass: pass, info: hostInfo(), statusFn: statusFn}
}

func (a *API) authorized(r *http.Request) bool {
	u, p, ok := r.BasicAuth()
	if !ok {
		return false
	}
	h := func(s string) []byte { x := sha256.Sum256([]byte(s)); return x[:] }
	// constant time, and hashing hides length differences
	return subtle.ConstantTimeCompare(h(u), h(a.user))&subtle.ConstantTimeCompare(h(p), h(a.pass)) == 1
}

// Handler is what the public (Funnel) listener serves: everything behind basic auth.
func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	for _, prefix := range []string{"", "/history"} {
		mux.HandleFunc(prefix+"/api/v1/info", a.handleInfo)
		mux.HandleFunc(prefix+"/api/v1/allmetrics", a.handleAll)
		mux.HandleFunc(prefix+"/api/v1/data", a.handleData)
		mux.HandleFunc(prefix+"/api/v1/charts", a.handleCharts)
		if a.hub != nil {
			mux.HandleFunc(prefix+"/api/v1/pulse", a.hub.Snapshot)
		}
		mux.HandleFunc(prefix+"/api/v1/logs", a.handleLogs)
		mux.HandleFunc(prefix+"/api/v1/events", a.handleEvents)
		mux.HandleFunc(prefix+"/api/v1/coverage", a.handleCoverage)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		w.Write([]byte("Server Pulse agent is running.\nPaste this server's link into the Server Pulse dashboard.\n"))
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-content-type-options", "nosniff")
		// the live stream authenticates with a short-lived token from the dashboard instead of the password
		if a.hub != nil && strings.HasSuffix(r.URL.Path, "/api/v1/pulse/stream") {
			a.hub.ServeStream(w, r)
			return
		}
		if a.hub != nil && strings.HasSuffix(r.URL.Path, "/api/v1/logs/stream") {
			a.hub.ServeLogs(w, r)
			return
		}
		if !a.authorized(r) {
			w.Header().Set("www-authenticate", `Basic realm="server-pulse"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "read-only", http.StatusMethodNotAllowed)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// LocalHandler adds /agent/status for `server-pulse-agent status`; only ever bound to 127.0.0.1.
func (a *API) LocalHandler() http.Handler {
	public := a.Handler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// only for requests made on this machine: a tunnel pointed at this port must not expose it
		if r.URL.Path == "/agent/status" && (r.Host == localAddr || r.Host == "localhost:19998") && r.Header.Get("X-Forwarded-For") == "" {
			writeJSON(w, a.statusFn())
			return
		}
		public.ServeHTTP(w, r)
	})
}

func (a *API) handleInfo(w http.ResponseWriter, _ *http.Request) { writeJSON(w, a.info) }

func (a *API) handleCharts(w http.ResponseWriter, _ *http.Request) {
	charts := map[string]any{}
	for _, c := range a.charts {
		charts[c.ID] = map[string]any{"id": c.ID, "name": c.ID, "context": c.Context}
	}
	writeJSON(w, map[string]any{"charts": charts})
}

// allmetrics?format=json[&filter=pattern pattern …] — Netdata simple patterns, `*` wildcard.
func (a *API) handleAll(w http.ResponseWriter, r *http.Request) {
	var pats []string
	if f := r.URL.Query().Get("filter"); f != "" {
		pats = strings.Fields(f)
	}
	ts, latest := a.store.Latest()
	out := map[string]any{}
	for _, c := range a.charts {
		if len(pats) > 0 && !matchAny(pats, c.ID) {
			continue
		}
		v, ok := latest[c.ID]
		if !ok {
			continue
		}
		dims := map[string]any{}
		for i, d := range c.Dims {
			dims[d] = map[string]any{"name": d, "value": num(v[i])}
		}
		out[c.ID] = map[string]any{"name": c.ID, "context": c.Context, "last_updated": ts, "dimensions": dims}
	}
	writeJSON(w, out)
}

// data?chart=&after=&before=&points=  (absolute epoch seconds, or Netdata-style negative = relative)
func (a *API) handleData(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("chart")
	var def *chartDef
	for i := range a.charts {
		if a.charts[i].ID == id {
			def = &a.charts[i]
		}
	}
	if def == nil {
		http.Error(w, "Chart is not found: "+id, http.StatusNotFound)
		return
	}
	now := time.Now().Unix()
	before := int64(atoi(q.Get("before"), 0))
	if before <= 0 {
		before = now + before
	}
	after := int64(atoi(q.Get("after"), -600))
	if after <= 0 {
		after = before + after
	}
	points := atoi(q.Get("points"), 0)
	if points <= 0 || points > 20000 {
		points = int(before - after)
	}
	rows := a.store.Query(id, after, before, points)
	data := make([][]any, len(rows))
	for i, row := range rows {
		cells := make([]any, len(row))
		cells[0] = int64(row[0])
		for j := 1; j < len(row); j++ {
			cells[j] = num(row[j])
		}
		data[i] = cells
	}
	writeJSON(w, map[string]any{"labels": append([]string{"time"}, def.Dims...), "data": data})
}

func matchAny(pats []string, s string) bool {
	for _, p := range pats {
		if ok, _ := path.Match(p, s); ok {
			return true
		}
	}
	return false
}

// num maps NaN/Inf (gaps) to JSON null.
func num(x float64) any {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return nil
	}
	return math.Round(x*1000) / 1000
}

func atoi(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func hostInfo() map[string]any {
	host, _ := os.Hostname()
	osName, osVer := "Linux", ""
	for _, line := range strings.Split(string(readFile("/etc/os-release")), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"`)
		switch k {
		case "NAME":
			osName = v
		case "VERSION_ID":
			osVer = v
		}
	}
	var ramBytes float64
	if m := parseMeminfo(readFile("/proc/meminfo")); m != nil {
		ramBytes = (m[0] + m[1] + m[2] + m[3]) * 1024 * 1024
	}
	return map[string]any{
		"version":        "server-pulse-agent " + version,
		"os_name":        osName,
		"os_version":     osVer,
		"kernel_version": readTrim("/proc/sys/kernel/osrelease"),
		"cores_total":    runtime.NumCPU(),
		"ram_total":      int64(ramBytes),
		"mirrored_hosts": []string{host},
	}
}

// logs?n=&prio=&unit=&after=<cursor> — recent journal lines (basic auth), for the dashboard's fallback.
// at most two journalctl runs for /api/v1/logs at once: a week-long range uses real memory, and the
// service is capped at 300 MB
var journalSlots = make(chan struct{}, 2)

func (a *API) handleLogs(w http.ResponseWriter, r *http.Request) {
	select {
	case journalSlots <- struct{}{}:
		defer func() { <-journalSlots }()
	case <-r.Context().Done():
		return
	case <-time.After(10 * time.Second):
		http.Error(w, "busy reading logs, try again", http.StatusServiceUnavailable)
		return
	}
	f, err := parseFilter(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	n := atoi(r.URL.Query().Get("n"), 200)
	if n < 1 || n > 1000 {
		n = 200
	}
	after := r.URL.Query().Get("after")
	if len(after) > 300 {
		http.Error(w, "bad cursor", http.StatusBadRequest)
		return
	}
	var entries []LogEntry
	more := false
	if f.Since > 0 { // a time window, oldest first, paged with the cursor
		entries, more, err = rangeLogs(r.Context(), f, n, after)
	} else {
		entries, err = tailLogs(r.Context(), f, n, after)
	}
	if err != nil {
		writeJSON(w, map[string]any{"entries": []LogEntry{}, "error": err.Error()})
		return
	}
	if entries == nil {
		entries = []LogEntry{}
	}
	cursor := after
	if len(entries) > 0 {
		cursor = entries[len(entries)-1].Cursor // the last line read, shown or not: the next page continues after it
	}
	q := newQuieter(f)
	shown := entries[:0]
	for i := range entries {
		if q.keep(&entries[i]) {
			shown = append(shown, entries[i])
		}
	}
	writeJSON(w, map[string]any{"entries": shown, "cursor": cursor, "more": more, "range": f.Since > 0, "quiet": true})
}

// events?after=<id>&updated=<unix> — failures recorded by this agent (basic auth).
func (a *API) handleEvents(w http.ResponseWriter, r *http.Request) {
	if a.events == nil {
		writeJSON(w, map[string]any{"epoch": "", "events": []Event{}})
		return
	}
	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	updated, _ := strconv.ParseInt(r.URL.Query().Get("updated"), 10, 64)
	ev := a.events.Since(after, updated, maxEvents) // the whole ring fits one answer
	if ev == nil {
		ev = []Event{}
	}
	writeJSON(w, map[string]any{"epoch": a.events.Epoch, "events": ev})
}

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- journal entries ----------

// LogEntry is one journal line as the dashboard sees it. Messages are scrubbed of secrets.
type LogEntry struct {
	Cursor string `json:"c"`
	T      int64  `json:"t"` // unix ms
	Prio   int    `json:"p"` // 0 emerg … 7 debug
	Unit   string `json:"u"`
	Msg    string `json:"m"`
	Hold   int64  `json:"hold,omitempty"` // this line repeated 5× in a minute: copies are held back for this many seconds
	Held   int    `json:"held,omitempty"` // copies held back before this one
}

var (
	unitRe = regexp.MustCompile(`^[A-Za-z0-9@:._\\-]{1,100}$`)
	ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
	// free-text secrets in log lines (narrower than the argv scrubber: logs are full of ids and hashes)
	// key=value, key: value and JSON ("password":"x")
	logSecretKV = regexp.MustCompile(`(?i)\b([\w.-]*(?:pass(?:word|wd)?|token|secret|api[_-]?key|auth(?:orization)?|cookie|session[_-]?id|private[_-]?key)[\w.-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)`)
	authHeader  = regexp.MustCompile(`(?i)\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:[A-Za-z]+\s+)?[^\s"',;]+`)
	bearerRe    = regexp.MustCompile(`(?i)\b(bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]{8,}`)
	cliSecret   = regexp.MustCompile(`(?i)(\s--?(?:password|passwd|pass|token|secret|api-key|apikey))\s+\S+`)
	jwtRe       = regexp.MustCompile(`\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}`)
	longSecret  = regexp.MustCompile(`\b(?:tskey-[\w-]+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[\w-]{30,}|xox[abpr]-[\w-]{10,})\b`)
	pemHeader   = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`)
	base64Run   = regexp.MustCompile(`[A-Za-z0-9+/]{60,}={0,2}`)
)

// mixedCase tells a base64 blob (PEM body, key material) from a hex hash or id, which stays readable.
func mixedCase(s string) bool {
	return strings.ContainsAny(s, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") && strings.ContainsAny(s, "abcdefghijklmnopqrstuvwxyz")
}

// scrubLog removes credentials from a log message before it leaves the server.
func scrubLog(s string) string {
	s = ansiRe.ReplaceAllString(s, "")
	if pemHeader.MatchString(s) {
		return "••• (private key removed)"
	}
	s = urlUserinfo.ReplaceAllString(s, "$1•••@")
	// header and scheme forms before key=value, or "Authorization: Bearer x" would keep x
	s = authHeader.ReplaceAllString(s, "$1•••")
	s = bearerRe.ReplaceAllString(s, "$1 •••")
	s = logSecretKV.ReplaceAllString(s, "$1$2•••")
	s = cliSecret.ReplaceAllString(s, "$1 •••")
	s = jwtRe.ReplaceAllString(s, "•••")
	s = longSecret.ReplaceAllString(s, "•••")
	s = base64Run.ReplaceAllStringFunc(s, func(m string) string {
		if mixedCase(m) {
			return "•••"
		}
		return m
	})
	if len(s) > 2000 {
		s = s[:2000] + "…"
	}
	return s
}

// parseJournalLine turns one `journalctl -o json` line into a LogEntry.
func parseJournalLine(b []byte) (LogEntry, bool) {
	var raw map[string]any
	if json.Unmarshal(b, &raw) != nil {
		return LogEntry{}, false
	}
	e := LogEntry{Prio: 6}
	e.Cursor, _ = raw["__CURSOR"].(string)
	if us, ok := raw["__REALTIME_TIMESTAMP"].(string); ok {
		if n, err := strconv.ParseInt(us, 10, 64); err == nil {
			e.T = n / 1000
		}
	}
	if p, ok := raw["PRIORITY"].(string); ok {
		if n, err := strconv.Atoi(p); err == nil {
			e.Prio = n
		}
	}
	// UNIT / USER_UNIT name the service a systemd message is about ("nginx.service failed"),
	// which is more useful than the sender (init.scope). A *.scope (login session, init) says nothing
	// about who wrote the line, so the program name wins over it.
	for _, k := range []string{"UNIT", "USER_UNIT", "_SYSTEMD_UNIT", "SYSLOG_IDENTIFIER", "_COMM"} {
		if u, ok := raw[k].(string); ok && u != "" {
			if k == "_SYSTEMD_UNIT" && strings.HasSuffix(u, ".scope") {
				if id, _ := raw["SYSLOG_IDENTIFIER"].(string); id != "" {
					u = id
				}
			}
			e.Unit = u
			break
		}
	}
	if e.Unit == "" && raw["_TRANSPORT"] == "kernel" {
		e.Unit = "kernel"
	}
	switch m := raw["MESSAGE"].(type) {
	case string:
		e.Msg = m
	case []any: // non-UTF-8 or binary messages arrive as a byte array
		buf := make([]byte, 0, len(m))
		for _, v := range m {
			if f, ok := v.(float64); ok {
				buf = append(buf, byte(f))
			}
		}
		e.Msg = string(buf)
	}
	e.Msg = scrubLog(strings.TrimRight(e.Msg, "\r\n"))
	return e, e.Cursor != ""
}

type logFilter struct {
	Since, Until int64    // unix seconds; 0 = open
	Prio         int      // show this level and more severe (0–7)
	Unit         string   // optional systemd unit / identifier
	Exclude      []string // units / identifiers to leave out (a noisy service)
	Quiet        bool     // hold back a line repeating 5× in a minute, for 10 minutes
}

func parseFilter(q map[string][]string) (logFilter, error) {
	f := logFilter{Prio: 6}
	if v := first(q["prio"]); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 7 {
			return f, errors.New("prio must be 0–7")
		}
		f.Prio = n
	}
	if v := first(q["unit"]); v != "" {
		if !unitRe.MatchString(v) {
			return f, errors.New("invalid unit name")
		}
		f.Unit = v
	}
	for _, p := range []struct {
		key string
		dst *int64
	}{{"since", &f.Since}, {"until", &f.Until}} {
		if v := first(q[p.key]); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n < 0 || n > 1<<40 {
				return f, errors.New(p.key + " must be unix seconds")
			}
			*p.dst = n
		}
	}
	if v := first(q["exclude"]); v != "" {
		for _, u := range strings.Split(v, ",") {
			if u = strings.TrimSpace(u); u == "" {
				continue
			}
			if !unitRe.MatchString(u) || len(f.Exclude) >= 20 {
				return f, errors.New("invalid service to hide")
			}
			f.Exclude = append(f.Exclude, u)
		}
	}
	f.Quiet = first(q["quiet"]) == "1"
	if f.Since > 0 && f.Until > 0 && f.Until <= f.Since {
		return f, errors.New("until must be after since")
	}
	return f, nil
}

func first(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}

// journalArgs builds a fixed argument list (no shell); the unit name is validated by unitRe.
func journalArgs(f logFilter, extra ...string) []string {
	args := []string{"-o", "json", "--no-pager", "-q", "-p", strconv.Itoa(f.Prio)}
	if f.Unit != "" {
		if strings.Contains(f.Unit, ".") {
			args = append(args, "-u", f.Unit)
		} else {
			args = append(args, "-t", f.Unit) // a syslog identifier such as "kernel" or "sshd"
		}
	}
	if f.Since > 0 {
		args = append(args, "--since", "@"+strconv.FormatInt(f.Since, 10))
	}
	if f.Until > 0 {
		args = append(args, "--until", "@"+strconv.FormatInt(f.Until, 10))
	}
	return append(args, extra...)
}

var errNoJournal = errors.New("journalctl isn't available on this server")

// tailLogs returns up to n recent entries, or the entries after a cursor.
func tailLogs(ctx context.Context, f logFilter, n int, after string) ([]LogEntry, error) {
	if _, err := exec.LookPath("journalctl"); err != nil {
		return nil, errNoJournal
	}
	extra := []string{"-n", strconv.Itoa(n)}
	if after != "" {
		extra = append(extra, "--after-cursor", after)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "journalctl", journalArgs(f, extra...)...).Output()
	if err != nil && len(out) == 0 {
		return nil, err
	}
	var entries []LogEntry
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if e, ok := parseJournalLine(sc.Bytes()); ok {
			entries = append(entries, e)
		}
	}
	return entries, nil
}

// rangeLogs returns the first n entries of a time window (oldest first), continuing after a cursor.
// more is true when the window holds further entries.
func rangeLogs(ctx context.Context, f logFilter, n int, after string) (entries []LogEntry, more bool, err error) {
	if _, err := exec.LookPath("journalctl"); err != nil {
		return nil, false, errNoJournal
	}
	var extra []string
	if after != "" {
		// journalctl takes only one of --since / --after-cursor; the cursor is already inside the window
		f.Since = 0
		extra = []string{"--after-cursor", after}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "journalctl", journalArgs(f, extra...)...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	if err := cmd.Start(); err != nil {
		return nil, false, err
	}
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		e, ok := parseJournalLine(sc.Bytes())
		if !ok {
			continue
		}
		if len(entries) == n { // a week of logs can be millions of lines: stop reading at n+1
			cancel()
			cmd.Wait()
			return entries, true, nil
		}
		entries = append(entries, e)
	}
	if err := cmd.Wait(); err != nil && len(entries) == 0 && ctx.Err() == nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, false, errors.New("journalctl: " + msg)
	}
	return entries, false, nil
}

// followLogs streams new entries (after `backlog` recent ones) until ctx ends.
func followLogs(ctx context.Context, f logFilter, backlog int, emit func(LogEntry) bool) error {
	return followFrom(ctx, f, backlog, "", emit)
}

// followFrom is followLogs that starts right after `cursor` when one is given.
func followFrom(ctx context.Context, f logFilter, backlog int, cursor string, emit func(LogEntry) bool) error {
	if _, err := exec.LookPath("journalctl"); err != nil {
		return errNoJournal
	}
	start := []string{"-f", "-n", strconv.Itoa(backlog)}
	if cursor != "" {
		start = []string{"-f", "--after-cursor", cursor}
	}
	cmd := exec.CommandContext(ctx, "journalctl", journalArgs(f, start...)...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	defer cmd.Wait()
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if e, ok := parseJournalLine(sc.Bytes()); ok && !emit(e) {
			break
		}
	}
	if cmd.Process != nil {
		cmd.Process.Kill()
	}
	return nil
}

// ---------- repeat hold ----------

const (
	holdAfter  = 5   // copies of the same line…
	holdWithin = 60  // …within this many seconds…
	holdFor    = 600 // …hold further copies back for this long
)

type repeat struct {
	times     []int64 // recent copies (seconds), only the last minute
	heldUntil int64
	held      int
}

// quieter applies a viewer's "hide this service" list and the repeat hold to a stream of lines.
// One per viewer / request; memory is bounded (at most 5,000 distinct lines tracked).
type quieter struct {
	exclude  map[string]bool
	quiet    bool
	seen     map[string]*repeat
	prunedAt int64 // last sweep of stale entries (at most once a minute)
}

const maxTracked = 5000

func newQuieter(f logFilter) *quieter {
	q := &quieter{exclude: map[string]bool{}, quiet: f.Quiet, seen: map[string]*repeat{}}
	for _, u := range f.Exclude {
		q.exclude[u] = true
	}
	return q
}

// keep reports whether the line is shown; it marks the copy that starts a hold (Hold) and the first
// copy after one (Held = how many were held back).
func (q *quieter) keep(e *LogEntry) bool {
	if q.exclude[e.Unit] {
		return false
	}
	if !q.quiet {
		return true
	}
	t := e.T / 1000
	k := eventKey(e.Unit, e.Msg) // digits ignored: "worker 123 exited" and "worker 456 exited" are one line
	r := q.seen[k]
	if r == nil {
		if len(q.seen) >= maxTracked && t-q.prunedAt >= holdWithin {
			// sweep at most once a minute: a flood of unique lines can't make every line an O(n) scan
			q.prunedAt = t
			for key, x := range q.seen {
				if x.heldUntil <= t && (len(x.times) == 0 || x.times[len(x.times)-1] < t-holdWithin) {
					delete(q.seen, key)
				}
			}
		}
		if len(q.seen) >= maxTracked {
			return true // full: show the line without tracking it, so memory stays bounded whatever arrives
		}
		r = &repeat{}
		q.seen[k] = r
	}
	if t < r.heldUntil {
		r.held++
		return false
	}
	if r.held > 0 {
		e.Held, r.held = r.held, 0
	}
	recent := r.times[:0]
	for _, x := range r.times {
		if x > t-holdWithin {
			recent = append(recent, x)
		}
	}
	r.times = append(recent, t)
	if len(r.times) >= holdAfter {
		r.heldUntil, r.times, e.Hold = t+holdFor, nil, holdFor
	}
	return true
}

// ---------- failures ----------

// Event is a failure worth keeping: an error in the logs, a crash, or a sustained threshold breach.
type Event struct {
	ID     uint64   `json:"id"`
	T      int64    `json:"t"` // unix seconds (first seen)
	Last   int64    `json:"last"`
	Count  int      `json:"n"`
	Sev    string   `json:"sev"`  // critical | error | warning
	Kind   string   `json:"kind"` // log | service | memory | disk | crash | cpu | temp
	Source string   `json:"src"`
	Msg    string   `json:"msg"`
	More   []string `json:"more,omitempty"` // the incident's other lines (same source, within seconds), up to 8
	saved  int64    // when this version was last written to disk
}

// kindRank: which line of an incident is its headline ("nginx.service: Failed with result" beats the
// raw error lines the program printed just before).
func kindRank(kind string) int {
	if kind == "log" {
		return 0
	}
	return 1
}

func sevRank(sev string) int {
	switch sev {
	case "critical":
		return 3
	case "error":
		return 2
	case "warning":
		return 1
	}
	return 0
}

type rule struct {
	re   *regexp.Regexp
	sev  string
	kind string
}

// Patterns that matter even when the message's own priority understates them.
var rules = []rule{
	{regexp.MustCompile(`(?i)out of memory|oom[-_ ]kill|invoked oom-killer|Killed process \d+`), "critical", "memory"},
	{regexp.MustCompile(`(?i)\b(I/O error|EXT4-fs error|XFS .*error|blk_update_request|Buffer I/O error|nvme.*(timeout|error)|SMART.*(fail|error))`), "critical", "disk"},
	{regexp.MustCompile(`(?i)kernel panic|watchdog: BUG|soft lockup|hard LOCKUP|Hardware Error|Machine check`), "critical", "crash"},
	{regexp.MustCompile(`(?i)segfault|core dumped|general protection fault`), "error", "crash"},
	{regexp.MustCompile(`(?i)Failed with result|Failed to start|failed with error|entered failed state|Main process exited, code=(killed|dumped)`), "error", "service"},
}

// classify decides whether a log entry is a failure, and how bad.
func classify(e LogEntry) (sev, kind string, ok bool) {
	for _, r := range rules {
		if r.re.MatchString(e.Msg) {
			return r.sev, r.kind, true
		}
	}
	switch {
	case e.Prio <= 2:
		return "critical", "log", true
	case e.Prio == 3:
		return "error", "log", true
	}
	return "", "", false
}

var digitsRe = regexp.MustCompile(`\d+`)

// EventLog keeps recent failures in memory and appends them to a file, so history survives restarts.
// Repeats of the same message from the same source within 10 minutes are counted, not stored again.
type EventLog struct {
	mu     sync.Mutex
	path   string
	Epoch  string // identifies this agent's event numbering (regenerated if its state is wiped)
	next   uint64
	events []Event // ring, oldest first
	byKey  map[string]int
	minute int64
	inMin  [2]int // new events this minute: [critical, everything else]
	lines  int    // lines in the file, compacted when it grows past 2×maxEvents
}

const maxEvents = 2000

func OpenEventLog(dir string) *EventLog {
	l := &EventLog{path: filepath.Join(dir, "events.jsonl"), byKey: map[string]int{}}
	epochFile := filepath.Join(dir, "events.epoch")
	if b, err := os.ReadFile(epochFile); err == nil && len(b) >= 8 {
		l.Epoch = strings.TrimSpace(string(b))
	} else {
		r := make([]byte, 8)
		rand.Read(r)
		l.Epoch = hex.EncodeToString(r)
		os.WriteFile(epochFile, []byte(l.Epoch), 0o600)
	}
	if f, err := os.Open(l.path); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			var e Event
			if json.Unmarshal(sc.Bytes(), &e) == nil && e.ID > 0 {
				l.events = append(l.events, e) // later lines for the same id (repeat counts) win below
			}
		}
		f.Close()
		l.compact()
	}
	l.reindex()
	for _, e := range l.events {
		if e.ID >= l.next {
			l.next = e.ID + 1
		}
	}
	if l.next == 0 {
		l.next = 1
	}
	return l
}

// compact keeps the newest version of each event and at most maxEvents, then rewrites the file.
func (l *EventLog) compact() {
	latest := map[uint64]int{}
	var out []Event
	for _, e := range l.events {
		if i, ok := latest[e.ID]; ok {
			out[i] = e
			continue
		}
		latest[e.ID] = len(out)
		out = append(out, e)
	}
	if len(out) > maxEvents {
		out = out[len(out)-maxEvents:]
	}
	l.events = out
	l.lines = len(out)
	// on a full disk the old file stays (it holds the history); the next compaction tries again
	writeAtomic(l.path, func(w *bufio.Writer) error {
		for _, e := range out {
			b, _ := json.Marshal(e)
			if _, err := w.Write(append(b, '\n')); err != nil {
				return err
			}
		}
		return nil
	})
}

func eventKey(source, msg string) string { return source + "|" + digitsRe.ReplaceAllString(msg, "#") }

func (l *EventLog) reindex() {
	l.byKey = map[string]int{}
	for i, e := range l.events {
		l.byKey[eventKey(e.Source, e.Msg)] = i
		for _, m := range e.More {
			l.byKey[eventKey(e.Source, m)] = i
		}
	}
}

// Add records a failure (or bumps the count of a recent identical one). Returns false when dropped
// by the flood guard: more than 60 new failures in one minute. Critical ones (OOM, disk, panic) have
// their own budget, so a chatty app can't crowd them out.
func (l *EventLog) Add(t int64, sev, kind, source, msg string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := eventKey(source, msg)
	if i, ok := l.byKey[key]; ok && i < len(l.events) && t-l.events[i].Last < 600 {
		e := &l.events[i]
		if key == eventKey(e.Source, e.Msg) {
			e.Count++ // the headline repeating counts; its companion lines repeating with it don't
		}
		e.Last = t
		if t-e.saved >= 60 { // a line repeating 1000×/s costs one write a minute, not 1000/s
			e.saved = t
			l.appendLine(*e)
		}
		return true
	}
	// one crash prints several lines at once: they are one failure, not five rows
	if source != "" && source != "server-pulse" {
		for i := len(l.events) - 1; i >= 0 && i >= len(l.events)-20; i-- {
			e := &l.events[i]
			// only lines from the incident's first seconds join it, and at most 8: a program printing a new
			// error every second still gets separate failures
			if e.Source != source || t-e.T > 3 || t < e.T-3 || len(e.More) >= 8 {
				continue
			}
			if kindRank(kind) > kindRank(e.Kind) {
				e.More = append([]string{e.Msg}, e.More...)
				e.Msg, e.Kind = msg, kind
			} else {
				e.More = append(e.More, msg)
			}
			if sevRank(sev) > sevRank(e.Sev) {
				e.Sev = sev
			}
			e.Last = t
			l.byKey[key] = i
			e.saved = t
			l.appendLine(*e)
			return true
		}
	}
	if m := t / 60; m != l.minute {
		l.minute, l.inMin = m, [2]int{}
	}
	b := 1
	if sev == "critical" {
		b = 0
	}
	if l.inMin[b]++; l.inMin[b] > 60 {
		return false
	}
	e := Event{ID: l.next, T: t, Last: t, Count: 1, Sev: sev, Kind: kind, Source: source, Msg: msg, saved: t}
	l.next++
	l.events = append(l.events, e)
	l.byKey[key] = len(l.events) - 1
	l.appendLine(e)
	return true
}

func (l *EventLog) appendLine(e Event) {
	if l.lines >= maxEvents*2 { // repeats and new events both grow the file
		l.compact()
		l.reindex()
		return // compact wrote the current state, e included
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	b, _ := json.Marshal(e)
	f.Write(append(b, '\n'))
	f.Close()
	l.lines++
}

// Since returns events newer than id `after`, plus older ones that repeated since `updatedSince`
// (their count changed), so the dashboard's copy stays exact.
func (l *EventLog) Since(after uint64, updatedSince int64, limit int) []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []Event
	for _, e := range l.events {
		if e.ID > after || (updatedSince > 0 && e.Last >= updatedSince && e.Count > 1) {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

// Recent returns the newest n events (newest first).
func (l *EventLog) Recent(n int) []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Event, 0, n)
	for i := len(l.events) - 1; i >= 0 && len(out) < n; i-- {
		out = append(out, l.events[i])
	}
	return out
}

// watchJournal turns error-level and pattern-matched journal lines into events, for as long as ctx lives.
//
// It remembers its place in cursorFile, so whatever was logged while the agent was stopped, restarting
// or the machine was booting (often the crash or OOM kill that took it down) is still classified.
func watchJournal(ctx context.Context, l *EventLog, cursorFile string) {
	cursor := savedCursor(cursorFile)
	lastSave := time.Now()
	for ctx.Err() == nil {
		started := time.Now()
		got := 0
		err := followFrom(ctx, logFilter{Prio: 6}, 0, cursor, func(e LogEntry) bool {
			got++
			if sev, kind, ok := classify(e); ok {
				l.Add(e.T/1000, sev, kind, e.Unit, e.Msg)
			}
			cursor = e.Cursor
			if time.Since(lastSave) > 10*time.Second {
				saveCursor(cursorFile, cursor)
				lastSave = time.Now()
			}
			return ctx.Err() == nil
		})
		if cursor != "" {
			saveCursor(cursorFile, cursor)
		}
		if errors.Is(err, errNoJournal) {
			return
		}
		if got == 0 && time.Since(started) < 3*time.Second && cursor != "" && ctx.Err() == nil {
			cursor = "" // journalctl rejected the cursor (journal rotated or vacuumed): start at the tail
			os.Remove(cursorFile)
		}
		select { // journalctl exited (rotation, restart): start it again
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

func saveCursor(path, cursor string) {
	writeAtomic(path, func(w *bufio.Writer) error { _, err := w.WriteString(cursor); return err })
}

// savedCursor returns the remembered journal position, unless it is over a week old: catching up a
// month of logs after a long stop would only flood the history with stale failures.
func savedCursor(path string) string {
	st, err := os.Stat(path)
	if err != nil || time.Since(st.ModTime()) > 7*24*time.Hour {
		return ""
	}
	b, _ := os.ReadFile(path)
	c := strings.TrimSpace(string(b))
	if len(c) > 300 || strings.ContainsAny(c, "\n\x00") {
		return ""
	}
	return c
}

// ---------- threshold failures from the 1-second samples ----------

// thresholds fires an event when a value stays past its limit for long enough, once per crossing,
// and re-arms after it has been back to normal.
type thresholds struct {
	since map[string]int64 // key → when it first went over
	fired map[string]bool
}

type limit struct {
	key, sev, kind, what string
	over                 float64
	hold                 int64 // seconds it must stay over
}

var limits = []limit{
	{"cpu", "warning", "cpu", "CPU", 95, 300},
	{"mem", "error", "memory", "Memory", 95, 120},
	{"disk", "warning", "disk", "Disk / space", 90, 60},
	{"temp", "critical", "temp", "CPU temperature", 90, 60},
}

func (th *thresholds) check(l *EventLog, now int64, values map[string]float64) {
	if th.since == nil {
		th.since, th.fired = map[string]int64{}, map[string]bool{}
	}
	for _, lim := range limits {
		v, ok := values[lim.key]
		if !ok {
			continue
		}
		if v < lim.over-2 { // 2-point hysteresis so a value hovering at the limit doesn't flap
			delete(th.since, lim.key)
			th.fired[lim.key] = false
			continue
		}
		if v < lim.over {
			continue
		}
		if _, ok := th.since[lim.key]; !ok {
			th.since[lim.key] = now
		}
		if !th.fired[lim.key] && now-th.since[lim.key] >= lim.hold {
			th.fired[lim.key] = true
			unit := "%"
			if lim.key == "temp" {
				unit = "°C"
			}
			l.Add(now, lim.sev, lim.kind, "server-pulse", lim.what+" at "+strconv.Itoa(int(v))+unit+" for "+strconv.FormatInt(lim.hold/60, 10)+"+ minutes")
		}
	}
}

// thresholdValues extracts the watched values from a Netdata-style sample.
func thresholdValues(s map[string][]float64) map[string]float64 {
	out := map[string]float64{}
	if v, ok := s["system.cpu"]; ok {
		t := 0.0
		for _, x := range v {
			t += x
		}
		out["cpu"] = t
	}
	if v, ok := s["system.ram"]; ok && len(v) == 4 {
		if total := v[0] + v[1] + v[2] + v[3]; total > 0 {
			out["mem"] = v[1] / total * 100
		}
	}
	if v, ok := s["disk_space._"]; ok && len(v) == 3 && v[0]+v[1] > 0 {
		out["disk"] = v[1] / (v[0] + v[1]) * 100
	}
	if v, ok := s["sensors.temperature"]; ok {
		m := 0.0
		for _, x := range v {
			if x > m {
				m = x
			}
		}
		if m > 0 {
			out["temp"] = m
		}
	}
	return out
}

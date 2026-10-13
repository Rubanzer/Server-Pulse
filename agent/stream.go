package main

import (
	"compress/gzip"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- stream tokens ----------
// The dashboard (Vercel) mints a token for a logged-in user: v1.<exp>.<nonce>.<sig>, where
// sig = HMAC-SHA256(key, "v1.<exp>.<nonce>") and key = HMAC-SHA256(dashboard password, "server-pulse stream v1").
// No new secret to pair: whoever holds the server link can mint, nobody else can. Tokens live ≤ 2 min,
// are single-use (nonce cache), and travel in the Authorization header, never in the URL.

const (
	tokenMaxTTL = 120 // seconds
	tokenSkew   = 30  // tolerated clock difference between the dashboard and this server
)

func streamKey(password string) []byte {
	m := hmac.New(sha256.New, []byte(password))
	m.Write([]byte("server-pulse stream v1"))
	return m.Sum(nil)
}

type nonceCache struct {
	mu   sync.Mutex
	seen map[string]int64 // nonce → expiry
}

// use records a nonce; false if already used or the cache is full (fail closed).
func (c *nonceCache) use(nonce string, exp, now int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen == nil {
		c.seen = map[string]int64{}
	}
	if len(c.seen) > 1000 {
		for n, e := range c.seen {
			if e+tokenSkew+10 < now { // only once the token itself can no longer be accepted
				delete(c.seen, n)
			}
		}
		if len(c.seen) > 10000 {
			return false
		}
	}
	if _, dup := c.seen[nonce]; dup {
		return false
	}
	c.seen[nonce] = exp
	return true
}

// verifyToken checks a stream token for the given scope. "v1.<exp>.<nonce>.<sig>" is the original
// live-view token (scope "pulse"); "v2.<scope>.<exp>.<nonce>.<sig>" carries an explicit scope, so a
// token minted for the live view can never open the logs.
func verifyToken(tok string, key []byte, nonces *nonceCache, now int64, scope string) error {
	parts := strings.Split(tok, ".")
	var signed, expS, nonce, sig string
	switch {
	case len(parts) == 4 && parts[0] == "v1" && scope == "pulse":
		expS, nonce, sig = parts[1], parts[2], parts[3]
		signed = "v1." + expS + "." + nonce
	case len(parts) == 5 && parts[0] == "v2" && parts[1] == scope:
		expS, nonce, sig = parts[2], parts[3], parts[4]
		signed = "v2." + scope + "." + expS + "." + nonce
	default:
		return errors.New("malformed token")
	}
	if len(nonce) < 16 {
		return errors.New("malformed token")
	}
	exp, err := strconv.ParseInt(expS, 10, 64)
	if err != nil {
		return errors.New("malformed token")
	}
	m := hmac.New(sha256.New, key)
	m.Write([]byte(signed))
	want := m.Sum(nil)
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(got, want) {
		return errors.New("bad signature")
	}
	if exp < now-tokenSkew || exp > now+tokenMaxTTL+tokenSkew {
		return errors.New("token expired")
	}
	if !nonces.use(nonce, exp, now) {
		return errors.New("token already used")
	}
	return nil
}

// ---------- hub: one sampler, many viewers ----------

const (
	maxViewers   = 8
	maxPerIP     = 3
	maxSession   = 15 * time.Minute
	writeTimeout = 5 * time.Second
)

type Hub struct {
	pulse   *Pulse
	key     []byte
	origins map[string]bool // empty = any origin (the token is what authorizes)
	nonces  nonceCache

	fmu sync.Mutex // serializes Pulse.Frame (it keeps previous readings for rates)

	mu         sync.Mutex
	viewers    map[chan []byte]string // → client IP
	perIP      map[string]int
	running    bool
	logViewers int
	last       []byte // latest full frame, for the snapshot endpoint
	fails      map[string][]int64
	blockTo    map[string]int64
}

func NewHub(p *Pulse, password string, origins []string) *Hub {
	h := &Hub{pulse: p, key: streamKey(password), origins: map[string]bool{},
		viewers: map[chan []byte]string{}, perIP: map[string]int{}, fails: map[string][]int64{}, blockTo: map[string]int64{}}
	for _, o := range origins {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" {
			h.origins[o] = true
		}
	}
	return h
}

// sampler runs only while someone is watching; it encodes each frame once and fans the bytes out.
func (h *Hub) sampler() {
	var seq uint64
	for tick := 0; ; tick++ {
		h.mu.Lock()
		if len(h.viewers) == 0 {
			h.running = false
			h.mu.Unlock()
			return
		}
		h.mu.Unlock()

		now := time.Now()
		keyframe := tick%30 == 0
		h.fmu.Lock()
		f := h.pulse.Frame(float64(now.UnixNano())/1e9, seq, tick%10 == 0, tick%3 == 0, tick%5 == 0, keyframe)
		h.fmu.Unlock()
		seq++
		b, _ := json.Marshal(f)
		b = append(b, '\n')

		h.mu.Lock()
		if keyframe {
			h.last = b
		}
		for ch := range h.viewers {
			select { // latest frame wins: a slow viewer skips frames instead of buffering them
			case <-ch:
			default:
			}
			ch <- b
		}
		h.mu.Unlock()
		time.Sleep(time.Until(now.Truncate(time.Second).Add(time.Second)))
	}
}

func (h *Hub) join(ip string) (chan []byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.viewers) >= maxViewers {
		return nil, errors.New("too many viewers")
	}
	if h.perIP[ip] >= maxPerIP {
		return nil, errors.New("too many connections from this address")
	}
	ch := make(chan []byte, 1)
	h.viewers[ch] = ip
	h.perIP[ip]++
	if !h.running {
		h.running = true
		h.last = nil
		go h.sampler()
	}
	return ch, nil
}

func (h *Hub) leave(ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ip, ok := h.viewers[ch]; ok {
		delete(h.viewers, ch)
		if h.perIP[ip]--; h.perIP[ip] <= 0 {
			delete(h.perIP, ip)
		}
	}
}

// failed records a bad token: 5 failures within a minute block that address for 10 minutes.
func (h *Hub) failed(ip string, now int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	recent := h.fails[ip][:0]
	for _, t := range h.fails[ip] {
		if now-t < 60 {
			recent = append(recent, t)
		}
	}
	recent = append(recent, now)
	h.fails[ip] = recent
	if len(recent) >= 5 {
		h.blockTo[ip] = now + 600
		delete(h.fails, ip)
	}
	if len(h.fails) > 10000 { // bounded memory under a spray of addresses
		h.fails = map[string][]int64{}
	}
}

func (h *Hub) blocked(ip string, now int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	until, ok := h.blockTo[ip]
	if ok && now >= until {
		delete(h.blockTo, ip)
		return false
	}
	return ok
}

// ---------- HTTP ----------

// clientIP is the address used for per-IP caps and blocking. X-Forwarded-For is only believed when the
// connection itself comes from this machine (a local tunnel agent such as ngrok forwarding to
// 127.0.0.1:19998), and then only its LAST entry, which that proxy appended; earlier entries are
// whatever the client claimed. Everyone else is identified by the socket address.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if f := r.Header.Get("X-Forwarded-For"); f != "" {
			parts := strings.Split(f, ",")
			if last := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(last) != nil {
				return last
			}
		}
	}
	return host
}

// cors answers preflights and sets headers for allowed origins; false if the origin is not allowed.
func (h *Hub) cors(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // not a browser cross-origin request (curl, the dashboard server)
	}
	if len(h.origins) > 0 && !h.origins[origin] {
		return false
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Headers", "authorization, ngrok-skip-browser-warning")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Max-Age", "600")
	return true
}

// ServeStream: GET /api/v1/pulse/stream with "Authorization: Bearer <token>" → NDJSON, gzip, 1 frame/s.
func (h *Hub) ServeStream(w http.ResponseWriter, r *http.Request) {
	if !h.cors(w, r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ip, now := clientIP(r), time.Now().Unix()
	if h.blocked(ip, now) {
		http.Error(w, "too many failed attempts, try again later", http.StatusTooManyRequests)
		return
	}
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if err := verifyToken(tok, h.key, &h.nonces, now, "pulse"); err != nil {
		h.failed(ip, now)
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	ch, err := h.join(ip)
	if err != nil {
		http.Error(w, err.Error(), http.StatusTooManyRequests)
		return
	}
	defer h.leave(ch)

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	var out interface {
		Write([]byte) (int, error)
		Flush() error
	} = nopFlusher{w}
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		gz, _ := gzip.NewWriterLevel(w, gzip.BestSpeed) // one stream: later frames compress against earlier ones
		defer gz.Close()
		out = gz
	}
	w.WriteHeader(http.StatusOK)

	end := time.After(maxSession)
	for {
		select {
		case <-r.Context().Done():
			return
		case <-end:
			return // the browser reconnects with a fresh token
		case b := <-ch:
			rc.SetWriteDeadline(time.Now().Add(writeTimeout))
			if _, err := out.Write(b); err != nil {
				return
			}
			if out.Flush() != nil || rc.Flush() != nil {
				return
			}
		}
	}
}

type nopFlusher struct{ w http.ResponseWriter }

func (n nopFlusher) Write(b []byte) (int, error) { return n.w.Write(b) }
func (n nopFlusher) Flush() error                { return nil }

// Snapshot: GET /api/v1/pulse (basic auth) — one full frame, for the dashboard's server-side fallback.
func (h *Hub) Snapshot(w http.ResponseWriter, _ *http.Request) {
	h.mu.Lock()
	last := h.last
	running := h.running
	h.mu.Unlock()
	if running && last != nil {
		w.Header().Set("Content-Type", "application/json")
		w.Write(last)
		return
	}
	// nobody is streaming: take two readings 0.5 s apart so rates are real
	h.fmu.Lock()
	defer h.fmu.Unlock()
	h.pulse.Frame(float64(time.Now().UnixNano())/1e9, 0, false, true, false, false)
	time.Sleep(500 * time.Millisecond)
	writeJSON(w, h.pulse.Frame(float64(time.Now().UnixNano())/1e9, 0, true, true, true, true))
}

// ---------- live logs ----------

const maxLogViewers = 3

// ServeLogs: GET /api/v1/logs/stream?prio=&unit= with "Authorization: Bearer v2.logs…" → NDJSON lines
// (the 200 most recent first, then live), gzip, ≤ 15 min per session. Messages are scrubbed of secrets.
func (h *Hub) ServeLogs(w http.ResponseWriter, r *http.Request) {
	if !h.cors(w, r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ip, now := clientIP(r), time.Now().Unix()
	if h.blocked(ip, now) {
		http.Error(w, "too many failed attempts, try again later", http.StatusTooManyRequests)
		return
	}
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if err := verifyToken(tok, h.key, &h.nonces, now, "logs"); err != nil {
		h.failed(ip, now)
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	f, err := parseFilter(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	f.Since, f.Until = 0, 0 // live only; past windows go through /api/v1/logs
	h.mu.Lock()
	if h.logViewers >= maxLogViewers {
		h.mu.Unlock()
		http.Error(w, "too many log viewers", http.StatusTooManyRequests)
		return
	}
	h.logViewers++
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.logViewers--
		h.mu.Unlock()
	}()

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	var out interface {
		Write([]byte) (int, error)
		Flush() error
	} = nopFlusher{w}
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		gz, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
		defer gz.Close()
		out = gz
	}
	w.WriteHeader(http.StatusOK)

	ctx, cancel := context.WithTimeout(r.Context(), maxSession)
	defer cancel()
	var wmu sync.Mutex
	send := func(b []byte) bool {
		wmu.Lock()
		defer wmu.Unlock()
		rc.SetWriteDeadline(time.Now().Add(writeTimeout))
		if _, err := out.Write(b); err != nil {
			return false
		}
		return out.Flush() == nil && rc.Flush() == nil
	}
	if !send([]byte("\n")) { // headers and the gzip header go out now, not with the first matching line
		return
	}
	go func() {
		t := time.NewTicker(logHeartbeat)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if !send([]byte("\n")) { // the client skips blank lines
					cancel() // dead connection: stop journalctl and free the viewer slot
					return
				}
			}
		}
	}()
	err = followLogs(ctx, f, 200, func(e LogEntry) bool {
		b, _ := json.Marshal(e)
		return send(append(b, '\n'))
	})
	if err != nil {
		b, _ := json.Marshal(map[string]string{"error": err.Error()})
		send(append(b, '\n'))
	}
}

const logHeartbeat = 20 * time.Second

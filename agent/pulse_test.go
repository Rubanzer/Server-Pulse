package main

import (
	"bufio"
	"compress/gzip"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func mintToken(password string, exp int64, nonce string) string {
	m := hmac.New(sha256.New, streamKey(password))
	m.Write([]byte("v1." + strconv.FormatInt(exp, 10) + "." + nonce))
	return "v1." + strconv.FormatInt(exp, 10) + "." + nonce + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func TestVerifyToken(t *testing.T) {
	key := streamKey("pw-abcdefghijkl")
	now := int64(1_000_000)
	var nc nonceCache
	good := mintToken("pw-abcdefghijkl", now+60, "nonce-0123456789ab")
	if err := verifyToken(good, key, &nc, now, "pulse"); err != nil {
		t.Fatal(err)
	}
	if verifyToken(good, key, &nc, now, "pulse") == nil {
		t.Fatal("replay must fail")
	}
	cases := map[string]string{
		"wrong password": mintToken("other-password", now+60, "nonce-aaaaaaaaaaaa"),
		"expired":        mintToken("pw-abcdefghijkl", now-100, "nonce-bbbbbbbbbbbb"),
		"too far ahead":  mintToken("pw-abcdefghijkl", now+3600, "nonce-cccccccccccc"),
		"short nonce":    mintToken("pw-abcdefghijkl", now+60, "short"),
		"garbage":        "v1.x.y",
		"tampered":       strings.Replace(mintToken("pw-abcdefghijkl", now+60, "nonce-dddddddddddd"), "nonce-d", "nonce-e", 1),
	}
	for name, tok := range cases {
		if verifyToken(tok, key, &nc, now, "pulse") == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestScrubArgs(t *testing.T) {
	in := strings.Join([]string{"ngrok", "http", "7681", "--basic-auth=btopadmin:Tushar#1", "--password", "hunter2",
		"DB_PASSWORD=s3cret", "https://user:pw@example.com/x", "AKIAABCDEFGHIJKLMNOPQRSTUV", "--port", "80"}, "\x00") + "\x00"
	out := scrubArgs([]byte(in))
	for _, leak := range []string{"Tushar", "hunter2", "s3cret", "user:pw", "AKIAABCDEFGHIJKLMNOPQRSTUV"} {
		if strings.Contains(out, leak) {
			t.Fatalf("leaked %q in %q", leak, out)
		}
	}
	for _, keep := range []string{"ngrok http 7681", "--basic-auth=•••", "--password •••", "DB_PASSWORD=•••", "https://•••@example.com/x", "--port 80"} {
		if !strings.Contains(out, keep) {
			t.Fatalf("missing %q in %q", keep, out)
		}
	}
}

func TestParsePidStat(t *testing.T) {
	// comm with spaces and parentheses; utime=11th field after ")" etc.
	b := []byte("4242 (Web Content (x)) S 1 4242 4242 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 7 0 12345 1000000 2500 18446744073709551615")
	name, ticks, thr, ok := parsePidStat(b)
	if !ok || name != "Web Content (x)" || ticks != 200 || thr != 7 {
		t.Fatalf("got %q %d %d %v", name, ticks, thr, ok)
	}
}

func TestRealMountsFilter(t *testing.T) {
	root := t.TempDir()
	mi := strings.Join([]string{
		`29 1 8:2 / / rw,relatime - ext4 /dev/sda2 rw`,
		`30 29 8:2 / /home rw - ext4 /dev/sda2 rw`, // same device: deduped
		`31 29 0:5 / /tmp rw - tmpfs tmpfs rw`,
		`32 29 7:0 / /snap/core/1 ro - squashfs /dev/loop0 ro`,
		`33 29 0:40 / /var/lib/docker/x rw - overlay overlay rw`,
		`34 29 8:1 / /boot/efi rw - vfat /dev/sda1 rw`,
	}, "\n")
	os.MkdirAll(filepath.Join(root, "boot/efi"), 0o755) // statfs needs the mount points to exist
	m := realMounts([]byte(mi), root)
	if len(m) != 2 {
		t.Fatalf("want / and /boot/efi, got %+v", m)
	}
	if m[0].Dev != "sda2" && m[1].Dev != "sda2" {
		t.Fatalf("missing root disk: %+v", m)
	}
}

func TestPerCoreTempsMapHyperthreads(t *testing.T) {
	root := t.TempDir()
	w := func(p, s string) {
		full := filepath.Join(root, p)
		os.MkdirAll(filepath.Dir(full), 0o755)
		os.WriteFile(full, []byte(s), 0o644)
	}
	// 4 logical CPUs = 2 physical cores × 2 threads; core ids non-contiguous (0 and 4)
	for i, core := range []string{"0", "4", "0", "4"} {
		w("sys/devices/system/cpu/cpu"+strconv.Itoa(i)+"/topology/core_id", core)
		w("sys/devices/system/cpu/cpu"+strconv.Itoa(i)+"/topology/physical_package_id", "0")
	}
	w("sys/class/hwmon/hwmon1/name", "coretemp")
	w("sys/class/hwmon/hwmon1/temp1_label", "Package id 0")
	w("sys/class/hwmon/hwmon1/temp1_input", "61000")
	w("sys/class/hwmon/hwmon1/temp2_label", "Core 0")
	w("sys/class/hwmon/hwmon1/temp2_input", "40000")
	w("sys/class/hwmon/hwmon1/temp3_label", "Core 4")
	w("sys/class/hwmon/hwmon1/temp3_input", "55000")
	w("proc/stat", "cpu  1 0 1 10 0 0 0 0\ncpu0 1 0 1 10 0 0 0 0\ncpu1 1 0 1 10 0 0 0 0\ncpu2 1 0 1 10 0 0 0 0\ncpu3 1 0 1 10 0 0 0 0\n")
	p := NewPulse(root, false)
	if p.logical != 4 || p.physical != 2 {
		t.Fatalf("logical %d physical %d", p.logical, p.physical)
	}
	f := p.Frame(100, 0, false, false, false, true)
	want := []int{40, 55, 40, 55}
	for i := range want {
		if f.CPU.Temps[i] != want[i] {
			t.Fatalf("temps %v want %v", f.CPU.Temps, want)
		}
	}
	if f.CPU.Pkg != 61 || f.CPU.Physical != 2 {
		t.Fatalf("pkg %d physical %d", f.CPU.Pkg, f.CPU.Physical)
	}
}

func TestStreamEndToEnd(t *testing.T) {
	const pw = "stream-test-password"
	hub := NewHub(NewPulse("/", false), pw, []string{"https://pulse.example.com"})
	api := NewAPI(hub, NewStore(testCharts), testCharts, "dashboard", pw, func() map[string]any { return nil })
	srv := httptest.NewServer(api.Handler())
	defer srv.Close()

	req := func(origin, tok string) *http.Response {
		r, _ := http.NewRequest("GET", srv.URL+"/history/api/v1/pulse/stream", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if tok != "" {
			r.Header.Set("Authorization", "Bearer "+tok)
		}
		r.Header.Set("Accept-Encoding", "gzip")
		res, err := (&http.Transport{DisableCompression: true}).RoundTrip(r)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	now := time.Now().Unix()
	if r := req("https://evil.example", mintToken(pw, now+60, "nonce-evil-000000000")); r.StatusCode != 403 {
		t.Fatalf("foreign origin → %d", r.StatusCode)
	}
	if r := req("https://pulse.example.com", "nope"); r.StatusCode != 401 {
		t.Fatalf("bad token → %d", r.StatusCode)
	}
	res := req("https://pulse.example.com", mintToken(pw, now+60, "nonce-good-000000000"))
	defer res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Access-Control-Allow-Origin") != "https://pulse.example.com" || res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("status %d headers %v", res.StatusCode, res.Header)
	}
	gz, err := gzip.NewReader(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(gz)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	var frames []Frame
	for len(frames) < 2 && sc.Scan() {
		var f Frame
		if err := json.Unmarshal(sc.Bytes(), &f); err != nil {
			t.Fatalf("bad frame %q: %v", sc.Text(), err)
		}
		frames = append(frames, f)
	}
	if len(frames) < 2 || frames[1].Seq != frames[0].Seq+1 || len(frames[0].CPU.Cores) == 0 || frames[0].Mem.Total == 0 {
		t.Fatalf("frames %+v", frames)
	}
	if frames[0].CPU.Model == "" && frames[0].Seq == 0 {
		t.Log("no model name in this environment's /proc/cpuinfo")
	}
	// basic-auth API still protected
	if r, _ := http.Get(srv.URL + "/api/v1/pulse"); r.StatusCode != 401 {
		t.Fatalf("snapshot without password → %d", r.StatusCode)
	}
}

func TestStatusOnlyForLocalRequests(t *testing.T) {
	api := NewAPI(nil, NewStore(testCharts), testCharts, "dashboard", "pw-123456789012", func() map[string]any { return map[string]any{"tunnel": "off"} })
	h := api.LocalHandler()
	local := httptest.NewRequest("GET", "http://127.0.0.1:19998/agent/status", nil)
	local.Host = "127.0.0.1:19998"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, local)
	if rec.Code != 200 {
		t.Fatalf("local status → %d", rec.Code)
	}
	tunneled := httptest.NewRequest("GET", "http://x.ngrok-free.dev/agent/status", nil)
	tunneled.Host = "x.ngrok-free.dev"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, tunneled)
	if rec.Code != 401 {
		t.Fatalf("status through a tunnel must need the password, got %d", rec.Code)
	}
}

func TestPairWithDashboard(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/pair" || r.Method != "POST" {
			http.NotFound(w, r)
			return
		}
		json.NewDecoder(r.Body).Decode(&got)
		if got["code"] == "GOOD-CODE" {
			w.Write([]byte(`{"ok":true}`))
			return
		}
		w.WriteHeader(400)
		w.Write([]byte(`{"ok":false,"error":"This pairing code is wrong, expired or already used."}`))
	}))
	defer srv.Close()
	if err := pairWithDashboard(srv.URL, "GOOD-CODE", "https://dashboard:pw@x.ts.net/history"); err != nil {
		t.Fatal(err)
	}
	if got["link"] != "https://dashboard:pw@x.ts.net/history" || got["version"] == "" {
		t.Fatalf("sent %v", got)
	}
	if err := pairWithDashboard(srv.URL, "BAD", "https://x"); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("want the dashboard's message, got %v", err)
	}
}

func TestOriginOf(t *testing.T) {
	for in, want := range map[string]string{
		"https://pulse.vercel.app/connect?x=1": "https://pulse.vercel.app",
		" https://a.b ":                        "https://a.b",
		"ftp://x":                              "",
		"nonsense":                             "",
	} {
		if got := originOf(in); got != want {
			t.Errorf("originOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClientIPCannotBeSpoofed(t *testing.T) {
	mk := func(remote, xff string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}
	// straight from the internet (Funnel): the header is ignored
	if got := clientIP(mk("203.0.113.7:5555", "1.2.3.4")); got != "203.0.113.7" {
		t.Fatalf("direct client spoofed its IP: %s", got)
	}
	// via a local proxy (ngrok → 127.0.0.1): only the proxy-appended last entry counts
	if got := clientIP(mk("127.0.0.1:40000", "9.9.9.9, 198.51.100.4")); got != "198.51.100.4" {
		t.Fatalf("local proxy: %s", got)
	}
	if got := clientIP(mk("127.0.0.1:40000", "garbage")); got != "127.0.0.1" {
		t.Fatalf("bad header: %s", got)
	}
}

func TestSecureOrigin(t *testing.T) {
	for o, want := range map[string]bool{
		"https://pulse.vercel.app":  true,
		"http://pulse.vercel.app":   false,
		"http://localhost:3000":     true,
		"http://127.0.0.1:3150":     true,
		"http://evil.localhost.com": false,
	} {
		if secureOrigin(o) != want {
			t.Errorf("secureOrigin(%q) != %v", o, want)
		}
	}
}

func mintScoped(password, scope string, exp int64, nonce string) string {
	m := hmac.New(sha256.New, streamKey(password))
	signed := "v2." + scope + "." + strconv.FormatInt(exp, 10) + "." + nonce
	m.Write([]byte(signed))
	return signed + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

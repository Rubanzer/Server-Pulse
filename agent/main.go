// server-pulse-agent: one binary that records this server's vitals and publishes them for the
// Server Pulse dashboard over Tailscale Funnel (HTTPS, no open ports, no Netdata/Caddy needed).
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

var version = "dev" // set at build time: -ldflags "-X main.version=1.0.0"

const (
	binPath    = "/usr/local/bin/server-pulse-agent"
	configPath = "/etc/server-pulse/config.json"
	unitPath   = "/etc/systemd/system/server-pulse-agent.service"
	localAddr  = "127.0.0.1:19998"
	dashUser   = "dashboard"
)

type Config struct {
	Password  string   `json:"password"`
	AuthKey   string   `json:"authKey,omitempty"`
	Hostname  string   `json:"hostname"`
	Tunnel    bool     `json:"tunnel"`
	KeepAwake bool     `json:"keepAwake"`
	Origins   []string `json:"origins,omitempty"`   // dashboard origins allowed to stream (empty = any; the token authorizes)
	ShowArgs  bool     `json:"showArgs,omitempty"`  // include scrubbed command lines in the process list
	PublicURL string   `json:"publicUrl,omitempty"` // your own tunnel (e.g. ngrok) pointing at 127.0.0.1:19998
	// Funnel port this agent turned on in the machine's own Tailscale (undone on uninstall); 0 = none
	FunnelPort int `json:"funnelPort,omitempty"`
}

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun(os.Args[2:])
	case "install":
		err = cmdInstall(os.Args[2:])
	case "uninstall":
		err = cmdUninstall(os.Args[2:])
	case "status":
		err = cmdStatus()
	case "link":
		err = cmdLink()
	case "funnel-check": // run by server-pulse-funnel.timer (root)
		err = cmdFunnelCheck()
	case "version", "--version", "-v":
		fmt.Println("server-pulse-agent", version)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`server-pulse-agent ` + version + `

  sudo ./server-pulse-agent install --authkey tskey-auth-…   install, start at boot, print the dashboard link
  server-pulse-agent status                                   is it running, is the link up
  sudo server-pulse-agent link                                print the dashboard link again
  sudo server-pulse-agent uninstall [--purge]                 remove (--purge also deletes history)
  server-pulse-agent run [--config file] [--no-tunnel]        run in the foreground (what systemd runs)

Install options:
  --authkey KEY     Tailscale auth key (admin console → Settings → Keys). Needed the first time only.
  --name NAME       machine name in your tailnet; the link becomes https://NAME.<tailnet>.ts.net
  --no-tunnel       serve only on 127.0.0.1:19998 (bring your own tunnel or reverse proxy)
  --no-keep-awake   don't turn off sleep / suspend
`)
}

// ---------- run ----------

type tunnelState struct {
	mu      sync.Mutex
	state   string // starting | login | online | error | rejected (auth key refused: not retried) | off
	domain  string
	err     string
	authURL string // Tailscale login link while waiting for the owner to approve this machine
	file    string // status.json in the private state dir: the only status root commands trust
	fileMu  sync.Mutex
}

func (t *tunnelState) setAuthURL(u string) {
	t.mu.Lock()
	t.authURL = u
	t.mu.Unlock()
	t.set("login", "", "")
}

func (t *tunnelState) set(state, domain, err string) {
	t.mu.Lock()
	t.state, t.domain, t.err = state, domain, err
	if state == "online" {
		t.authURL = ""
	}
	t.mu.Unlock()
	if t.file != "" {
		// the tsnet log callback and the tunnel loop both set state: write one at a time, so a stale
		// snapshot can't land last (it would drop the login link the installer is waiting to show)
		t.fileMu.Lock()
		defer t.fileMu.Unlock()
		b, _ := json.Marshal(t.snapshot())
		writeAtomic(t.file, func(w *bufio.Writer) error { _, err := w.Write(b); return err })
	}
}

func (t *tunnelState) snapshot() map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	return map[string]any{"version": version, "tunnel": t.state, "domain": t.domain, "error": t.err, "authURL": t.authURL}
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	cfgFile := fs.String("config", "", "config file (default: systemd credential, then "+configPath+")")
	noTunnel := fs.Bool("no-tunnel", false, "local listener only")
	verbose := fs.Bool("verbose", false, "log Tailscale internals")
	fs.Parse(args)

	cfg, err := loadConfig(*cfgFile)
	if err != nil {
		return err
	}
	stateDir := os.Getenv("STATE_DIRECTORY") // set by systemd StateDirectory=
	if stateDir == "" {
		stateDir = "/var/lib/server-pulse"
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	historyFile := filepath.Join(stateDir, "history.gob")

	col := NewCollector("/")
	store := NewStore(col.Charts())
	if err := store.Load(historyFile); err == nil {
		log.Printf("restored 30-day history from %s", historyFile)
	}
	ts := &tunnelState{file: filepath.Join(stateDir, "status.json")}
	ts.set("off", "", "")
	hub := NewHub(NewPulse("/", cfg.ShowArgs), cfg.Password, cfg.Origins)
	api := NewAPI(hub, store, col.Charts(), dashUser, cfg.Password, ts.snapshot)
	events := OpenEventLog(stateDir)
	api.events = events
	api.runs = recordRun(stateDir, time.Now().Unix())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// failures: error-level journal lines and crashes, plus sustained threshold breaches
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		watchJournal(ctx, events, filepath.Join(stateDir, "journal.cursor"))
	}()
	var th thresholds

	// sampler: once a second, on the second
	go func() {
		col.Sample(float64(time.Now().UnixNano()) / 1e9) // prime the rate counters
		for {
			now := time.Now()
			select {
			case <-ctx.Done():
				return
			case <-time.After(now.Truncate(time.Second).Add(time.Second).Sub(now)):
			}
			t := time.Now()
			s := col.Sample(float64(t.UnixNano()) / 1e9)
			store.Add(t.Unix(), s)
			th.check(events, t.Unix(), thresholdValues(s))
		}
	}()

	// persist the 30-day tier every 5 minutes
	go func() {
		tick := time.NewTicker(5 * time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if err := store.Save(historyFile); err != nil {
					log.Printf("save history: %v", err)
				}
			}
		}
	}()

	local := &http.Server{Addr: localAddr, Handler: api.LocalHandler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := local.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("local listener: %v", err)
		}
	}()
	log.Printf("server-pulse-agent %s: collecting %d charts, local API on http://%s", version, len(col.Charts()), localAddr)

	var tsrv *tsnet.Server
	if cfg.Tunnel && !*noTunnel {
		tsrv = &tsnet.Server{
			Dir:      filepath.Join(stateDir, "tailscale"),
			Hostname: cfg.Hostname,
			AuthKey:  cfg.AuthKey,
			UserLogf: func(format string, args ...any) {
				msg := fmt.Sprintf(format, args...)
				if u := loginURL.FindString(msg); u != "" {
					ts.setAuthURL(u)
				}
				log.Print(msg)
			},
			Logf: func(string, ...any) {},
		}
		if *verbose {
			tsrv.Logf = log.Printf
		}
		go serveFunnel(ctx, tsrv, api.Handler(), ts)
	}

	<-ctx.Done()
	log.Printf("shutting down: saving history")
	select { // the failure watcher saves its journal position, so nothing is re-read next start
	case <-watched:
	case <-time.After(2 * time.Second):
	}
	if err := store.Save(historyFile); err != nil {
		log.Printf("save history: %v", err)
	}
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	local.Shutdown(sctx)
	if tsrv != nil {
		tsrv.Close()
	}
	return nil
}

// serveFunnel brings the embedded Tailscale node up and serves the API on Funnel :443, retrying with a
// clear reason until it works (HTTPS or Funnel not yet enabled in the tailnet, network down, …).
func serveFunnel(ctx context.Context, s *tsnet.Server, h http.Handler, ts *tunnelState) {
	for attempt := 0; ctx.Err() == nil; attempt++ {
		ts.set("starting", "", "")
		// without an auth key the owner approves the machine in a browser, which can take a while
		upCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		_, err := s.Up(upCtx)
		cancel()
		var ln net.Listener
		if err == nil {
			ln, err = s.ListenFunnel("tcp", ":443")
		}
		if err != nil {
			msg := funnelHint(err)
			if keyRejected(err) {
				// retrying can't fix a refused key; the installer clears it and starts a browser login instead
				ts.set("rejected", "", msg)
				log.Printf("tunnel: %s", msg)
				return
			}
			ts.set("error", "", msg)
			log.Printf("tunnel: %s (retrying in 30 s)", msg)
			select {
			case <-ctx.Done():
				return
			case <-time.After(30 * time.Second):
			}
			continue
		}
		domain := ""
		if d := s.CertDomains(); len(d) > 0 {
			domain = d[0]
		}
		ts.set("online", domain, "")
		log.Printf("tunnel: online at https://%s", domain)
		srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 2 * time.Minute}
		stop := context.AfterFunc(ctx, func() { srv.Close() })
		err = srv.Serve(ln)
		stop()
		if err != nil && !errors.Is(err, http.ErrServerClosed) && ctx.Err() == nil {
			ts.set("error", domain, err.Error())
			log.Printf("tunnel: %v (restarting)", err)
			time.Sleep(5 * time.Second)
		}
	}
}

var (
	keyRejectedRe = regexp.MustCompile(`(?i)invalid key|auth ?key\b.*\b(expired|revoked|not valid|invalid)|api key \S+ not valid`)
	transientErr  = regexp.MustCompile(`(?i)x509|certificate|clock|context deadline`)
	secretInErr   = regexp.MustCompile(`(?i)(tskey-[\w-]+|api key \S+|auth ?key \S+)`)
)

// keyRejected: Tailscale refused the auth key (expired, revoked, already used, mistyped).
func keyRejected(err error) bool {
	return keyRejectedRe.MatchString(err.Error()) && !transientErr.MatchString(err.Error())
}

func funnelHint(err error) string {
	if keyRejected(err) {
		// fixed text: the raw error quotes the key, and this message lands in status.json and the journal
		return "Tailscale refused the saved auth key (expired, revoked or already used)"
	}
	m := secretInErr.ReplaceAllString(err.Error(), "•••")
	switch {
	case strings.Contains(m, "HTTPS") || strings.Contains(m, "https") || strings.Contains(m, "cert"):
		return m + " | Fix: Tailscale admin console → DNS → Enable HTTPS"
	case strings.Contains(strings.ToLower(m), "funnel"):
		return m + ` | Fix: Tailscale admin console → Access controls → allow Funnel ("nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}])`
	case strings.Contains(m, "context deadline exceeded"):
		return "could not log in to Tailscale in time | Check the auth key (it may be expired or already used) and that the server has internet"
	}
	return m
}

// ---------- install / uninstall ----------

func cmdInstall(args []string) error {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	authKey := fs.String("authkey", "", "Tailscale auth key (prefer --authkey-file or the prompt: command lines are visible to all users)")
	authKeyFile := fs.String("authkey-file", "", "read the Tailscale auth key from this file")
	dashboard := fs.String("dashboard", "", "dashboard origin(s) allowed to stream, comma-separated, e.g. https://pulse.vercel.app")
	showArgs := fs.Bool("show-args", false, "show (scrubbed) command lines in the process list")
	pair := fs.String("pair", "", "pairing code from the dashboard's Add server screen")
	publicURL := fs.String("public-url", "", "use your own tunnel instead of Tailscale, e.g. https://name.ngrok-free.dev (pointing at 127.0.0.1:19998)")
	name := fs.String("name", "", "machine name in your tailnet")
	noTunnel := fs.Bool("no-tunnel", false, "no embedded Tailscale")
	noAwake := fs.Bool("no-keep-awake", false, "leave sleep settings alone")
	fs.Parse(args)
	if os.Geteuid() != 0 {
		return errors.New("run with sudo: sudo ./server-pulse-agent install …")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errors.New("systemd is required (Ubuntu 22.04 / 24.04)")
	}

	cfg, _ := loadConfig(configPath) // keep the existing password on re-install
	// a Funnel port an earlier install opened: closed below unless this install keeps using exactly it
	oldFunnel := cfg.FunnelPort
	cfg.FunnelPort = 0
	if cfg.Password == "" {
		cfg.Password = randomPassword(24)
	}
	cfg.Tunnel = !*noTunnel
	if !cfg.Tunnel && *publicURL == "" {
		cfg.PublicURL = ""
	}
	cfg.KeepAwake = !*noAwake
	if *authKey != "" {
		fmt.Println("! Note: --authkey is visible in the process list and shell history. Next time use the prompt or --authkey-file.")
		cfg.AuthKey = *authKey
	}
	if *authKeyFile != "" {
		b, err := os.ReadFile(*authKeyFile)
		if err != nil {
			return err
		}
		cfg.AuthKey = strings.TrimSpace(string(b))
	}
	if *dashboard != "" {
		cfg.Origins = nil
		for _, d := range strings.Split(*dashboard, ",") {
			if o := originOf(d); o != "" {
				cfg.Origins = append(cfg.Origins, o)
			}
		}
	}
	if *publicURL != "" {
		u := originOf(*publicURL)
		if !strings.HasPrefix(u, "https://") {
			return errors.New("--public-url must be an https:// address")
		}
		cfg.PublicURL, *noTunnel, cfg.Tunnel = u, true, false
	}
	// already running ngrok for this agent? use it, nothing to type (and no Tailscale)
	if *publicURL == "" && !*noTunnel {
		if u, pid := detectNgrok(); u != "" {
			step("Found your ngrok tunnel at " + u + ": using it (no Tailscale needed)")
			cfg.PublicURL, cfg.Tunnel = u, false
			if msg := setupNgrokService(pid, u); msg != "" {
				step(msg)
			}
		} else if strings.Contains(cfg.PublicURL, ".ngrok") && startNgrokServiceIfIdle(cfg.PublicURL) {
			step("Started ngrok again (" + ngrokUnitName + ".service)")
			cfg.Tunnel = false
		} else if u, note, port := systemTailscale(); u != "" {
			// Tailscale already logged in on this machine: publish through it, no second login
			step("Found Tailscale on this machine: publishing the agent with Funnel at " + u)
			cfg.PublicURL, cfg.Tunnel, cfg.FunnelPort = u, false, port
		} else {
			if note != "" {
				fmt.Println("! " + note + ".")
			}
			if cfg.PublicURL != "" {
				cfg.Tunnel = false // a tunnel saved by an earlier install
				if oldFunnel != 0 && !strings.Contains(cfg.PublicURL, ".ngrok") {
					cfg.FunnelPort = oldFunnel // the saved address is that Funnel: still in use, keep it recorded
				}
			}
		}
	}
	// the ngrok auto-start belongs to the address in use: switching to Tailscale, --no-tunnel or another
	// address removes it, or the next boot would publish the agent at the old address again
	if cfg.PublicURL == "" || !ngrokUnitServes(cfg.PublicURL) {
		removeNgrokService()
	}
	// whatever this install chose (--public-url, --no-tunnel, ngrok, another Funnel port), the agent
	// must not stay published at an address it no longer uses
	stopFunnelCheck() // no watchdog run may put the old Funnel back while it's being changed
	if oldFunnel != 0 && oldFunnel != cfg.FunnelPort {
		stopSystemFunnel(oldFunnel)
	}
	if *pair != "" && len(cfg.Origins) == 0 {
		return errors.New("--pair needs --dashboard https://your-dashboard (the command from the dashboard includes both)")
	}
	if *pair != "" && !secureOrigin(cfg.Origins[0]) {
		return errors.New("--dashboard must be an https:// address: pairing sends this server's password to it")
	}
	if *showArgs {
		cfg.ShowArgs = true
	}
	if *name != "" {
		cfg.Hostname = sanitizeHost(*name)
	}
	if cfg.Hostname == "" {
		h, _ := os.Hostname()
		cfg.Hostname = sanitizeHost("pulse-" + h)
	}
	firstLogin := !dirExists("/var/lib/private/server-pulse/tailscale") && !dirExists("/var/lib/server-pulse/tailscale")
	if cfg.Tunnel && cfg.AuthKey == "" && firstLogin {
		step("No Tailscale auth key given: you'll get a link to log in to Tailscale and approve this server")
	}
	warnLegacy()
	quietLegacyServices()

	step("Installing the binary")
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if self, _ = filepath.EvalSymlinks(self); self != binPath {
		if err := copyFile(self, binPath, 0o755); err != nil {
			return err
		}
	}

	step("Writing the config (readable by root only)")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(configPath, b, 0o600); err != nil {
		return err
	}

	step("Creating the background service (starts at boot, restarts on crash)")
	if err := os.WriteFile(unitPath, []byte(unitFile), 0o644); err != nil {
		return err
	}
	if cfg.KeepAwake {
		step("Turning off sleep so it runs 24/7")
		keepAwake()
	}
	if err := run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	if err := run("systemctl", "enable", "server-pulse-agent"); err != nil {
		return err
	}
	// drop the previous run's status so we only report what the new process says
	os.Remove("/var/lib/private/server-pulse/status.json")
	os.Remove("/var/lib/server-pulse/status.json")
	if err := run("systemctl", "restart", "server-pulse-agent"); err != nil {
		return err
	}

	// published through this machine's Tailscale: a watchdog keeps that Funnel in place
	if cfg.FunnelPort != 0 {
		setupFunnelCheck()
	} else {
		removeFunnelCheck()
	}

	var host string
	switch {
	case cfg.PublicURL != "":
		host = strings.TrimPrefix(cfg.PublicURL, "https://")
		step("Using your own tunnel at " + cfg.PublicURL + " (it must forward to 127.0.0.1:19998, without a password of its own)")
	case cfg.Tunnel:
		step("Connecting to Tailscale and opening the public link")
		st, err := waitOnline(15 * time.Minute)
		if errors.Is(err, errKeyRejected) && cfg.AuthKey != "" {
			fmt.Println("  ! Tailscale refused the saved auth key (expired, revoked or already used). Forgetting it;")
			fmt.Println("    you'll get a link to log in instead. (Using ngrok? Run the command again with your ngrok address at the end.)")
			cfg.AuthKey = ""
			if b, err := json.MarshalIndent(cfg, "", "  "); err == nil {
				os.WriteFile(configPath, b, 0o600)
			}
			os.Remove("/var/lib/private/server-pulse/status.json")
			os.Remove("/var/lib/server-pulse/status.json")
			if err := run("systemctl", "restart", "server-pulse-agent"); err != nil {
				return err
			}
			st, err = waitOnline(15 * time.Minute)
		}
		if err != nil {
			return fmt.Errorf("%v\n  The service keeps retrying in the background. Check with: server-pulse-agent status", err)
		}
		host, _ = st["domain"].(string)
		if cfg.AuthKey != "" {
			cfg.AuthKey = "" // logged in: tsnet keeps its own identity, the key isn't needed any more
			if b, err := json.MarshalIndent(cfg, "", "  "); err == nil {
				os.WriteFile(configPath, b, 0o600)
			}
		}
	default:
		fmt.Printf("\nDone. The API is on http://%s (user %s). Run: sudo server-pulse-agent link\n", localAddr, dashUser)
		return nil
	}
	link := "https://" + dashUser + ":" + cfg.Password + "@" + host + "/history"
	// call the public address the way the dashboard will, before handing it over
	pub := cfg
	pub.PublicURL = "https://" + host
	checkPublic(pub)
	if *pair != "" {
		step("Connecting this server to your dashboard")
		err := pairWithDashboard(cfg.Origins[0], *pair, link)
		// the code stays valid for 10 minutes: when the dashboard just can't reach this server yet (Funnel
		// being allowed, a new certificate, a network blip), keep trying for a while instead of giving up
		for try := 1; err != nil && pairRetryable(err) && try <= pairRetries; try++ {
			if try == 1 {
				fmt.Println("  … " + cleanLine(err.Error()))
				fmt.Printf("    Trying again every %d s for up to %d minutes (Ctrl+C stops it).\n", int(pairRetryEvery/time.Second), int(pairRetryEvery*pairRetries/time.Minute))
			}
			time.Sleep(pairRetryEvery)
			err = pairWithDashboard(cfg.Origins[0], *pair, link)
		}
		if err != nil {
			fmt.Println("  ! Pairing didn't finish:", err)
			fmt.Println("    You can connect by hand instead:")
			printLink(cfg, host)
			return nil
		}
		fmt.Printf("\n  ✓ Done. Go back to %s and click \"Approve and connect\" to finish.\n\n", cfg.Origins[0])
		tailscaleReminder(cfg, host)
		return nil
	}
	printLink(cfg, host)
	return nil
}

// pairWithDashboard hands the server link to the dashboard over HTTPS, authorized by the one-time code
// the owner got on the Add server screen. Nobody has to see or copy the password.
func pairWithDashboard(dashboard, code, link string) error {
	host, _ := os.Hostname()
	body, _ := json.Marshal(map[string]string{"code": code, "link": link, "hostname": host, "version": version})
	c := http.Client{Timeout: 45 * time.Second}
	res, err := c.Post(dashboard+"/api/agent/pair", "application/json", strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&out)
	if !out.OK {
		if out.Error == "" {
			out.Error = res.Status
		}
		return errors.New(out.Error)
	}
	return nil
}

// secureOrigin: https, or plain http only to this machine (local development).
func secureOrigin(o string) bool {
	if strings.HasPrefix(o, "https://") {
		return true
	}
	h := strings.TrimPrefix(o, "http://")
	if i := strings.LastIndex(h, ":"); i > 0 && !strings.Contains(h[i:], "]") {
		h = h[:i]
	}
	return h == "localhost" || h == "127.0.0.1" || h == "[::1]"
}

// originOf normalizes "https://x.vercel.app/some/path" to "https://x.vercel.app".
func originOf(s string) string {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

var loginURL = regexp.MustCompile(`https://login\.tailscale\.com/a/[A-Za-z0-9]+`)

// Starts seconds after boot: it doesn't wait for network-online.target (which can hold services back
// for up to two minutes while the network settles). Readings, history and failures need no network,
// and the tunnel and dashboard connections retry on their own. After a crash it is back within 2 s and
// never gives up (StartLimitIntervalSec=0).
const unitFile = `[Unit]
Description=Server Pulse agent (vitals for the Server Pulse dashboard)
After=network.target
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/local/bin/server-pulse-agent run
Restart=always
RestartSec=2
# least privilege: throwaway user, read-only system, config passed as a credential
DynamicUser=yes
# read-only access to the system journal for live logs and failure history
SupplementaryGroups=systemd-journal
StateDirectory=server-pulse
LoadCredential=config:/etc/server-pulse/config.json
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
ProtectControlGroups=yes
ProtectKernelModules=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
MemoryMax=300M

[Install]
WantedBy=multi-user.target
`

func keepAwake() {
	run("systemctl", "mask", "sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target")
	os.MkdirAll("/etc/systemd/logind.conf.d", 0o755)
	os.WriteFile("/etc/systemd/logind.conf.d/server-pulse.conf",
		[]byte("[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n"), 0o644)
}

func cmdUninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	purge := fs.Bool("purge", false, "also delete stored history and the Tailscale identity")
	fs.Parse(args)
	if os.Geteuid() != 0 {
		return errors.New("run with sudo")
	}
	cfg, _ := loadConfig(configPath)
	run("systemctl", "disable", "--now", "server-pulse-agent")
	removeFunnelCheck() // first: a check in progress must not turn the Funnel back on
	stopSystemFunnel(cfg.FunnelPort)
	removeNgrokService()
	os.Remove(unitPath)
	run("systemctl", "daemon-reload")
	if cfg.KeepAwake {
		run("systemctl", "unmask", "sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target")
		os.Remove("/etc/systemd/logind.conf.d/server-pulse.conf")
	}
	os.RemoveAll(filepath.Dir(configPath))
	if *purge {
		os.RemoveAll("/var/lib/private/server-pulse")
		os.RemoveAll("/var/lib/server-pulse")
	}
	os.Remove(binPath)
	fmt.Println("Server Pulse agent removed." + map[bool]string{true: " History deleted.", false: " History kept (use --purge to delete it)."}[*purge])
	fmt.Println("Also remove the machine from https://login.tailscale.com/admin/machines if you no longer need it.")
	return nil
}

// ---------- status / link ----------

func cmdStatus() error {
	active, _ := exec.Command("systemctl", "is-active", "server-pulse-agent").Output()
	fmt.Printf("service: %s\n", strings.TrimSpace(string(active)))
	st, err := trustedStatus()
	if err != nil {
		st, err = localStatus()
	}
	if err != nil {
		fmt.Println("agent:   not answering on", localAddr)
		return nil
	}
	for k, v := range st { // a local port can be answered by anything when the agent is down: print clean text only
		if s, ok := v.(string); ok {
			st[k] = cleanLine(s)
		}
	}
	fmt.Printf("agent:   %v\ntunnel:  %v\n", st["version"], st["tunnel"])
	if d, _ := st["domain"].(string); d != "" {
		fmt.Printf("link:    https://%s  (sudo server-pulse-agent link shows it with the password)\n", d)
	}
	if u, _ := st["authURL"].(string); u != "" {
		fmt.Printf("login:   open %s to approve this server in Tailscale\n", u)
	}
	if e, _ := st["error"].(string); e != "" {
		fmt.Printf("problem: %s\n", e)
	}
	// the address the dashboard uses, checked from the internet side (the config is readable with sudo)
	pub := ""
	if d, _ := st["domain"].(string); d != "" {
		pub = "https://" + d
	}
	cfg, cfgErr := loadConfig(configPath)
	if cfgErr == nil && cfg.PublicURL != "" {
		pub = cfg.PublicURL
	}
	if pub != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		if err := probePublic(ctx, pub); err == nil {
			fmt.Printf("public:  %s answers from the internet ✓\n", pub)
		} else {
			fmt.Printf("public:  %s doesn't reach the agent: %s\n", pub, plainNetErr(err))
			cfg.PublicURL = pub
			for _, l := range reachHints(cfg) {
				fmt.Println("         " + l)
			}
		}
	} else if cfgErr != nil {
		fmt.Println("public:  run with sudo to also check the public address")
	}
	return nil
}

func cmdLink() error {
	if os.Geteuid() != 0 {
		return errors.New("run with sudo (the link contains the dashboard password)")
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	st, err := trustedStatus()
	if err != nil {
		return errors.New("the agent isn't running: sudo systemctl start server-pulse-agent")
	}
	if cfg.PublicURL != "" {
		printLink(cfg, strings.TrimPrefix(cfg.PublicURL, "https://"))
		return nil
	}
	if st["tunnel"] != "online" {
		return fmt.Errorf("the link isn't online yet: %v", st["error"])
	}
	d, _ := st["domain"].(string)
	printLink(cfg, d)
	return nil
}

func printLink(cfg Config, host string) {
	fmt.Printf(`
  ✓ Server Pulse agent is running and online.

  Paste this link in the dashboard (Add server → connect manually, or SERVER_URL in Vercel):

      https://%s:%s@%s/history

  Keep it private: it is a read-only password for this server's stats.
`, dashUser, cfg.Password, host)
	tailscaleReminder(cfg, host)
}

func tailscaleReminder(cfg Config, host string) {
	if cfg.PublicURL != "" || !strings.HasSuffix(host, ".ts.net") {
		return
	}
	fmt.Printf(`
  For 24/7: in https://login.tailscale.com/admin/machines open ⋯ next to %q
  and choose "Disable key expiry", or the link stops working after about 180 days.

`, strings.SplitN(host, ".", 2)[0])
}

var errKeyRejected = errors.New("Tailscale refused the auth key")

func waitOnline(limit time.Duration) (map[string]any, error) {
	deadline := time.Now().Add(limit)
	last, shownURL := "", ""
	for time.Now().Before(deadline) {
		if st, err := trustedStatus(); err == nil {
			if st["tunnel"] == "online" {
				return st, nil
			}
			if st["tunnel"] == "rejected" {
				return nil, errKeyRejected
			}
			if u, _ := st["authURL"].(string); u != "" && u != shownURL {
				shownURL = u
				fmt.Printf("\n  Open this link and log in to Tailscale to approve this server:\n\n      %s\n\n  (waiting…)\n", u)
			}
			if e, _ := st["error"].(string); e != "" && e != last {
				fmt.Println("  …", e)
				last = e
			}
		}
		time.Sleep(2 * time.Second)
	}
	if last != "" {
		return nil, errors.New("not online yet: " + last)
	}
	return nil, errors.New("not online yet")
}

// trustedStatus reads the status the agent wrote into its root-only state directory. Root commands
// (install, link) print the password inside a link, so they never trust 127.0.0.1:19998: another local
// user could bind that port first and answer with a domain of their choosing.
func trustedStatus() (map[string]any, error) {
	for _, p := range []string{"/var/lib/private/server-pulse/status.json", "/var/lib/server-pulse/status.json"} {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var st map[string]any
		if json.Unmarshal(b, &st) == nil {
			return st, nil
		}
	}
	return nil, errors.New("no status file")
}

// localStatus is for the unprivileged `status` display only (no secrets are printed from it).
func localStatus() (map[string]any, error) {
	c := http.Client{Timeout: 3 * time.Second}
	r, err := c.Get("http://" + localAddr + "/agent/status")
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	var st map[string]any
	return st, json.NewDecoder(r.Body).Decode(&st)
}

// ---------- helpers ----------

func loadConfig(file string) (Config, error) {
	var cfg Config
	if file == "" {
		if dir := os.Getenv("CREDENTIALS_DIRECTORY"); dir != "" {
			file = filepath.Join(dir, "config")
		} else {
			file = configPath
		}
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return cfg, fmt.Errorf("read config: %w (install first: sudo ./server-pulse-agent install --authkey …)", err)
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, fmt.Errorf("config %s: %w", file, err)
	}
	if len(cfg.Password) < 12 {
		return cfg, errors.New("config has no dashboard password; re-run install")
	}
	return cfg, nil
}

// randomPassword: letters and digits only (it goes inside a URL), uniform via crypto/rand.
func randomPassword(n int) string {
	const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
	b := make([]byte, n)
	for i := range b {
		k, _ := rand.Int(rand.Reader, big.NewInt(int64(len(abc))))
		b[i] = abc[k.Int64()]
	}
	return string(b)
}

func sanitizeHost(s string) string {
	s = strings.ReplaceAll(sanitize(s), "_", "-")
	if len(s) > 60 {
		s = s[:60]
	}
	return strings.Trim(s, "-")
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst) // replace atomically, even while the old binary is running
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = io.Discard, os.Stderr
	return cmd.Run()
}

func step(s string) { fmt.Println("→", s) }

// warnLegacy points out an old btop/ttyd/ngrok setup whose password sits in the process list.
func warnLegacy() {
	ents, _ := os.ReadDir("/proc")
	var hits []string
	for _, e := range ents {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		cmd := strings.ReplaceAll(string(readFile("/proc/"+e.Name()+"/cmdline")), "\x00", " ")
		if strings.Contains(cmd, "ttyd") || (strings.Contains(cmd, "ngrok") && strings.Contains(cmd, "basic-auth")) {
			if f := strings.Fields(cmd); len(f) > 0 {
				hits = append(hits, filepath.Base(f[0]))
			}
		}
	}
	if len(hits) > 0 {
		fmt.Printf("! Found an older btop/ttyd/ngrok setup (%s). Its password is visible to every user in the process list.\n", strings.Join(hits, ", "))
		fmt.Println("  Stop it once the dashboard works, and treat that password and ngrok authtoken as exposed (rotate them).")
	}
}

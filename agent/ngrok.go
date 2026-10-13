package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// detectNgrok finds an ngrok tunnel that already forwards to this agent (127.0.0.1:19998) by asking
// ngrok's local API, so `install` needs no address typed and never falls back to Tailscale by mistake.
//
// Pairing sends this server's password inside the returned address, so the answer is only trusted
// when it comes from a process named ngrok run by root or by the user who ran sudo: any other local
// user could otherwise listen on :4040 and name a host of their choosing. The check is made on the very
// connection the answer arrives on (its server-side socket → owning process), not on the port before
// connecting, so the port can't change hands in between.
//
// Returns the address and the ngrok process that served it (to set up its auto-start), or "" / 0.
func detectNgrok() (string, int) {
	pid := 0
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, p, err := dialNgrok(ctx, network, addr)
		if err == nil {
			pid = p
		}
		return conn, err
	}
	c := http.Client{Timeout: time.Second, Transport: &http.Transport{DisableKeepAlives: true, DialContext: dial}}
	for port := 4040; port <= 4045; port++ {
		r, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/tunnels", port))
		if err != nil {
			continue
		}
		var body struct {
			Tunnels []struct {
				PublicURL string `json:"public_url"`
				Proto     string `json:"proto"`
				Config    struct {
					Addr string `json:"addr"`
				} `json:"config"`
			} `json:"tunnels"`
		}
		err = json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(&body)
		r.Body.Close()
		if err != nil {
			continue
		}
		for _, t := range body.Tunnels {
			if u := originOf(t.PublicURL); strings.HasPrefix(u, "https://") && forwardsToAgent(t.Config.Addr) {
				return u, pid
			}
		}
	}
	return "", 0
}

// forwardsToAgent: ngrok's "addr" for `ngrok http 19998` / `http://localhost:19998` / `127.0.0.1:19998`.
func forwardsToAgent(addr string) bool {
	a := addr
	if i := strings.Index(a, "://"); i >= 0 {
		a = a[i+3:]
	}
	a = strings.TrimSuffix(a, "/")
	host, port, err := net.SplitHostPort(a)
	if err != nil {
		host, port = "", a // a bare port number
	}
	if port != strconv.Itoa(19998) {
		return false
	}
	switch host {
	case "", "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

var errNotNgrok = errors.New("not an ngrok process")

// dialNgrok connects, then keeps the connection only if the process holding its other end is ngrok
// (returned, so the installer can set up that same ngrok to start with the machine).
func dialNgrok(ctx context.Context, network, addr string) (net.Conn, int, error) {
	conn, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, 0, err
	}
	local, _ := conn.LocalAddr().(*net.TCPAddr)
	remote, _ := conn.RemoteAddr().(*net.TCPAddr)
	pid := 0
	if local != nil && remote != nil {
		pid = peerNgrokPID(remote.Port, local.Port)
	}
	if pid == 0 {
		conn.Close()
		return nil, 0, errNotNgrok
	}
	return conn, pid, nil
}

// peerNgrokPID: the ngrok process holding the accepted socket 127.0.0.1:serverPort ↔ :clientPort, or 0.
func peerNgrokPID(serverPort, clientPort int) int {
	inode := connInode(serverPort, clientPort)
	if inode == "" {
		return 0
	}
	return socketNgrokPID("socket:[" + inode + "]")
}

// socketNgrokPID: the process with the socket open, if it is named ngrok and run by root or $SUDO_UID.
func socketNgrokPID(want string) int {
	sudoUID := os.Getenv("SUDO_UID")
	procs, _ := os.ReadDir("/proc")
	for _, p := range procs {
		if _, err := strconv.Atoi(p.Name()); err != nil {
			continue
		}
		dir := "/proc/" + p.Name()
		fds, _ := os.ReadDir(dir + "/fd")
		for _, fd := range fds {
			if l, _ := os.Readlink(filepath.Join(dir, "fd", fd.Name())); l != want {
				continue
			}
			if strings.TrimSpace(string(readFile(dir+"/comm"))) != "ngrok" {
				return 0
			}
			if uid := procUID(dir); uid == "0" || (sudoUID != "" && uid == sudoUID) {
				pid, _ := strconv.Atoi(p.Name())
				return pid
			}
			return 0
		}
	}
	return 0
}

// connInode returns the inode of the established loopback socket whose local end is serverPort and
// remote end is clientPort (the server side of our own connection), "" if none.
func connInode(serverPort, clientPort int) string {
	lp, rp := fmt.Sprintf(":%04X", serverPort), fmt.Sprintf(":%04X", clientPort)
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(fh)
		for sc.Scan() {
			x := strings.Fields(sc.Text())
			// sl local_address rem_address st … inode(9); st 01 = established
			if len(x) < 10 || x[3] != "01" || !strings.HasSuffix(x[1], lp) || !strings.HasSuffix(x[2], rp) {
				continue
			}
			if loopback(strings.TrimSuffix(x[1], lp)) && loopback(strings.TrimSuffix(x[2], rp)) {
				fh.Close()
				return x[9]
			}
		}
		fh.Close()
	}
	return ""
}

func loopback(hexAddr string) bool {
	return hexAddr == "0100007F" || hexAddr == "00000000000000000000000001000000" || hexAddr == "0000000000000000FFFF00000100007F"
}

func procUID(dir string) string {
	for _, line := range strings.Split(string(readFile(dir+"/status")), "\n") {
		if v, ok := strings.CutPrefix(line, "Uid:"); ok {
			if f := strings.Fields(v); len(f) > 0 {
				return f[0]
			}
		}
	}
	return ""
}

// quietLegacyServices turns off services from the older setup guide (ngrok-pulse, btop-web) that are
// stuck failing: one that restarted thousands of times fights the user's own ngrok for its port and
// domain and fills the logs. A unit that is running, or failed only a few times, is left alone and
// only mentioned.
func quietLegacyServices() {
	for _, unit := range []string{"ngrok-pulse", "btop-web"} {
		out, err := exec.Command("systemctl", "show", "-p", "LoadState,ActiveState,SubState,NRestarts", unit).Output()
		if err != nil {
			continue
		}
		st := map[string]string{}
		for _, line := range strings.Split(string(out), "\n") {
			if k, v, ok := strings.Cut(line, "="); ok {
				st[k] = strings.TrimSpace(v)
			}
		}
		if st["LoadState"] != "loaded" {
			continue
		}
		failing := st["ActiveState"] == "failed" || st["SubState"] == "auto-restart" || st["ActiveState"] == "activating"
		restarts, _ := strconv.Atoi(st["NRestarts"])
		switch {
		case failing && restarts >= 20:
			if run("systemctl", "disable", "--now", unit) == nil {
				fmt.Printf("! Turned off your old %s service: it had failed %d times in a row (a leftover from the older setup).\n", unit, restarts)
			}
		case failing:
			fmt.Printf("! Your old %s service is failing. If you don't use it any more: sudo systemctl disable --now %s\n", unit, unit)
		}
	}
}

// ---------- ngrok that comes back after a restart or power cut ----------

const ngrokUnitName = "server-pulse-ngrok"
const ngrokUnitPath = "/etc/systemd/system/" + ngrokUnitName + ".service"

// ngrokUnit is the service that runs the same ngrok, as the same user, with the same address. After
// network.target, not network-online (ngrok reconnects by itself), so it is up within seconds of boot.
// Failing (quota used up, offline) it retries every 10 s, backing off to 5 min where systemd supports
// RestartSteps (255+); older systemd ignores those two lines and keeps 10 s.
func ngrokUnit(user, exe, publicURL string, hasURLFlag bool) string {
	addr := "--url=" + publicURL
	if !hasURLFlag {
		addr = "--domain=" + strings.TrimPrefix(publicURL, "https://") // ngrok v3 before --url existed
	}
	return `[Unit]
Description=ngrok tunnel for the Server Pulse agent (set up by server-pulse-agent install)
After=network.target server-pulse-agent.service
StartLimitIntervalSec=0

[Service]
User=` + user + `
ExecStart=` + exe + ` http 19998 ` + addr + ` --log=stdout
Restart=always
RestartSec=10
RestartSteps=10
RestartMaxDelaySec=300

[Install]
WantedBy=multi-user.target
`
}

var (
	safeUser = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	safeExe  = regexp.MustCompile(`^/[A-Za-z0-9._/+-]+/ngrok$`)
	safeHost = regexp.MustCompile(`^https://[a-z0-9-]+(\.[a-z0-9-]+)+$`)
)

// setupNgrokService makes the running ngrok (pid) start with the machine. It is only enabled, not
// started: the ngrok running now holds the address, and a second copy would fight it for it. Skipped
// when the owner already has their own ngrok service for this agent.
func setupNgrokService(pid int, publicURL string) string {
	if pid == 0 {
		return ""
	}
	for _, own := range []string{"pulse-ngrok", "ngrok"} {
		if out, _ := exec.Command("systemctl", "is-enabled", own).Output(); strings.TrimSpace(string(out)) == "enabled" {
			return "Your " + own + " service already starts ngrok with the machine"
		}
	}
	exe, _ := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	exe = strings.TrimSuffix(exe, " (deleted)")
	if strings.HasPrefix(exe, "/snap/") {
		exe = "/snap/bin/ngrok" // the revision path disappears after snap refreshes; this one stays
	}
	uid := procUID(fmt.Sprintf("/proc/%d", pid))
	u, err := user.LookupId(uid)
	// everything that goes into the unit is checked: it runs at every boot
	if err != nil || !safeUser.MatchString(u.Username) || !safeExe.MatchString(exe) || !safeHost.MatchString(publicURL) {
		return ""
	}
	// a root service must not run a file someone else can replace (that would be root at every boot)
	if uid == "0" && !rootOwnedPath(exe) {
		return "Not setting up ngrok to start by itself: " + exe + " can be changed by other users. Move ngrok to /usr/local/bin to get that"
	}
	if os.WriteFile(ngrokUnitPath, []byte(ngrokUnit(u.Username, exe, publicURL, ngrokHasURLFlag(exe))), 0o644) != nil {
		return ""
	}
	run("systemctl", "daemon-reload")
	if run("systemctl", "enable", ngrokUnitName) != nil {
		return ""
	}
	return "ngrok will also start by itself after a restart or power cut (" + ngrokUnitName + ".service; it uses your ngrok account settings, not other options you started ngrok with)"
}

// rootOwnedPath: the file and every directory above it belong to root and only root can write them.
func rootOwnedPath(p string) bool {
	for cur := p; ; cur = filepath.Dir(cur) {
		fi, err := os.Stat(cur)
		if err != nil {
			return false
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 || fi.Mode().Perm()&0o022 != 0 {
			return false
		}
		if cur == "/" {
			return true
		}
	}
}

// ngrokHasURLFlag: newer ngrok takes --url; older v3 releases only know --domain.
func ngrokHasURLFlag(exe string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, exe, "http", "--help").CombinedOutput()
	return strings.Contains(string(out), "--url")
}

// startNgrokServiceIfIdle: re-installing while the hand-started ngrok is gone (e.g. after a power cut
// on an older setup) starts the service, so the tunnel is back without typing anything.
func startNgrokServiceIfIdle(want string) bool {
	if _, err := os.Stat(ngrokUnitPath); err != nil {
		return false
	}
	if run("systemctl", "start", ngrokUnitName) != nil {
		return false
	}
	for i := 0; i < 10; i++ { // up to 10 s for ngrok to connect and report its address
		time.Sleep(time.Second)
		if u, _ := detectNgrok(); u == want {
			return true
		}
	}
	return false
}

// ngrokUnitServes: the auto-start unit exists and publishes this address.
func ngrokUnitServes(publicURL string) bool {
	b, err := os.ReadFile(ngrokUnitPath)
	if err != nil {
		return false
	}
	return strings.Contains(string(b), "--url="+publicURL+" ") || strings.Contains(string(b), "--domain="+strings.TrimPrefix(publicURL, "https://")+" ")
}

func removeNgrokService() {
	if _, err := os.Stat(ngrokUnitPath); err == nil {
		run("systemctl", "disable", "--now", ngrokUnitName)
		os.Remove(ngrokUnitPath)
		run("systemctl", "daemon-reload")
	}
}

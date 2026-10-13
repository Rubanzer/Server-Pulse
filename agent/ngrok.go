package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// detectNgrok finds an ngrok tunnel that already forwards to this agent (127.0.0.1:19998) by asking
// ngrok's local API, so `install` needs no address typed and never falls back to Tailscale by mistake.
//
// Pairing sends this server's password inside the returned address, so the answer is only trusted
// when the port it came from belongs to a process named ngrok run by root or by the user who ran sudo:
// any other local user could otherwise listen on :4040 first and name a host of their choosing.
func detectNgrok() string {
	c := http.Client{Timeout: time.Second}
	for port := 4040; port <= 4045; port++ {
		if !ownedByNgrok(port) {
			continue
		}
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
				return u
			}
		}
	}
	return ""
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

// ownedByNgrok: the process listening on 127.0.0.1:port is named ngrok and run by root or $SUDO_UID.
func ownedByNgrok(port int) bool {
	inode := listenInode(port)
	if inode == "" {
		return false
	}
	want := "socket:[" + inode + "]"
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
				return false
			}
			uid := procUID(dir)
			return uid == "0" || (sudoUID != "" && uid == sudoUID)
		}
	}
	return false
}

// listenInode returns the socket inode listening on 127.0.0.1:port (or [::1]:port), "" if none.
func listenInode(port int) string {
	hexPort := fmt.Sprintf(":%04X", port)
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(fh)
		for sc.Scan() {
			x := strings.Fields(sc.Text())
			// sl local_address rem_address st … inode(9)
			if len(x) < 10 || x[3] != "0A" || !strings.HasSuffix(x[1], hexPort) {
				continue
			}
			local := strings.TrimSuffix(x[1], hexPort)
			if local == "0100007F" || local == "00000000000000000000000001000000" {
				fh.Close()
				return x[9]
			}
		}
		fh.Close()
	}
	return ""
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

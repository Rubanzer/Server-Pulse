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
	"path/filepath"
	"strconv"
	"strings"
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
func detectNgrok() string {
	c := http.Client{Timeout: time.Second, Transport: &http.Transport{DisableKeepAlives: true, DialContext: dialNgrok}}
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

var errNotNgrok = errors.New("not an ngrok process")

// dialNgrok connects, then keeps the connection only if the process holding its other end is ngrok.
func dialNgrok(ctx context.Context, network, addr string) (net.Conn, error) {
	conn, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	local, _ := conn.LocalAddr().(*net.TCPAddr)
	remote, _ := conn.RemoteAddr().(*net.TCPAddr)
	if local == nil || remote == nil || !peerIsNgrok(remote.Port, local.Port) {
		conn.Close()
		return nil, errNotNgrok
	}
	return conn, nil
}

// peerIsNgrok: the accepted socket 127.0.0.1:serverPort ↔ 127.0.0.1:clientPort belongs to ngrok.
func peerIsNgrok(serverPort, clientPort int) bool {
	inode := connInode(serverPort, clientPort)
	if inode == "" {
		return false
	}
	return socketOwnedByNgrok("socket:[" + inode + "]")
}

// socketOwnedByNgrok: the socket is open in a process named ngrok run by root or $SUDO_UID.
func socketOwnedByNgrok(want string) bool {
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

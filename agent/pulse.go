package main

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// ---------- the live "btop" frame ----------
// Numbers are quantized (integers / one decimal) so frames stay small; gzip on the stream does the rest.

type Frame struct {
	Boot  string     `json:"boot"` // changes when the server reboots
	Seq   uint64     `json:"seq"`
	T     int64      `json:"t"`
	Up    int64      `json:"up"`
	Load  [3]float64 `json:"load"`
	CPU   CPUInfo    `json:"cpu"`
	Mem   MemInfo    `json:"mem"`
	Disks []Mount    `json:"disks,omitempty"` // refreshed every 10 s
	IO    []DiskIO   `json:"io"`
	Net   []NIC      `json:"net"`
	Procs *Procs     `json:"procs,omitempty"` // refreshed every 3 s
}

type CPUInfo struct {
	Model    string `json:"model,omitempty"` // sent on keyframes only
	Total    int    `json:"total"`           // %
	Cores    []int  `json:"cores"`           // % per logical CPU
	Temps    []int  `json:"temps,omitempty"` // °C per logical CPU (from its physical core); 0 = unknown
	Pkg      int    `json:"pkg,omitempty"`   // hottest package °C
	MHz      []int  `json:"mhz,omitempty"`   // per logical CPU, every 5 s
	Physical int    `json:"physical,omitempty"`
}

type MemInfo struct { // MiB
	Total     int64 `json:"total"`
	Used      int64 `json:"used"`
	Avail     int64 `json:"avail"`
	Cached    int64 `json:"cached"`
	Free      int64 `json:"free"`
	SwapTotal int64 `json:"swapTotal"`
	SwapUsed  int64 `json:"swapUsed"`
}

type Mount struct {
	Path  string `json:"path"`
	FS    string `json:"fs"`
	Dev   string `json:"dev"`
	Size  int64  `json:"size"` // MiB
	Used  int64  `json:"used"`
	Avail int64  `json:"avail"`
}

type DiskIO struct {
	Dev   string `json:"dev"`
	Read  int64  `json:"r"` // KiB/s
	Write int64  `json:"w"`
}

type NIC struct {
	Name string `json:"name"`
	In   int64  `json:"in"`  // kbit/s
	Out  int64  `json:"out"` // kbit/s
	RxT  int64  `json:"rxT"` // MiB since boot
	TxT  int64  `json:"txT"`
}

type Procs struct {
	Count  int     `json:"count"`
	Top    []Proc  `json:"top"`              // top 25 by CPU
	Groups []Group `json:"groups"`           // top 15 names by CPU, summed over all processes
	Hidden bool    `json:"hidden,omitempty"` // /proc mounted with hidepid: only the agent's own processes are visible
}

type Proc struct {
	PID     int     `json:"pid"`
	Name    string  `json:"name"`
	User    string  `json:"user"`
	CPU     float64 `json:"cpu"` // % of one core, like top/btop
	MemMiB  int64   `json:"mem"`
	Threads int     `json:"thr"`
	Cmd     string  `json:"cmd,omitempty"` // only when the owner opted in; always scrubbed
}

type Group struct {
	Name   string  `json:"name"`
	N      int     `json:"n"`
	CPU    float64 `json:"cpu"`
	MemMiB int64   `json:"mem"`
}

// ---------- collector ----------

type Pulse struct {
	root     string
	showArgs bool
	logical  int
	model    string
	physical int
	coreTemp []string // per logical CPU: hwmon temp*_input path, "" if none
	prevCPU  [][]uint64
	prevDisk map[string][2]uint64
	prevNet  map[string][2]uint64
	prevProc map[int]uint64 // pid → utime+stime ticks
	prevT    float64
	prevPT   float64
	users    map[uint32]string
	clkTck   float64
	pageMiB  float64
	disks    []string
	ifaces   []string
	mounts   []Mount
	mhz      []int
}

func NewPulse(root string, showArgs bool) *Pulse {
	p := &Pulse{root: root, showArgs: showArgs, prevDisk: map[string][2]uint64{}, prevNet: map[string][2]uint64{},
		prevProc: map[int]uint64{}, users: map[uint32]string{}, clkTck: 100, pageMiB: float64(os.Getpagesize()) / (1 << 20)}
	c := &Collector{root: root}
	p.disks, p.ifaces = c.physical("sys/block"), c.physical("sys/class/net")
	p.model = cpuModel(readFile(p.path("proc/cpuinfo")))
	p.logical, p.physical, p.coreTemp = p.topology()
	p.loadUsers()
	return p
}

func (p *Pulse) path(s string) string { return filepath.Join(p.root, s) }

// topology maps each logical CPU to its physical core's coretemp sensor (hyperthread siblings share it).
func (p *Pulse) topology() (logical, physical int, temps []string) {
	cpus, _ := filepath.Glob(p.path("sys/devices/system/cpu/cpu[0-9]*"))
	sort.Slice(cpus, func(i, j int) bool { return cpuNum(cpus[i]) < cpuNum(cpus[j]) })
	// coretemp: "Core N" labels per package (hwmon dir name per package), "Package id P"
	sensor := map[[2]int]string{} // (package, core_id) → temp input path
	hw, _ := filepath.Glob(p.path("sys/class/hwmon/hwmon*/temp*_label"))
	for _, lbl := range hw {
		label := readTrim(lbl)
		dir := filepath.Dir(lbl)
		if readTrim(filepath.Join(dir, "name")) != "coretemp" {
			continue
		}
		pkg := packageOf(dir, p)
		if n, ok := strings.CutPrefix(label, "Core "); ok {
			if id, err := strconv.Atoi(n); err == nil {
				sensor[[2]int{pkg, id}] = strings.TrimSuffix(lbl, "_label") + "_input"
			}
		}
	}
	seen := map[[2]int]bool{}
	for _, c := range cpus {
		pkg, _ := strconv.Atoi(readTrim(filepath.Join(c, "topology/physical_package_id")))
		core, err := strconv.Atoi(readTrim(filepath.Join(c, "topology/core_id")))
		if err != nil {
			continue
		}
		logical++
		k := [2]int{pkg, core}
		if !seen[k] {
			seen[k] = true
			physical++
		}
		temps = append(temps, sensor[k])
	}
	return
}

// packageOf reads the package number of a coretemp hwmon dir from its "Package id N" label.
func packageOf(dir string, p *Pulse) int {
	labels, _ := filepath.Glob(filepath.Join(dir, "temp*_label"))
	for _, l := range labels {
		if n, ok := strings.CutPrefix(readTrim(l), "Package id "); ok {
			v, _ := strconv.Atoi(n)
			return v
		}
	}
	return 0
}

func cpuNum(path string) int {
	n, _ := strconv.Atoi(strings.TrimPrefix(filepath.Base(path), "cpu"))
	return n
}

func cpuModel(b []byte) string {
	for _, line := range strings.Split(string(b), "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(k) == "model name" {
			return strings.Join(strings.Fields(v), " ")
		}
	}
	return ""
}

func (p *Pulse) loadUsers() {
	for _, line := range strings.Split(string(readFile(p.path("etc/passwd"))), "\n") {
		f := strings.Split(line, ":")
		if len(f) > 2 {
			if uid, err := strconv.ParseUint(f[2], 10, 32); err == nil {
				p.users[uint32(uid)] = f[0]
			}
		}
	}
}

// Frame builds one frame. withDisks / withProcs / withMHz pace the expensive parts.
func (p *Pulse) Frame(now float64, seq uint64, withDisks, withProcs, withMHz, keyframe bool) Frame {
	f := Frame{Seq: seq, T: int64(now)}
	f.Boot = readTrim(p.path("proc/sys/kernel/random/boot_id"))
	f.Up = int64(parseUptime(readFile(p.path("proc/uptime"))))
	if l := parseLoadavg(readFile(p.path("proc/loadavg"))); l != nil {
		f.Load = [3]float64{round1(l[0]), round1(l[1]), round1(l[2])}
	}
	dt := now - p.prevT

	// CPU: aggregate + per logical CPU
	all := parseAllCPU(readFile(p.path("proc/stat")))
	if len(all) > 0 {
		f.CPU.Total = 0
		f.CPU.Cores = make([]int, len(all)-1)
		if len(p.prevCPU) == len(all) {
			for i := range all {
				busy := 100 - pctIdle(p.prevCPU[i], all[i])
				if i == 0 {
					f.CPU.Total = busy
				} else {
					f.CPU.Cores[i-1] = busy
				}
			}
		}
		p.prevCPU = all
	}
	if len(p.coreTemp) > 0 {
		f.CPU.Temps = make([]int, len(p.coreTemp))
		cache := map[string]int{}
		for i, path := range p.coreTemp {
			if path == "" {
				continue
			}
			if v, ok := cache[path]; ok {
				f.CPU.Temps[i] = v
				continue
			}
			n, _ := strconv.Atoi(readTrim(path))
			cache[path] = n / 1000
			f.CPU.Temps[i] = n / 1000
		}
	}
	f.CPU.Pkg = p.packageTemp()
	if withMHz || p.mhz == nil {
		p.mhz = make([]int, p.logical)
		for i := range p.mhz {
			if k, err := strconv.Atoi(readTrim(p.path("sys/devices/system/cpu/cpu" + strconv.Itoa(i) + "/cpufreq/scaling_cur_freq"))); err == nil {
				p.mhz[i] = k / 1000
			}
		}
	}
	if withMHz || keyframe {
		f.CPU.MHz = p.mhz
	}
	if keyframe {
		f.CPU.Model, f.CPU.Physical = p.model, p.physical
	}

	f.Mem = memDetail(readFile(p.path("proc/meminfo")))

	// disks
	if withDisks || p.mounts == nil {
		p.mounts = realMounts(readFile(p.path("proc/self/mountinfo")), p.root)
	}
	if withDisks || keyframe {
		f.Disks = p.mounts
	}
	ds := readFile(p.path("proc/diskstats"))
	for _, d := range p.disks {
		rd, wr := parseDiskstats(ds, []string{d})
		io := DiskIO{Dev: d}
		if prev, ok := p.prevDisk[d]; ok && dt > 0 {
			io.Read = int64(float64(sub(rd, prev[0])) * 512 / 1024 / dt)
			io.Write = int64(float64(sub(wr, prev[1])) * 512 / 1024 / dt)
		}
		p.prevDisk[d] = [2]uint64{rd, wr}
		f.IO = append(f.IO, io)
	}

	// network
	nd := readFile(p.path("proc/net/dev"))
	for _, n := range p.ifaces {
		rx, tx := parseNetdev(nd, []string{n})
		nic := NIC{Name: n, RxT: int64(rx >> 20), TxT: int64(tx >> 20)}
		if prev, ok := p.prevNet[n]; ok && dt > 0 {
			nic.In = int64(float64(sub(rx, prev[0])) * 8 / 1000 / dt)
			nic.Out = int64(float64(sub(tx, prev[1])) * 8 / 1000 / dt)
		}
		p.prevNet[n] = [2]uint64{rx, tx}
		f.Net = append(f.Net, nic)
	}

	if withProcs {
		f.Procs = p.processes(now)
	}
	p.prevT = now
	return f
}

// packageTemp is the hottest CPU package: Intel "Package id N", else AMD k10temp/zenpower (Tctl/Tdie).
func (p *Pulse) packageTemp() int {
	best := 0
	hw, _ := filepath.Glob(p.path("sys/class/hwmon/hwmon*/temp*_input"))
	for _, in := range hw {
		chip := readTrim(filepath.Join(filepath.Dir(in), "name"))
		label := readTrim(strings.TrimSuffix(in, "_input") + "_label")
		cpuSensor := strings.HasPrefix(label, "Package id") || chip == "k10temp" || chip == "zenpower"
		if !cpuSensor {
			continue
		}
		if n, err := strconv.Atoi(readTrim(in)); err == nil && n/1000 > best {
			best = n / 1000
		}
	}
	return best
}

// parseAllCPU returns the aggregate line first, then cpu0, cpu1, …
func parseAllCPU(b []byte) [][]uint64 {
	var out [][]uint64
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu") {
			break
		}
		if v := parseCPU([]byte(line)); v != nil {
			out = append(out, v)
		} else if f := strings.Fields(line); len(f) >= 9 {
			v := make([]uint64, 8)
			for i := range v {
				v[i], _ = strconv.ParseUint(f[i+1], 10, 64)
			}
			out = append(out, v)
		}
	}
	return out
}

// pctIdle is the share of time spent idle (idle + iowait) between two readings, as an integer percent.
func pctIdle(a, b []uint64) int {
	var total uint64
	for i := range b {
		total += sub(b[i], a[i])
	}
	if total == 0 {
		return 100
	}
	idle := sub(b[3], a[3]) + sub(b[4], a[4])
	return int(float64(idle)*100/float64(total) + 0.5)
}

func memDetail(b []byte) MemInfo {
	kv := map[string]int64{}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			n, _ := strconv.ParseInt(f[1], 10, 64)
			kv[strings.TrimSuffix(f[0], ":")] = n / 1024
		}
	}
	m := MemInfo{Total: kv["MemTotal"], Free: kv["MemFree"], Avail: kv["MemAvailable"],
		Cached: kv["Cached"] + kv["SReclaimable"] + kv["Buffers"], SwapTotal: kv["SwapTotal"]}
	m.Used = m.Total - m.Avail
	m.SwapUsed = kv["SwapTotal"] - kv["SwapFree"]
	return m
}

var realFS = map[string]bool{"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true,
	"f2fs": true, "vfat": true, "exfat": true, "ntfs": true, "ntfs3": true, "jfs": true, "reiserfs": true}

// realMounts lists real filesystems from mountinfo: no loop/snap/tmpfs/overlay, one entry per device.
func realMounts(b []byte, root string) []Mount {
	seen := map[string]bool{}
	var out []Mount
	for _, line := range strings.Split(string(b), "\n") {
		pre, post, ok := strings.Cut(line, " - ")
		if !ok {
			continue
		}
		f, g := strings.Fields(pre), strings.Fields(post)
		if len(f) < 5 || len(g) < 2 {
			continue
		}
		mp, fs, dev := unescapeMount(f[4]), g[0], g[1]
		if !realFS[fs] || strings.HasPrefix(dev, "/dev/loop") || strings.HasPrefix(mp, "/snap/") || seen[dev] {
			continue
		}
		seen[dev] = true
		var s syscall.Statfs_t
		if syscall.Statfs(filepath.Join(root, mp), &s) != nil || s.Blocks == 0 {
			continue
		}
		bs := int64(s.Bsize)
		mib := func(n uint64) int64 { return int64(n) * bs >> 20 }
		out = append(out, Mount{Path: mp, FS: fs, Dev: filepath.Base(dev),
			Size: mib(s.Blocks), Used: mib(s.Blocks - s.Bfree), Avail: mib(s.Bavail)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Size > out[j].Size })
	return out
}

func unescapeMount(s string) string { return strings.ReplaceAll(s, `\040`, " ") }

// ---------- processes ----------

func (p *Pulse) processes(now float64) *Procs {
	ents, err := os.ReadDir(p.path("proc"))
	if err != nil {
		return nil
	}
	dt := now - p.prevPT
	cur := make(map[int]uint64, len(p.prevProc))
	var all []Proc
	groups := map[string]*Group{}
	buf := make([]byte, 0, 1024)
	self := os.Getpid()
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		dir := p.path("proc/" + e.Name())
		st, ok := readInto(filepath.Join(dir, "stat"), buf)
		if !ok {
			continue
		}
		name, ticks, threads, ok := parsePidStat(st)
		if !ok {
			continue
		}
		cur[pid] = ticks
		cpu := 0.0
		if prev, ok := p.prevProc[pid]; ok && dt > 0 {
			cpu = float64(sub(ticks, prev)) / p.clkTck / dt * 100
		}
		var rss int64
		if sm, ok := readInto(filepath.Join(dir, "statm"), buf); ok {
			if f := strings.Fields(string(sm)); len(f) > 1 {
				pages, _ := strconv.ParseInt(f[1], 10, 64)
				rss = int64(float64(pages) * p.pageMiB)
			}
		}
		user := ""
		if fi, err := os.Stat(dir); err == nil {
			if sys, ok := fi.Sys().(*syscall.Stat_t); ok {
				user = p.users[sys.Uid]
				if user == "" {
					user = strconv.Itoa(int(sys.Uid))
				}
			}
		}
		pr := Proc{PID: pid, Name: name, User: user, CPU: round1(cpu), MemMiB: rss, Threads: threads}
		if p.showArgs {
			pr.Cmd = scrubArgs(readFile(filepath.Join(dir, "cmdline")))
		}
		all = append(all, pr)
		g := groups[name]
		if g == nil {
			g = &Group{Name: name}
			groups[name] = g
		}
		g.N++
		g.CPU += cpu
		g.MemMiB += rss
	}
	p.prevProc, p.prevPT = cur, now

	sort.Slice(all, func(i, j int) bool {
		if all[i].CPU != all[j].CPU {
			return all[i].CPU > all[j].CPU
		}
		return all[i].MemMiB > all[j].MemMiB
	})
	gl := make([]Group, 0, len(groups))
	for _, g := range groups {
		g.CPU = round1(g.CPU)
		gl = append(gl, *g)
	}
	sort.Slice(gl, func(i, j int) bool {
		if gl[i].CPU != gl[j].CPU {
			return gl[i].CPU > gl[j].CPU
		}
		return gl[i].MemMiB > gl[j].MemMiB
	})
	out := &Procs{Count: len(all), Top: all[:min(25, len(all))], Groups: gl[:min(15, len(gl))]}
	// with hidepid=1/2 we only see ourselves (and maybe a handful of others)
	out.Hidden = len(all) <= 3 && len(all) > 0 && all[0].PID == self
	return out
}

func readInto(path string, buf []byte) ([]byte, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	buf = buf[:cap(buf)]
	n, err := f.Read(buf)
	if n == 0 {
		return nil, false
	}
	_ = err
	return buf[:n], true
}

// parsePidStat reads comm, utime+stime and num_threads from /proc/[pid]/stat.
// comm is between the first "(" and the LAST ")" (names may contain spaces and parentheses).
func parsePidStat(b []byte) (name string, ticks uint64, threads int, ok bool) {
	l, r := bytes.IndexByte(b, '('), bytes.LastIndexByte(b, ')')
	if l < 0 || r <= l {
		return
	}
	name = string(b[l+1 : r])
	f := strings.Fields(string(b[r+1:]))
	// after ")": state(0) ppid(1) … utime(11) stime(12) … num_threads(17)
	if len(f) < 18 {
		return
	}
	ut, _ := strconv.ParseUint(f[11], 10, 64)
	stt, _ := strconv.ParseUint(f[12], 10, 64)
	threads, _ = strconv.Atoi(f[17])
	return name, ut + stt, threads, true
}

// ---------- argument scrubbing (opt-in only) ----------

var (
	secretFlag  = regexp.MustCompile(`(?i)^(--?[\w.-]*(pass|token|secret|key|auth|cred|cookie|session)[\w.-]*)(=.*)?$`)
	secretKV    = regexp.MustCompile(`(?i)^([\w.-]*(pass|token|secret|key|auth|cred|cookie|session)[\w.-]*)=.*$`)
	urlUserinfo = regexp.MustCompile(`([a-zA-Z][\w+.-]*://)[^/@\s]+@`)
	longBlob    = regexp.MustCompile(`[A-Za-z0-9+/=_-]{20,}`)
)

// scrubArgs turns a NUL-separated cmdline into a safe display string: values of secret-looking flags and
// KEY=VALUE pairs, URL credentials, and long base64/hex runs are replaced with "•••".
func scrubArgs(cmdline []byte) string {
	parts := strings.Split(strings.TrimRight(string(cmdline), "\x00"), "\x00")
	redactNext := false
	for i, a := range parts {
		if redactNext {
			parts[i], redactNext = "•••", false
			continue
		}
		if m := secretFlag.FindStringSubmatch(a); m != nil {
			if m[3] != "" {
				parts[i] = m[1] + "=•••"
			} else {
				redactNext = true
			}
			continue
		}
		if m := secretKV.FindStringSubmatch(a); m != nil {
			parts[i] = m[1] + "=•••"
			continue
		}
		a = urlUserinfo.ReplaceAllString(a, "$1•••@")
		parts[i] = longBlob.ReplaceAllString(a, "•••")
	}
	s := strings.Join(parts, " ")
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

func round1(x float64) float64 { return float64(int64(x*10+0.5)) / 10 }

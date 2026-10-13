package main

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// Chart ids, contexts and dimension names match Netdata's, so the dashboard reads this agent unchanged.
type chartDef struct {
	ID, Context string
	Dims        []string
}

// Collector reads /proc and /sys. Counters (cpu, disk, network) become rates from the previous reading.
type Collector struct {
	root      string // "/" in production; a fixture directory in tests
	prevCPU   []uint64
	prevIO    [2]uint64 // sectors read, written
	prevNet   [2]uint64 // bytes received, sent
	prevT     float64   // seconds, monotonic-ish (from the sampler)
	temps     []tempSensor
	disks     []string // physical block devices
	ifaces    []string // physical network interfaces
	charts    []chartDef
	haveDelta bool
}

type tempSensor struct{ name, path string }

func NewCollector(root string) *Collector {
	c := &Collector{root: root}
	c.disks = c.physical("sys/block")
	c.ifaces = c.physical("sys/class/net")
	c.temps = c.findTemps()
	c.charts = []chartDef{
		{"system.cpu", "system.cpu", []string{"user", "system", "nice", "iowait", "irq", "softirq", "steal"}},
		{"system.ram", "system.ram", []string{"free", "used", "cached", "buffers"}},
		{"system.load", "system.load", []string{"load1", "load5", "load15"}},
		{"system.io", "system.io", []string{"reads", "writes"}},
		{"system.net", "system.net", []string{"received", "sent"}},
		{"disk_space._", "disk.space", []string{"avail", "used", "reserved_for_root"}},
		{"system.uptime", "system.uptime", []string{"uptime"}},
	}
	if len(c.temps) > 0 {
		dims := make([]string, len(c.temps))
		for i, t := range c.temps {
			dims[i] = t.name
		}
		c.charts = append(c.charts, chartDef{"sensors.temperature", "sensors.temperature", dims})
	}
	return c
}

func (c *Collector) Charts() []chartDef { return c.charts }

func (c *Collector) path(p string) string { return filepath.Join(c.root, p) }

// physical lists entries that have a backing device (skips loop, ram, dm-*, lo, docker, veth, tailscale…).
func (c *Collector) physical(dir string) []string {
	ents, _ := os.ReadDir(c.path(dir))
	var out []string
	for _, e := range ents {
		if _, err := os.Stat(c.path(filepath.Join(dir, e.Name(), "device"))); err == nil {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

func (c *Collector) findTemps() []tempSensor {
	var out []tempSensor
	seen := map[string]bool{}
	hw, _ := filepath.Glob(c.path("sys/class/hwmon/hwmon*/temp*_input"))
	sort.Strings(hw)
	for _, p := range hw {
		dir := filepath.Dir(p)
		chip := readTrim(filepath.Join(dir, "name"))
		label := readTrim(strings.TrimSuffix(p, "_input") + "_label")
		if label == "" {
			label = strings.TrimSuffix(filepath.Base(p), "_input")
		}
		name := sanitize(chip + "_" + label)
		for i := 2; seen[name]; i++ {
			name = sanitize(chip+"_"+label) + "_" + strconv.Itoa(i)
		}
		seen[name] = true
		out = append(out, tempSensor{name, p})
	}
	if len(out) == 0 { // VMs and some boards expose only thermal zones
		tz, _ := filepath.Glob(c.path("sys/class/thermal/thermal_zone*/temp"))
		sort.Strings(tz)
		for _, p := range tz {
			name := sanitize(readTrim(filepath.Join(filepath.Dir(p), "type")) + "_" + filepath.Base(filepath.Dir(p)))
			out = append(out, tempSensor{name, p})
		}
	}
	return out
}

// Sample returns one reading per chart (values in chart dim order). now is seconds since epoch.
// Rate charts are zero on the very first call.
func (c *Collector) Sample(now float64) map[string][]float64 {
	out := make(map[string][]float64, len(c.charts))
	dt := now - c.prevT
	rate := c.haveDelta && dt > 0

	if cpu := parseCPU(readFile(c.path("proc/stat"))); cpu != nil {
		v := make([]float64, 7)
		if rate && len(c.prevCPU) == len(cpu) {
			v = cpuPercent(c.prevCPU, cpu)
		}
		c.prevCPU = cpu
		out["system.cpu"] = v
	}
	if m := parseMeminfo(readFile(c.path("proc/meminfo"))); m != nil {
		out["system.ram"] = m
	}
	if l := parseLoadavg(readFile(c.path("proc/loadavg"))); l != nil {
		out["system.load"] = l
	}
	rd, wr := parseDiskstats(readFile(c.path("proc/diskstats")), c.disks)
	io := []float64{0, 0}
	if rate {
		io = []float64{float64(sub(rd, c.prevIO[0])) * 512 / 1024 / dt, -float64(sub(wr, c.prevIO[1])) * 512 / 1024 / dt}
	}
	c.prevIO = [2]uint64{rd, wr}
	out["system.io"] = io

	rx, tx := parseNetdev(readFile(c.path("proc/net/dev")), c.ifaces)
	net := []float64{0, 0}
	if rate {
		net = []float64{float64(sub(rx, c.prevNet[0])) * 8 / 1000 / dt, -float64(sub(tx, c.prevNet[1])) * 8 / 1000 / dt}
	}
	c.prevNet = [2]uint64{rx, tx}
	out["system.net"] = net

	if d := diskSpace(c.path("")); d != nil {
		out["disk_space._"] = d
	}
	if up := parseUptime(readFile(c.path("proc/uptime"))); up >= 0 {
		out["system.uptime"] = []float64{up}
	}
	if len(c.temps) > 0 {
		v := make([]float64, len(c.temps))
		for i, t := range c.temps {
			if n, err := strconv.ParseFloat(readTrim(t.path), 64); err == nil {
				v[i] = n / 1000
			}
		}
		out["sensors.temperature"] = v
	}
	c.prevT = now
	c.haveDelta = true
	return out
}

// ---------- parsers (pure; tested with real /proc text) ----------

// parseCPU returns the aggregate "cpu" line: user nice system idle iowait irq softirq steal.
func parseCPU(b []byte) []uint64 {
	line, _, _ := bytes.Cut(b, []byte("\n"))
	f := strings.Fields(string(line))
	if len(f) < 9 || f[0] != "cpu" {
		return nil
	}
	out := make([]uint64, 8)
	for i := range out {
		out[i], _ = strconv.ParseUint(f[i+1], 10, 64)
	}
	return out
}

// cpuPercent turns two cumulative readings into Netdata's system.cpu dims (percent of all CPU time).
func cpuPercent(a, b []uint64) []float64 {
	var total uint64
	d := make([]uint64, 8)
	for i := range d {
		d[i] = sub(b[i], a[i])
		total += d[i]
	}
	if total == 0 {
		return make([]float64, 7)
	}
	p := func(x uint64) float64 { return float64(x) * 100 / float64(total) }
	// order: user system nice iowait irq softirq steal (idle = d[3] is left out)
	return []float64{p(d[0]), p(d[2]), p(d[1]), p(d[4]), p(d[5]), p(d[6]), p(d[7])}
}

// parseMeminfo returns free, used, cached, buffers in MiB (they sum to MemTotal, like Netdata).
func parseMeminfo(b []byte) []float64 {
	kv := map[string]float64{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 2 {
			n, _ := strconv.ParseFloat(f[1], 64)
			kv[strings.TrimSuffix(f[0], ":")] = n
		}
	}
	total := kv["MemTotal"]
	if total == 0 {
		return nil
	}
	free, buffers := kv["MemFree"], kv["Buffers"]
	cached := kv["Cached"] + kv["SReclaimable"] - kv["Shmem"]
	if cached < 0 {
		cached = kv["Cached"]
	}
	used := total - free - buffers - cached
	if used < 0 {
		used = 0
	}
	mib := func(k float64) float64 { return k / 1024 }
	return []float64{mib(free), mib(used), mib(cached), mib(buffers)}
}

func parseLoadavg(b []byte) []float64 {
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return nil
	}
	out := make([]float64, 3)
	for i := range out {
		out[i], _ = strconv.ParseFloat(f[i], 64)
	}
	return out
}

// parseDiskstats sums sectors read/written over the given whole disks.
func parseDiskstats(b []byte, disks []string) (rd, wr uint64) {
	want := make(map[string]bool, len(disks))
	for _, d := range disks {
		want[d] = true
	}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 10 || !want[f[2]] {
			continue
		}
		r, _ := strconv.ParseUint(f[5], 10, 64)
		w, _ := strconv.ParseUint(f[9], 10, 64)
		rd += r
		wr += w
	}
	return
}

// parseNetdev sums received/sent bytes over the given interfaces.
func parseNetdev(b []byte, ifaces []string) (rx, tx uint64) {
	want := make(map[string]bool, len(ifaces))
	for _, i := range ifaces {
		want[i] = true
	}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok || !want[strings.TrimSpace(name)] {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(f[0], 10, 64)
		t, _ := strconv.ParseUint(f[8], 10, 64)
		rx += r
		tx += t
	}
	return
}

func parseUptime(b []byte) float64 {
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return -1
	}
	n, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return -1
	}
	return n
}

// diskSpace returns avail, used, reserved_for_root in GiB for the filesystem at path.
func diskSpace(path string) []float64 {
	var s syscall.Statfs_t
	if err := syscall.Statfs(path, &s); err != nil {
		return nil
	}
	bs := float64(s.Bsize)
	gib := func(blocks uint64) float64 { return float64(blocks) * bs / (1 << 30) }
	return []float64{gib(s.Bavail), gib(s.Blocks - s.Bfree), gib(s.Bfree - s.Bavail)}
}

// sub handles counter resets (reboot, device re-plug) by treating a decrease as zero.
func sub(b, a uint64) uint64 {
	if b < a {
		return 0
	}
	return b - a
}

func readFile(p string) []byte {
	b, _ := os.ReadFile(p)
	return b
}

func readTrim(p string) string { return strings.TrimSpace(string(readFile(p))) }

func sanitize(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return strings.Trim(b.String(), "_")
}

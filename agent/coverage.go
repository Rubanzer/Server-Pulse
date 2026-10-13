package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Coverage tells the dashboard what this agent holds and when it was running, so a hole in the history
// can be labelled honestly: "server was off" (the machine booted after the gap), "agent not running"
// (same boot), or "not synced yet" (the agent has it, the dashboard hasn't fetched it).

// Run is one start of the agent.
type Run struct {
	Start int64  `json:"start"` // unix seconds
	Boot  string `json:"boot"`  // /proc/sys/kernel/random/boot_id: changes on every boot
	BTime int64  `json:"btime"` // when the machine booted (unix seconds)
}

const maxRuns = 500

// recordRun appends this start to runs.jsonl (kept to the last maxRuns lines) and returns the history.
func recordRun(dir string, now int64) []Run {
	path := filepath.Join(dir, "runs.jsonl")
	runs := readRuns(path)
	runs = append(runs, Run{Start: now, Boot: readTrim("/proc/sys/kernel/random/boot_id"), BTime: bootTime()})
	if len(runs) > maxRuns {
		runs = runs[len(runs)-maxRuns:]
	}
	tmp := path + ".tmp"
	if f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		w := bufio.NewWriter(f)
		for _, r := range runs {
			b, _ := json.Marshal(r)
			w.Write(append(b, '\n'))
		}
		w.Flush()
		f.Close()
		os.Rename(tmp, path)
	}
	return runs
}

func readRuns(path string) []Run {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []Run
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var r Run
		if json.Unmarshal(sc.Bytes(), &r) == nil && r.Start > 0 {
			out = append(out, r)
		}
	}
	return out
}

// bootTime reads "btime" from /proc/stat.
func bootTime() int64 {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "btime "); ok {
			n, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			return n
		}
	}
	return 0
}

// Segments returns the stretches [from, to] covered by the 1-minute tier, splitting wherever two
// minutes are more than maxGap seconds apart. O(n) over at most 43,200 slots.
func (s *Store) Segments(maxGap int64) [][2]int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t := s.coarse
	var out [][2]int64
	for i := 0; i < t.Len; i++ {
		ts := t.Times[t.at(i)]
		if n := len(out); n > 0 && ts-out[n-1][1] <= maxGap {
			out[n-1][1] = ts
		} else {
			out = append(out, [2]int64{ts - 60, ts}) // a minute row covers the minute before its stamp
		}
	}
	return out
}

// coverage → {now, oldest, segments: [[from,to]…], runs: […]}
func (a *API) handleCoverage(w http.ResponseWriter, _ *http.Request) {
	segs := a.store.Segments(90)
	oldest := int64(0)
	if len(segs) > 0 {
		oldest = segs[0][0]
	}
	if segs == nil {
		segs = [][2]int64{}
	}
	runs := a.runs
	if runs == nil {
		runs = []Run{}
	}
	writeJSON(w, map[string]any{"now": time.Now().Unix(), "oldest": oldest, "segments": segs, "runs": runs})
}

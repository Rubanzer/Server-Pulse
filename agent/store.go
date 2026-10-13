package main

import (
	"encoding/gob"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// tier is a fixed-capacity ring of readings: one shared timestamp ring and one flat value ring per chart.
// Push is O(1); range lookups binary-search the (ascending) timestamps.
type tier struct {
	Cap    int
	Head   int // next write position
	Len    int
	Times  []int64
	Values map[string][]float64 // chart -> Cap*ndims values
	Dims   map[string]int
}

func newTier(capacity int, charts []chartDef) *tier {
	t := &tier{Cap: capacity, Times: make([]int64, capacity), Values: map[string][]float64{}, Dims: map[string]int{}}
	for _, c := range charts {
		t.Dims[c.ID] = len(c.Dims)
		t.Values[c.ID] = make([]float64, capacity*len(c.Dims))
	}
	return t
}

func (t *tier) push(ts int64, vals map[string][]float64) {
	t.Times[t.Head] = ts
	for id, n := range t.Dims {
		dst := t.Values[id][t.Head*n : (t.Head+1)*n]
		if v, ok := vals[id]; ok && len(v) == n {
			copy(dst, v)
		} else {
			for i := range dst {
				dst[i] = math.NaN() // missing reading → gap, never a fake zero
			}
		}
	}
	t.Head = (t.Head + 1) % t.Cap
	if t.Len < t.Cap {
		t.Len++
	}
}

// at maps a logical index (0 = oldest) to a ring slot.
func (t *tier) at(i int) int { return (t.Head - t.Len + i + t.Cap) % t.Cap }

func (t *tier) oldest() int64 {
	if t.Len == 0 {
		return math.MaxInt64
	}
	return t.Times[t.at(0)]
}

// span returns logical indexes [lo, hi) whose timestamps fall in [after, before].
func (t *tier) span(after, before int64) (int, int) {
	lo := sort.Search(t.Len, func(i int) bool { return t.Times[t.at(i)] >= after })
	hi := sort.Search(t.Len, func(i int) bool { return t.Times[t.at(i)] > before })
	return lo, hi
}

// Store holds 1 s readings for an hour and 1 min averages for 30 days.
type Store struct {
	mu     sync.RWMutex
	charts []chartDef
	fine   *tier // 1 s
	coarse *tier // 60 s
	acc    map[string][]float64
	accN   map[string][]int
	accMin int64
	latest map[string][]float64
	lastTS int64
}

const (
	fineCap   = 3600
	coarseCap = 30 * 24 * 60
)

func NewStore(charts []chartDef) *Store {
	return &Store{
		charts: charts,
		fine:   newTier(fineCap, charts),
		coarse: newTier(coarseCap, charts),
		acc:    map[string][]float64{},
		accN:   map[string][]int{},
	}
}

func (s *Store) Add(ts int64, vals map[string][]float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// the rings are binary-searched, so time must only move forward. A clock stepped back (NTP fix)
	// leaves a gap until it catches up instead of corrupting the order.
	// ponytail: drops readings for as long as the step was; a monotonic offset would keep them.
	if ts <= s.lastTS || (s.coarse.Len > 0 && ts/60*60+60 < s.coarse.Times[s.coarse.at(s.coarse.Len-1)]) {
		return
	}
	s.fine.push(ts, vals)
	s.latest, s.lastTS = vals, ts

	// minute roll-up: average each dim over the readings seen in that minute
	minute := ts / 60 * 60
	if s.accMin != 0 && minute != s.accMin {
		s.flushMinute()
	}
	s.accMin = minute
	for id, v := range vals {
		if len(s.acc[id]) != len(v) {
			s.acc[id], s.accN[id] = make([]float64, len(v)), make([]int, len(v))
		}
		for i, x := range v {
			if !math.IsNaN(x) {
				s.acc[id][i] += x
				s.accN[id][i]++
			}
		}
	}
}

func (s *Store) flushMinute() {
	avg := make(map[string][]float64, len(s.acc))
	for id, sum := range s.acc {
		v := make([]float64, len(sum))
		for i := range sum {
			if n := s.accN[id][i]; n > 0 {
				v[i] = sum[i] / float64(n)
			} else {
				v[i] = math.NaN()
			}
			sum[i], s.accN[id][i] = 0, 0
		}
		avg[id] = v
	}
	s.coarse.push(s.accMin+60, avg) // stamped at the end of the minute, like Netdata
}

func (s *Store) Latest() (int64, map[string][]float64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastTS, s.latest
}

// Query averages a chart's readings in [after, before] into at most `points` buckets, newest first
// (Netdata's default order). Rows are [time, dim...]; empty buckets are skipped. O(log n + k).
func (s *Store) Query(id string, after, before int64, points int) [][]float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	// 1 s detail when the range fits in the last hour and either the fine tier reaches back to `after`
	// or the coarse tier has nothing there yet (e.g. just after a restart); otherwise 1 min averages
	t := s.coarse
	if before-after <= fineCap {
		if lo, hi := s.coarse.span(after, before); after >= s.fine.oldest() || lo == hi {
			t = s.fine
		}
	}
	n, ok := t.Dims[id]
	if !ok || points <= 0 || before < after {
		return nil
	}
	lo, hi := t.span(after, before)
	width := int64(math.Ceil(float64(before-after+1) / float64(points)))
	if width < 1 {
		width = 1
	}
	vals := t.Values[id]
	var rows [][]float64
	var sum []float64
	var cnt []int
	cur := int64(math.MinInt64)
	emit := func() {
		if cur == math.MinInt64 {
			return
		}
		row := make([]float64, n+1)
		row[0] = float64(after + (cur+1)*width - 1) // bucket end
		any := false
		for i := 0; i < n; i++ {
			if cnt[i] > 0 {
				row[i+1] = sum[i] / float64(cnt[i])
				any = true
			} else {
				row[i+1] = math.NaN()
			}
		}
		if any {
			rows = append(rows, row)
		}
	}
	for i := lo; i < hi; i++ {
		slot := t.at(i)
		b := (t.Times[slot] - after) / width
		if b != cur {
			emit()
			cur, sum, cnt = b, make([]float64, n), make([]int, n)
		}
		for d := 0; d < n; d++ {
			if x := vals[slot*n+d]; !math.IsNaN(x) {
				sum[d] += x
				cnt[d]++
			}
		}
	}
	emit()
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows
}

// ---------- persistence: the 30-day tier survives restarts and reboots ----------

func (s *Store) Save(path string) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if err := gob.NewEncoder(f).Encode(s.coarse); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	f.Close()
	return os.Rename(tmp, path) // atomic: a crash mid-save never leaves a half-written file
}

// Load restores the 30-day tier. Charts whose dimensions changed (e.g. a sensor was added) start fresh.
func (s *Store) Load(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var old tier
	if err := gob.NewDecoder(f).Decode(&old); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if old.Cap != coarseCap || len(old.Times) != coarseCap {
		return nil
	}
	s.coarse.Times, s.coarse.Head, s.coarse.Len = old.Times, old.Head, old.Len
	for id, n := range s.coarse.Dims {
		if old.Dims[id] == n && len(old.Values[id]) == coarseCap*n {
			s.coarse.Values[id] = old.Values[id]
		} else {
			v := s.coarse.Values[id]
			for i := range v {
				v[i] = math.NaN()
			}
		}
	}
	return nil
}

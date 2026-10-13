package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSegmentsSplitAtGaps(t *testing.T) {
	s := NewStore(testCharts)
	add := func(from, to int64) {
		for ts := from; ts <= to; ts++ {
			s.Add(ts, map[string][]float64{})
		}
	}
	add(60_000, 60_600) // 10 minutes
	add(64_200, 64_500) // server off for an hour, then 5 minutes
	s.Add(64_561, nil)  // flush the last minute
	segs := s.Segments(90)
	if len(segs) != 2 || segs[0][0] != 60_000 || segs[1][0] != 64_200 {
		t.Fatalf("segments %v", segs)
	}
}

func TestClockSteppedBackIsDropped(t *testing.T) {
	s := NewStore(testCharts)
	for ts := int64(1000); ts < 1200; ts++ {
		s.Add(ts, map[string][]float64{})
	}
	s.Add(500, map[string][]float64{}) // NTP stepped the clock back
	if ts, _ := s.Latest(); ts != 1199 {
		t.Fatalf("latest %d", ts)
	}
	times := s.coarse.Times[:s.coarse.Len]
	for i := 1; i < len(times); i++ {
		if times[i] <= times[i-1] {
			t.Fatalf("minute tier out of order: %v", times)
		}
	}
}

func TestRunsAndSavedCursor(t *testing.T) {
	dir := t.TempDir()
	recordRun(dir, 100)
	if r := recordRun(dir, 200); len(r) != 2 || r[1].Start != 200 {
		t.Fatalf("runs %+v", r)
	}
	p := filepath.Join(dir, "journal.cursor")
	os.WriteFile(p, []byte("s=abc;i=1\n"), 0o600)
	if c := savedCursor(p); c != "s=abc;i=1" {
		t.Fatalf("cursor %q", c)
	}
	old := time.Now().Add(-8 * 24 * time.Hour)
	os.Chtimes(p, old, old)
	if c := savedCursor(p); c != "" {
		t.Fatalf("a week-old cursor should be ignored, got %q", c)
	}
}

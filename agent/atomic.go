package main

import (
	"bufio"
	"os"
)

// writeAtomic replaces path with what write produces, or leaves it untouched: the new content goes to a
// temporary file that is flushed, synced to disk and only then renamed over path. A full disk, an I/O
// error or a power cut mid-write never leaves a truncated or empty file in place of a good one.
func writeAtomic(path string, write func(w *bufio.Writer) error) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	if err = write(w); err == nil {
		if err = w.Flush(); err == nil {
			err = f.Sync()
		}
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

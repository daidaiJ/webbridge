// Package activity keeps the small in-memory action ring shown in the
// extension popup. It is bounded so a long MCP session cannot grow memory.
package activity

import (
	"sync"
	"time"
)

const maxEntries = 30

type Entry struct {
	At      string `json:"at"`
	Tool    string `json:"tool"`
	Session string `json:"session"`
	OK      bool   `json:"ok"`
	MS      int64  `json:"ms"`
	Detail  string `json:"detail,omitempty"`
}

type Log struct {
	mu      sync.Mutex
	entries []Entry
}

func New() *Log {
	return &Log{entries: make([]Entry, 0, maxEntries)}
}

func (l *Log) Record(tool, session string, ok bool, ms int64, detail string) {
	if len(detail) > 200 {
		detail = string([]rune(detail)[:200])
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, Entry{
		At:      time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Tool:    tool,
		Session: session,
		OK:      ok,
		MS:      ms,
		Detail:  detail,
	})
	if len(l.entries) > maxEntries {
		l.entries = l.entries[len(l.entries)-maxEntries:]
	}
}

func (l *Log) List(limit int) []Entry {
	if limit <= 0 {
		limit = 20
	}
	if limit > maxEntries {
		limit = maxEntries
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	start := len(l.entries) - limit
	if start < 0 {
		start = 0
	}
	entries := l.entries[start:]
	reversed := make([]Entry, 0, len(entries))
	for index := len(entries) - 1; index >= 0; index-- {
		reversed = append(reversed, entries[index])
	}
	return reversed
}

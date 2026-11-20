// Package handoff keeps pending human-in-the-loop prompts. State is
// process-local and served only on loopback, matching the Node server.
package handoff

import (
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

type Entry struct {
	ID           string `json:"id"`
	Reason       string `json:"reason"`
	Instructions string `json:"instructions"`
	Session      string `json:"session"`
	URL          string `json:"url"`
	CreatedAt    int64  `json:"createdAt"`
	Deadline     int64  `json:"deadline"`

	done   bool
	finish func(any)
}

type Store struct {
	mu      sync.Mutex
	pending []*Entry
	next    atomic.Uint64
	watches map[uint64]chan struct{}
	subs    map[uint64]func([]Entry)
	subID   uint64
}

func New() *Store {
	return &Store{
		watches: make(map[uint64]chan struct{}),
		subs:    make(map[uint64]func([]Entry)),
	}
}

// Open registers a handoff and returns its ID plus a wait channel and a finish
// function. finish is idempotent so a response and a timeout can race safely.
func (s *Store) Open(reason, instructions, session, url string, timeout time.Duration) (string, <-chan any, func(any)) {
	sequence := s.next.Add(1)
	id := strconv.FormatInt(time.Now().UnixMilli(), 36) + "h" + itoa(sequence)
	entry := &Entry{
		ID:           id,
		Reason:       reason,
		Instructions: instructions,
		Session:      session,
		URL:          url,
		CreatedAt:    time.Now().UnixMilli(),
		Deadline:     time.Now().Add(timeout).UnixMilli(),
	}
	wait := make(chan any, 1)
	finish := func(value any) {
		s.mu.Lock()
		if entry.done {
			s.mu.Unlock()
			return
		}
		entry.done = true
		s.removeLocked(id)
		s.mu.Unlock()
		wait <- value
		s.notify()
	}
	entry.finish = finish
	s.mu.Lock()
	s.pending = append(s.pending, entry)
	s.mu.Unlock()
	s.notify()
	return id, wait, finish
}

func (s *Store) Resume(id string) bool {
	s.mu.Lock()
	var found *Entry
	for _, entry := range s.pending {
		if entry.ID == id {
			found = entry
			break
		}
	}
	if found == nil {
		s.mu.Unlock()
		return false
	}
	finish := found.finish
	s.mu.Unlock()
	finish(map[string]any{"resumed": true, "handoff_id": id, "at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")})
	return true
}

func (s *Store) List() []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries := make([]Entry, 0, len(s.pending))
	for _, entry := range s.pending {
		entries = append(entries, *entry)
	}
	return entries
}

// Wait blocks until the pending set changes or wait expires. When prompts are
// already pending it returns immediately, so the extension never misses one
// created between its requests.
func (s *Store) Wait(wait time.Duration) []Entry {
	s.mu.Lock()
	if len(s.pending) > 0 {
		entries := s.listLocked()
		s.mu.Unlock()
		return entries
	}
	id := s.subID
	s.subID++
	wake := make(chan struct{})
	s.watches[id] = wake
	s.mu.Unlock()

	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-wake:
	case <-timer.C:
		s.mu.Lock()
		delete(s.watches, id)
		s.mu.Unlock()
	}
	return s.List()
}

// Subscribe pushes the current list immediately and then on every change.
// It returns an unsubscribe function.
func (s *Store) Subscribe(listener func([]Entry)) func() {
	s.mu.Lock()
	id := s.subID
	s.subID++
	s.subs[id] = listener
	current := s.listLocked()
	s.mu.Unlock()
	listener(current)
	return func() {
		s.mu.Lock()
		delete(s.subs, id)
		s.mu.Unlock()
	}
}

func (s *Store) notify() {
	s.mu.Lock()
	watchers := make([]chan struct{}, 0, len(s.watches))
	for id, wake := range s.watches {
		delete(s.watches, id)
		watchers = append(watchers, wake)
	}
	subs := make([]func([]Entry), 0, len(s.subs))
	for _, listener := range s.subs {
		subs = append(subs, listener)
	}
	entries := s.listLocked()
	s.mu.Unlock()

	for _, wake := range watchers {
		close(wake)
	}
	for _, listener := range subs {
		func() {
			defer func() { _ = recover() }()
			listener(entries)
		}()
	}
}

func (s *Store) removeLocked(id string) {
	for index, entry := range s.pending {
		if entry.ID == id {
			s.pending = append(s.pending[:index], s.pending[index+1:]...)
			return
		}
	}
}

func (s *Store) listLocked() []Entry {
	entries := make([]Entry, 0, len(s.pending))
	for _, entry := range s.pending {
		entries = append(entries, *entry)
	}
	return entries
}

func itoa(value uint64) string {
	if value == 0 {
		return "0"
	}
	var buffer [20]byte
	index := len(buffer)
	for value > 0 {
		index--
		buffer[index] = byte('0' + value%10)
		value /= 10
	}
	return string(buffer[index:])
}

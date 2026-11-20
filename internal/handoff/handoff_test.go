package handoff

import (
	"testing"
	"time"
)

func TestOpenResume(t *testing.T) {
	store := New()
	id, wait, _ := store.Open("reason", "instructions", "session", "https://example.com", time.Minute)
	if pending := store.List(); len(pending) != 1 || pending[0].ID != id {
		t.Fatalf("pending = %+v", pending)
	}
	if !store.Resume(id) {
		t.Fatal("resume returned false")
	}
	select {
	case outcome := <-wait:
		value, ok := outcome.(map[string]any)
		if !ok || value["resumed"] != true {
			t.Fatalf("outcome = %v", outcome)
		}
	case <-time.After(time.Second):
		t.Fatal("wait did not resolve")
	}
	if pending := store.List(); len(pending) != 0 {
		t.Fatalf("pending after resume = %+v", pending)
	}
	if store.Resume(id) {
		t.Fatal("second resume should fail")
	}
}

func TestWaitAndSubscribe(t *testing.T) {
	store := New()
	if pending := store.Wait(10 * time.Millisecond); len(pending) != 0 {
		t.Fatalf("empty wait = %+v", pending)
	}

	notifications := make(chan []Entry, 2)
	unsubscribe := store.Subscribe(func(pending []Entry) {
		notifications <- pending
	})
	if initial := <-notifications; len(initial) != 0 {
		t.Fatalf("initial = %+v", initial)
	}

	opened := make(chan []Entry, 1)
	go func() {
		opened <- store.Wait(time.Second)
	}()
	time.Sleep(20 * time.Millisecond)
	id, _, finish := store.Open("reason", "", "session", "", time.Minute)
	select {
	case pending := <-opened:
		if len(pending) != 1 || pending[0].ID != id {
			t.Fatalf("wait = %+v", pending)
		}
	case <-time.After(time.Second):
		t.Fatal("wait did not wake")
	}
	select {
	case pending := <-notifications:
		if len(pending) != 1 {
			t.Fatalf("notification = %+v", pending)
		}
	case <-time.After(time.Second):
		t.Fatal("subscribe did not notify")
	}
	finish(map[string]any{"timeout": true})
	unsubscribe()
}

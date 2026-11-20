package daemon

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestLeaseLifecycle(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEBBRIDGE_STATE_DIR", dir)
	manager := newState()
	if err := manager.ensureLease(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "leases"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("leases = %d, want 1", len(entries))
	}
	if others, err := manager.otherLiveLeases(); err != nil || len(others) != 0 {
		t.Fatalf("own lease counted as other: %v %v", others, err)
	}
	manager.releaseLease()
	entries, _ = os.ReadDir(filepath.Join(dir, "leases"))
	if len(entries) != 0 {
		t.Fatalf("lease file remained: %v", entries)
	}
}

func TestStartLockAndOwner(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEBBRIDGE_STATE_DIR", dir)
	manager := newState()
	lock, err := manager.acquireStartLock(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.acquireStartLock(200 * time.Millisecond); err == nil {
		t.Fatal("second lock should time out")
	}
	lock.release()
	second, err := manager.acquireStartLock(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	second.release()

	if err := manager.writeOwner(1234, "http://127.0.0.1:10086"); err != nil {
		t.Fatal(err)
	}
	owner, err := manager.readOwner()
	if err != nil {
		t.Fatal(err)
	}
	if owner.DaemonPID != 1234 || owner.URL != "http://127.0.0.1:10086" {
		t.Fatalf("owner = %+v", owner)
	}
	if err := manager.clearOwner(); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.readOwner(); !os.IsNotExist(err) {
		t.Fatalf("owner still readable: %v", err)
	}
}

func TestStaleStartLock(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WEBBRIDGE_STATE_DIR", dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manager := newState()
	// A dead PID with a recent timestamp must not block a new holder.
	if err := os.WriteFile(manager.lockPath(), []byte(`{"pid":999999,"at":`+nowMillis()+`}`), 0o644); err != nil {
		t.Fatal(err)
	}
	lock, err := manager.acquireStartLock(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	lock.release()
}

func nowMillis() string {
	return strconv.FormatInt(time.Now().UnixMilli(), 10)
}

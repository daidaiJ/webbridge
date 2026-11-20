package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type lease struct {
	PID int   `json:"pid"`
	At  int64 `json:"at"`
}

type owner struct {
	PID       int    `json:"pid"`
	DaemonPID int    `json:"daemonPid"`
	URL       string `json:"url"`
	At        int64  `json:"at"`
}

type state struct {
	dir string

	leaseOnce sync.Once
	leasePath string
	leaseErr  error
	stopBeat  chan struct{}
	beatOnce  sync.Once
}

func newState() *state {
	dir := strings.TrimSpace(os.Getenv("WEBBRIDGE_STATE_DIR"))
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".webbridge")
	}
	return &state{dir: dir}
}

func (s *state) leaseDir() string  { return filepath.Join(s.dir, "leases") }
func (s *state) lockPath() string  { return filepath.Join(s.dir, "daemon-start.lock") }
func (s *state) ownerPath() string { return filepath.Join(s.dir, "daemon-autostart.json") }

func (s *state) ensureLease() error {
	s.leaseOnce.Do(func() {
		if err := os.MkdirAll(s.leaseDir(), 0o755); err != nil {
			s.leaseErr = err
			return
		}
		suffix := make([]byte, 4)
		if _, err := rand.Read(suffix); err != nil {
			s.leaseErr = err
			return
		}
		s.leasePath = filepath.Join(s.leaseDir(), fmt.Sprintf("%d-%s.json", os.Getpid(), hex.EncodeToString(suffix)))
		info, _ := json.Marshal(lease{PID: os.Getpid(), At: time.Now().UnixMilli()})
		if err := os.WriteFile(s.leasePath, info, 0o644); err != nil {
			s.leaseErr = err
			return
		}
		go s.heartbeat()
	})
	return s.leaseErr
}

func (s *state) heartbeat() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if s.leasePath == "" {
			return
		}
		info, _ := json.Marshal(lease{PID: os.Getpid(), At: time.Now().UnixMilli()})
		_ = os.WriteFile(s.leasePath, info, 0o644)
	}
}

func (s *state) releaseLease() {
	if s.leasePath != "" {
		_ = os.Remove(s.leasePath)
		s.leasePath = ""
	}
}

func (s *state) otherLiveLeases() ([]lease, error) {
	entries, err := os.ReadDir(s.leaseDir())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var live []lease
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		file := filepath.Join(s.leaseDir(), entry.Name())
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var item lease
		if err := json.Unmarshal(data, &item); err != nil {
			_ = os.Remove(file)
			continue
		}
		if item.PID == os.Getpid() {
			continue
		}
		if pidAlive(item.PID) {
			live = append(live, item)
		} else {
			_ = os.Remove(file)
		}
	}
	return live, nil
}

type startLock struct {
	path string
	file *os.File
}

func (s *state) acquireStartLock(timeout time.Duration) (*startLock, error) {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		file, err := os.OpenFile(s.lockPath(), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			info, _ := json.Marshal(lease{PID: os.Getpid(), At: time.Now().UnixMilli()})
			_, _ = file.Write(info)
			return &startLock{path: s.lockPath(), file: file}, nil
		}
		if !os.IsExist(err) {
			return nil, err
		}
		stale := true
		if data, readErr := os.ReadFile(s.lockPath()); readErr == nil {
			var item lease
			if json.Unmarshal(data, &item) == nil {
				stale = !pidAlive(item.PID) || time.Since(time.UnixMilli(item.At)) > time.Minute
			}
		}
		if stale {
			_ = os.Remove(s.lockPath())
			continue
		}
		time.Sleep(150 * time.Millisecond)
	}
	return nil, fmt.Errorf("timed out waiting for the daemon start lock at %s", s.lockPath())
}

func (l *startLock) release() {
	if l.file != nil {
		_ = l.file.Close()
	}
	_ = os.Remove(l.path)
}

func (s *state) writeOwner(daemonPID int, url string) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	data, _ := json.Marshal(owner{PID: os.Getpid(), DaemonPID: daemonPID, URL: url, At: time.Now().UnixMilli()})
	return os.WriteFile(s.ownerPath(), data, 0o644)
}

func (s *state) readOwner() (*owner, error) {
	data, err := os.ReadFile(s.ownerPath())
	if err != nil {
		return nil, err
	}
	var value owner
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func (s *state) clearOwner() error {
	return os.Remove(s.ownerPath())
}

func idleMs() int64 {
	raw := strings.TrimSpace(os.Getenv("WEBBRIDGE_IDLE_MS"))
	if raw == "" {
		return 15 * 60 * 1000
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 15 * 60 * 1000
	}
	return value
}

func daemonPid() int {
	home, _ := os.UserHomeDir()
	data, err := os.ReadFile(filepath.Join(home, ".kimi-webbridge", "daemon.pid"))
	if err != nil {
		return 0
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return 0
	}
	// The daemon writes a bare PID; accept the JSON form used by older builds
	// and by some test fixtures.
	var value struct {
		PID int `json:"pid"`
	}
	if json.Unmarshal([]byte(text), &value) == nil && value.PID > 0 {
		return value.PID
	}
	parsed, err := strconv.Atoi(text)
	if err != nil || parsed <= 0 {
		return 0
	}
	return parsed
}

// Package daemon talks to the local Browser Bridge daemon and owns its
// on-demand lifecycle. It is the Go counterpart of src/daemon.mjs.
package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const DefaultBaseURL = "http://127.0.0.1:10086"

// Status is the subset of /status the MCP server reasons about. Raw keeps every
// field so status can be returned without losing newer daemon fields.
type Status struct {
	Running            bool
	ExtensionConnected bool
	Raw                map[string]any
}

// Error preserves the daemon's error code and the underlying transport error.
type Error struct {
	Code    string
	Message string
	Cause   error
}

func (e *Error) Error() string {
	return e.Message
}

func (e *Error) Unwrap() error { return e.Cause }

func IsCode(err error, code string) bool {
	var target *Error
	return errors.As(err, &target) && target.Code == code
}

type Client struct {
	BaseURL string
	BinPath string
	HTTP    *http.Client
	Managed bool

	state *state

	ensureMu sync.Mutex
	idleMu   sync.Mutex
	idle     *time.Timer
}

func New() *Client {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("WEBBRIDGE_URL")), "/")
	if base == "" {
		base = DefaultBaseURL
	}
	return &Client{
		BaseURL: base,
		BinPath: daemonBinary(),
		HTTP:    &http.Client{},
		Managed: os.Getenv("WEBBRIDGE_AUTOSTART") != "0",
		state:   newState(),
	}
}

func releaseName() string {
	switch runtime.GOOS {
	case "windows":
		return "windows-amd64.exe"
	case "darwin":
		if runtime.GOARCH == "arm64" {
			return "darwin-arm64"
		}
		return "darwin-amd64"
	default:
		if runtime.GOARCH == "arm64" {
			return "linux-arm64"
		}
		return "linux-amd64"
	}
}

func daemonBinary() string {
	if value := strings.TrimSpace(os.Getenv("WEBBRIDGE_BIN")); value != "" {
		return value
	}
	name := "kimi-webbridge"
	if os.PathSeparator == '\\' {
		name += ".exe"
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".kimi-webbridge", "bin", name)
}

// Status probes /status. A connection failure is returned as an error; callers
// that only need a boolean can ignore it.
func (c *Client) Status(ctx context.Context) (*Status, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, c.BaseURL+"/status", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("unexpected response from %s/status: %w", c.BaseURL, err)
	}
	return statusFromRaw(raw), nil
}

func statusFromRaw(raw map[string]any) *Status {
	running, _ := raw["running"].(bool)
	connected, _ := raw["extension_connected"].(bool)
	return &Status{Running: running, ExtensionConnected: connected, Raw: raw}
}

func (c *Client) Call(ctx context.Context, action string, args map[string]any, session string, timeout time.Duration) (any, error) {
	_ = c.state.ensureLease()
	c.touch()

	data, err := c.post(ctx, action, args, session, timeout)
	if err == nil {
		return data, nil
	}
	if !c.Managed || !IsCode(err, "daemon_unreachable") {
		return nil, err
	}
	if _, startErr := c.Ensure(ctx); startErr != nil {
		code := "daemon_start_failed"
		var daemonErr *Error
		if errors.As(startErr, &daemonErr) && daemonErr.Code != "" {
			code = daemonErr.Code
		}
		return nil, &Error{
			Code:    code,
			Message: fmt.Sprintf("%v Automatic start failed: %v", err, startErr),
			Cause:   err,
		}
	}
	return c.post(ctx, action, args, session, timeout)
}

func (c *Client) post(ctx context.Context, action string, args map[string]any, session string, timeout time.Duration) (any, error) {
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	payload, err := json.Marshal(map[string]any{
		"action":  action,
		"args":    args,
		"session": session,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, c.BaseURL+"/command", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			return nil, &Error{Code: "timeout", Message: fmt.Sprintf("%s did not answer within %d ms", action, timeout.Milliseconds()), Cause: err}
		}
		return nil, &Error{
			Code: "daemon_unreachable",
			Message: fmt.Sprintf(
				"cannot reach the browser daemon at %s (%v). Run the webbridge__start tool or %q start.",
				c.BaseURL, err, c.BinPath,
			),
			Cause: err,
		}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, &Error{Code: "bad_response", Message: fmt.Sprintf("cannot read response from %s: %v", c.BaseURL, err), Cause: err}
	}
	var envelope struct {
		OK    bool `json:"ok"`
		Data  any  `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, &Error{
			Code:    "bad_response",
			Message: fmt.Sprintf("%s answered %d with non-JSON: %s", c.BaseURL, resp.StatusCode, truncate(string(body), 200)),
			Cause:   err,
		}
	}
	if envelope.OK {
		return envelope.Data, nil
	}
	code := fmt.Sprintf("http_%d", resp.StatusCode)
	message := truncate(string(body), 300)
	if envelope.Error != nil {
		if envelope.Error.Code != "" {
			code = envelope.Error.Code
		}
		if envelope.Error.Message != "" {
			message = envelope.Error.Message
		}
	}
	return nil, &Error{Code: code, Message: message}
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

// Ensure starts the daemon when it is not answering. Concurrent cold starts
// serialize on the same file lock used by the Node client, so both runtimes can
// share one daemon during migration.
func (c *Client) Ensure(ctx context.Context) (*Status, error) {
	c.ensureMu.Lock()
	defer c.ensureMu.Unlock()

	if status, err := c.Status(ctx); err == nil && status.Running {
		c.touch()
		return status, nil
	}
	_ = c.state.ensureLease()

	lock, err := c.state.acquireStartLock(10 * time.Second)
	if err != nil {
		return nil, err
	}
	defer lock.release()

	if status, err := c.Status(ctx); err == nil && status.Running {
		return status, nil
	}
	if _, err := os.Stat(c.BinPath); err != nil {
		return nil, &Error{
			Code: "daemon_missing",
			Message: fmt.Sprintf(
				"the browser daemon is not installed. Expected %s. Download the release for this platform (%s) and place it there, or set WEBBRIDGE_BIN.",
				c.BinPath, releaseName(),
			),
			Cause: err,
		}
	}
	if err := spawnDetached(c.BinPath, "start"); err != nil {
		return nil, &Error{Code: "daemon_start_failed", Message: fmt.Sprintf("cannot start %s: %v", c.BinPath, err), Cause: err}
	}

	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if status, err := c.Status(ctx); err == nil && status.Running {
			pid := daemonPid()
			for attempt := 0; attempt < 10 && pid == 0; attempt++ {
				time.Sleep(50 * time.Millisecond)
				pid = daemonPid()
			}
			_ = c.state.writeOwner(pid, c.BaseURL)
			c.touch()
			return status, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
	return nil, &Error{Code: "daemon_timeout", Message: fmt.Sprintf("daemon did not come up on %s within 30s", c.BaseURL)}
}

// StopIfIdle stops a daemon started by an MCP client, unless another client
// still holds a lease. force is used by the explicit stop command.
func (c *Client) StopIfIdle(ctx context.Context, force bool) (bool, string, error) {
	owner, err := c.state.readOwner()
	if err != nil && !force {
		return false, "not_started_by_client", nil
	}
	if owner == nil && !force {
		return false, "not_started_by_client", nil
	}
	if owner != nil && owner.URL != "" && owner.URL != c.BaseURL {
		return false, "other_daemon", nil
	}
	if owner != nil && owner.DaemonPID > 0 {
		if current := daemonPid(); current > 0 && current != owner.DaemonPID {
			_ = c.state.clearOwner()
			return false, "daemon_replaced", nil
		}
	}

	lock, err := c.state.acquireStartLock(10 * time.Second)
	if err != nil {
		return false, "", err
	}
	defer lock.release()

	if !force {
		current, _ := c.state.readOwner()
		if current == nil {
			return false, "not_started_by_client", nil
		}
		others, err := c.state.otherLiveLeases()
		if err != nil {
			return false, "", err
		}
		if len(others) > 0 {
			return false, "in_use", nil
		}
	}
	status, _ := c.Status(ctx)
	if status == nil || !status.Running {
		_ = c.state.clearOwner()
		return false, "not_running", nil
	}

	stopCtx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(stopCtx, c.BinPath, "stop")
	_ = cmd.Run()
	_ = c.state.clearOwner()
	return true, "", nil
}

func (c *Client) Shutdown(ctx context.Context) {
	c.idleMu.Lock()
	if c.idle != nil {
		c.idle.Stop()
		c.idle = nil
	}
	c.idleMu.Unlock()
	c.state.releaseLease()
	_, _, _ = c.StopIfIdle(ctx, false)
}

func (c *Client) touch() {
	c.idleMu.Lock()
	defer c.idleMu.Unlock()
	if c.idle != nil {
		c.idle.Stop()
	}
	ms := idleMs()
	if ms <= 0 {
		c.idle = nil
		return
	}
	c.idle = time.AfterFunc(time.Duration(ms)*time.Millisecond, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		stopped, _, err := c.StopIfIdle(ctx, false)
		if err != nil || !stopped {
			c.touch()
		}
	})
}

package app

import (
	"context"
	"strings"
	"time"
)

const (
	minHumanTimeout = 5 * time.Second
	maxHumanTimeout = 10 * time.Minute
)

func (a *App) requestHuman(ctx context.Context, args map[string]any) (any, error) {
	reason := strings.TrimSpace(stringOf(args["reason"]))
	if reason == "" {
		reason = "The agent needs you in the browser"
	}
	instructions := strings.TrimSpace(stringOf(args["instructions"]))
	timeout := 120 * time.Second
	if value, ok := numberOf(args["timeout_ms"]); ok && value != 0 {
		timeout = clampDuration(time.Duration(value)*time.Millisecond, minHumanTimeout, maxHumanTimeout)
	}

	url := ""
	payload, err := a.Daemon.Call(ctx, "evaluate", map[string]any{"code": "location.href"}, a.Session(), 5*time.Second)
	if err == nil {
		if object, ok := payload.(map[string]any); ok {
			url, _ = object["value"].(string)
		}
	}

	id, wait, finish := a.Handoffs.Open(reason, instructions, a.Session(), url, timeout)
	timer := time.AfterFunc(timeout, func() {
		finish(map[string]any{"resumed": false, "handoff_id": id, "timeout": true})
	})

	// The handoff is registered before this call wakes the extension worker,
	// so its startup check can surface the prompt immediately.
	_, _ = a.Daemon.Call(ctx, "cdp", map[string]any{
		"method": "Page.bringToFront",
		"params": map[string]any{},
	}, a.Session(), 5*time.Second)

	outcome := <-wait
	timer.Stop()
	result := map[string]any{}
	if object, ok := outcome.(map[string]any); ok {
		for key, value := range object {
			result[key] = value
		}
	}
	result["url"] = url
	result["session"] = a.Session()
	return result, nil
}

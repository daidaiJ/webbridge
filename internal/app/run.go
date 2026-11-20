package app

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/daidaiJ/webbridge/shared/page"

	"github.com/daidaiJ/webbridge/internal/capture"
	"github.com/daidaiJ/webbridge/internal/catalog"
)

const defaultToolTimeout = 120 * time.Second

func (a *App) runTool(ctx context.Context, name string, args map[string]any) (any, error) {
	switch name {
	case "status":
		profile := map[string]any{"toolset": a.Toolset, "tools": len(a.visible)}
		state, err := a.Daemon.Status(ctx)
		if err != nil || state == nil || state.Raw == nil {
			return map[string]any{
				"running": false,
				"hint":    "browser tools start the daemon on demand",
				"toolset": profile["toolset"],
				"tools":   profile["tools"],
			}, nil
		}
		result := make(map[string]any, len(state.Raw)+2)
		for key, value := range state.Raw {
			result[key] = value
		}
		result["toolset"] = profile["toolset"]
		result["tools"] = profile["tools"]
		return result, nil
	case "start":
		state, err := a.Daemon.Ensure(ctx)
		if err != nil {
			return nil, err
		}
		return state.Raw, nil
	case "session":
		return map[string]any{"session": a.setSession(fmt.Sprint(args["name"]))}, nil
	case "browser_tools":
		target := ""
		if value, ok := args["tool"].(string); ok {
			target = strings.TrimSpace(value)
		}
		if target != "" {
			described := a.Catalog.Describe(target)
			if described == nil {
				return nil, fmt.Errorf("%s", a.Catalog.UnknownToolMessage(target))
			}
			return described, nil
		}
		query := ""
		if value, ok := args["query"].(string); ok {
			query = strings.TrimSpace(value)
		}
		if query != "" {
			return a.Catalog.Search(query), nil
		}
		return a.Catalog.Overview(), nil
	case "browser_call":
		return a.browserCall(ctx, args)
	case "read_article":
		return a.readArticle(ctx, args)
	case "capture_page":
		return capture.CurrentTab(ctx, args, a.Session(), a.Daemon.Call, page.Capture)
	case "extract":
		return a.extract(ctx, args)
	case "console":
		return a.console(ctx, args)
	case "request_human":
		return a.requestHuman(ctx, args)
	case "batch":
		return a.batch(ctx, args)
	}
	return a.forward(ctx, name, args)
}

func (a *App) browserCall(ctx context.Context, args map[string]any) (any, error) {
	target := ""
	if value, ok := args["tool"].(string); ok {
		target = strings.TrimSpace(value)
	}
	if target == "" {
		return nil, fmt.Errorf("browser_call: tool is required. Call browser_tools with no arguments for the catalog.")
	}
	if target == "browser_call" || target == "browser_tools" {
		return nil, fmt.Errorf("browser_call: %s manages the catalog; call it directly.", target)
	}
	if a.Catalog.IsCore(target) {
		return nil, fmt.Errorf("browser_call: %s is a core tool; call it directly.", target)
	}
	definition := a.Catalog.Find(target)
	if definition == nil {
		return nil, fmt.Errorf("%s", a.Catalog.UnknownToolMessage(target))
	}
	targetArgs := map[string]any{}
	if raw, exists := args["args"]; exists {
		object, ok := raw.(map[string]any)
		if !ok || raw == nil {
			return nil, fmt.Errorf(
				`browser_call: args for %s must be an object. Call browser_tools {tool:%q} for the schema.`,
				target, target,
			)
		}
		targetArgs = object
	}
	invalid := catalog.Validate(definition, targetArgs)
	if len(invalid) > 0 {
		return nil, fmt.Errorf(
			`Invalid arguments for %s: %s. Call browser_tools {tool:%q} for the schema.`,
			target, strings.Join(invalid, "; "), target,
		)
	}
	return a.runTool(ctx, target, targetArgs)
}

func (a *App) readArticle(ctx context.Context, args map[string]any) (any, error) {
	limit := 60000
	if value, ok := numberOf(args["max_chars"]); ok && value != 0 {
		limit = clampInt(int(value), 1000, 200000)
	}
	code := fmt.Sprintf("(%s)(%d)", page.Reader, limit)
	evaluated, err := a.Daemon.Call(ctx, "evaluate", map[string]any{"code": code}, a.Session(), 60*time.Second)
	if err != nil {
		return nil, err
	}
	payload, ok := payloadValue(evaluated).(map[string]any)
	if !ok {
		return nil, fmt.Errorf("reader: unexpected page payload: %s", truncateValue(evaluated, 200))
	}
	if _, ok := payload["text"].(string); !ok {
		return nil, fmt.Errorf("reader: unexpected page payload: %s", truncateValue(evaluated, 200))
	}
	payload["mode"] = "reader"
	return payload, nil
}

func (a *App) extract(ctx context.Context, args map[string]any) (any, error) {
	selector := strings.TrimSpace(stringOf(args["selector"]))
	if selector == "" {
		return nil, fmt.Errorf("extract: selector is required")
	}
	maxItems := 50
	if value, ok := numberOf(args["max_items"]); ok && value != 0 {
		maxItems = clampInt(int(value), 1, 500)
	}
	type field struct {
		Name     string `json:"name"`
		Selector string `json:"selector"`
		Attr     string `json:"attr"`
	}
	fields := make([]field, 0)
	if raw, exists := args["fields"]; exists {
		if list, ok := raw.([]any); ok {
			if len(list) > 12 {
				list = list[:12]
			}
			for index, item := range list {
				object, ok := item.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("extract: fields must be objects")
				}
				name := stringOf(object["name"])
				if name == "" {
					name = fmt.Sprintf("field%d", index+1)
				}
				if len([]rune(name)) > 80 {
					name = string([]rune(name)[:80])
				}
				entry := field{Name: name}
				if value, ok := object["selector"].(string); ok && value != "" {
					entry.Selector = value
				}
				if value, ok := object["attr"].(string); ok && value != "" {
					entry.Attr = value
				}
				fields = append(fields, entry)
			}
		}
	}
	encodedFields, _ := json.Marshal(fields)
	code := fmt.Sprintf(
		"(%s)(%s, %d, %s, %t)",
		page.Extract, jsString(selector), maxItems, encodedFields, args["include_empty"] == true,
	)
	evaluated, err := a.Daemon.Call(ctx, "evaluate", map[string]any{"code": code}, a.Session(), 60*time.Second)
	if err != nil {
		return nil, err
	}
	result, ok := payloadValue(evaluated).(map[string]any)
	if !ok {
		return nil, fmt.Errorf("extract: unexpected page payload")
	}
	if raw, exists := result["error"]; exists && truthy(raw) {
		return nil, fmt.Errorf("extract: %v", raw)
	}
	return result, nil
}

func (a *App) console(ctx context.Context, args map[string]any) (any, error) {
	action := stringOf(args["action"])
	if action != "start" && action != "read" && action != "stop" {
		action = "read"
	}
	code := fmt.Sprintf("(%s)(%s, %t)", page.Console, jsString(action), args["clear"] == true)
	evaluated, err := a.Daemon.Call(ctx, "evaluate", map[string]any{"code": code}, a.Session(), 30*time.Second)
	if err != nil {
		return nil, err
	}
	result, ok := payloadValue(evaluated).(map[string]any)
	if !ok {
		return nil, fmt.Errorf("console: unexpected page payload")
	}
	return result, nil
}

func (a *App) forward(ctx context.Context, name string, args map[string]any) (any, error) {
	forwarded := args
	if name == "navigate" && a.GroupTitle != "" {
		if _, exists := forwarded["group_title"]; !exists {
			copied := make(map[string]any, len(forwarded)+1)
			for key, value := range forwarded {
				copied[key] = value
			}
			copied["group_title"] = a.GroupTitle
			forwarded = copied
		}
	}
	action := name
	callArgs := forwarded
	adapted, err := adaptToolCall(name, forwarded)
	if err != nil {
		return nil, err
	}
	if adapted != nil {
		action = adapted.action
		callArgs = adapted.args
	}
	timeout := defaultToolTimeout
	if definition := a.Catalog.Find(name); definition != nil && definition.TimeoutMs > 0 {
		timeout = time.Duration(definition.TimeoutMs) * time.Millisecond
	}
	return a.Daemon.Call(ctx, action, callArgs, a.Session(), timeout)
}

func payloadValue(value any) any {
	if object, ok := value.(map[string]any); ok {
		if inner, exists := object["value"]; exists {
			return inner
		}
	}
	return value
}

func stringOf(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case nil:
		return ""
	default:
		return fmt.Sprint(typed)
	}
}

func numberOf(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func clampInt(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func clampDuration(value, minimum, maximum time.Duration) time.Duration {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func durationOf(value any, fallback time.Duration) time.Duration {
	number, ok := numberOf(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return fallback
	}
	return time.Duration(math.Round(number)) * time.Millisecond
}

func truthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0
	case []any:
		return len(typed) > 0
	case map[string]any:
		return len(typed) > 0
	default:
		return true
	}
}

func truncateValue(value any, limit int) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	runes := []rune(string(encoded))
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return string(runes)
}

func jsString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

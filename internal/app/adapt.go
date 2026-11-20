package app

import (
	"fmt"
	"math"
	"strings"
	"time"
)

type adaptedCall struct {
	action string
	args   map[string]any
}

func stringOrEmpty(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func selectorOf(args map[string]any) string {
	value := args["selector"]
	if value == nil {
		value = args["target"]
	}
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func highlightDuration(args map[string]any) time.Duration {
	value, ok := numberOf(args["duration_ms"])
	if !ok {
		return 30 * time.Second
	}
	return clampDuration(time.Duration(math.Round(value))*time.Millisecond, time.Second, 120*time.Second)
}

// adaptToolCall maps the model-facing tool names onto daemon actions. Most
// tools forward one-to-one; these few combine related actions.
func adaptToolCall(name string, input map[string]any) (*adaptedCall, error) {
	args := input
	if args == nil {
		args = map[string]any{}
	}
	switch name {
	case "history":
		action, _ := args["action"].(string)
		switch action {
		case "reload":
			return &adaptedCall{action: "reload", args: map[string]any{}}, nil
		case "back":
			return &adaptedCall{action: "go_back", args: map[string]any{}}, nil
		case "forward":
			return &adaptedCall{action: "go_forward", args: map[string]any{}}, nil
		default:
			return nil, fmt.Errorf("history: action must be reload, back, or forward")
		}
	case "highlight":
		action := "show"
		if value, _ := args["action"].(string); value == "clear" {
			action = "clear"
		}
		if action == "clear" {
			id, _ := args["highlight_id"].(string)
			id = strings.TrimSpace(id)
			if id == "" {
				return nil, fmt.Errorf("highlight: highlight_id is required to clear")
			}
			return &adaptedCall{action: "clear_highlight", args: map[string]any{"highlight_id": id}}, nil
		}
		if id, ok := args["highlight_id"].(string); ok && strings.TrimSpace(id) != "" {
			return &adaptedCall{
				action: "highlight_region",
				args: map[string]any{
					"highlight_id": strings.TrimSpace(id),
					"duration_ms":  highlightDuration(args).Milliseconds(),
				},
			}, nil
		}
		target := selectorOf(args)
		if target == "" {
			return nil, fmt.Errorf(`highlight: selector is required for action "show"`)
		}
		return &adaptedCall{
			action: "highlight_region",
			args:   map[string]any{"target": target, "duration_ms": highlightDuration(args).Milliseconds()},
		}, nil
	case "hover":
		target := selectorOf(args)
		if target == "" {
			return nil, fmt.Errorf("hover: selector is required")
		}
		callArgs := map[string]any{"target": target}
		if args["focus_emulation"] == true {
			callArgs["focus_emulation"] = true
		}
		return &adaptedCall{action: "hover", args: callArgs}, nil
	case "key_type":
		text, ok := args["text"].(string)
		if !ok {
			return nil, fmt.Errorf("key_type: text is required")
		}
		callArgs := map[string]any{"text": text}
		if args["focus_emulation"] == true {
			callArgs["focus_emulation"] = true
		}
		return &adaptedCall{action: "key_type", args: callArgs}, nil
	case "select_option":
		target := selectorOf(args)
		if target == "" {
			return nil, fmt.Errorf("select_option: selector is required")
		}
		callArgs := map[string]any{"target": target}
		if values, ok := args["values"].([]any); ok && len(values) > 0 {
			converted := make([]string, 0, len(values))
			for _, value := range values {
				converted = append(converted, fmt.Sprint(value))
			}
			callArgs["values"] = converted
		} else if value, ok := args["value"].(string); ok {
			callArgs["value"] = value
		}
		return &adaptedCall{action: "select_option", args: callArgs}, nil
	case "set_checked":
		target := selectorOf(args)
		if target == "" {
			return nil, fmt.Errorf("set_checked: selector is required")
		}
		checked, ok := args["checked"].(bool)
		if !ok {
			return nil, fmt.Errorf("set_checked: checked must be a boolean")
		}
		return &adaptedCall{action: "set_checked", args: map[string]any{"target": target, "checked": checked}}, nil
	case "scroll":
		callArgs := map[string]any{}
		if target := selectorOf(args); target != "" {
			callArgs["target"] = target
		} else if text, ok := args["text"].(string); ok && strings.TrimSpace(text) != "" {
			callArgs["text"] = strings.TrimSpace(text)
		}
		if to, _ := args["to"].(string); to == "top" || to == "bottom" {
			callArgs["to"] = to
		}
		if direction, _ := args["direction"].(string); direction == "up" || direction == "down" {
			callArgs["direction"] = direction
		}
		return &adaptedCall{action: "scroll", args: callArgs}, nil
	case "drag":
		from := stringOrEmpty(args["from"])
		to := stringOrEmpty(args["to"])
		if from == "" || to == "" {
			return nil, fmt.Errorf("drag: both from and to are required")
		}
		return &adaptedCall{action: "drag", args: map[string]any{"from": from, "to": to}}, nil
	case "activate_tab":
		callArgs := map[string]any{}
		if args["focus_window"] == true {
			callArgs["focus_window"] = true
		}
		return &adaptedCall{action: "activate_tab", args: callArgs}, nil
	}
	return nil, nil
}

package app

import (
	"context"
	"fmt"
	"strings"

	"github.com/daidaiJ/webbridge/internal/catalog"
)

func (a *App) batch(ctx context.Context, args map[string]any) (any, error) {
	steps := make([]any, 0)
	if list, ok := args["steps"].([]any); ok {
		steps = list
		if len(steps) > 40 {
			steps = steps[:40]
		}
	}
	stopOnError := true
	if value, ok := args["stop_on_error"].(bool); ok && !value {
		stopOnError = false
	}
	results := make([]map[string]any, 0, len(steps))
	for index, raw := range steps {
		step, _ := raw.(map[string]any)
		tool := ""
		if step != nil && step["tool"] != nil {
			tool = fmt.Sprint(step["tool"])
		}
		definition := a.Catalog.Find(tool)
		if definition == nil || tool == "batch" || tool == "request_human" || a.Catalog.IsMeta(tool) {
			results = append(results, map[string]any{
				"index": index,
				"tool":  tool,
				"ok":    false,
				"error": "step tool is not supported",
			})
			if stopOnError {
				break
			}
			continue
		}
		stepArgs := map[string]any{}
		if step != nil {
			if object, ok := step["args"].(map[string]any); ok {
				stepArgs = object
			}
		}
		invalid := catalog.Validate(definition, stepArgs)
		if len(invalid) > 0 {
			results = append(results, map[string]any{
				"index": index,
				"tool":  tool,
				"ok":    false,
				"error": "invalid arguments: " + strings.Join(invalid, "; "),
			})
			if stopOnError {
				break
			}
			continue
		}
		result, err := a.runTool(ctx, tool, stepArgs)
		if err != nil {
			results = append(results, map[string]any{
				"index": index,
				"tool":  tool,
				"ok":    false,
				"error": err.Error(),
			})
			if stopOnError {
				break
			}
			continue
		}
		results = append(results, map[string]any{
			"index":  index,
			"tool":   tool,
			"ok":     true,
			"result": result,
		})
	}
	return map[string]any{"steps": results}, nil
}

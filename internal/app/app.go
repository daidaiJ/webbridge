// Package app wires the Go MCP server to the shared daemon, catalog, page
// scripts, capture receiver, and handoff store.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/daidaiJ/webbridge/internal/activity"
	"github.com/daidaiJ/webbridge/internal/capture"
	"github.com/daidaiJ/webbridge/internal/catalog"
	"github.com/daidaiJ/webbridge/internal/daemon"
	"github.com/daidaiJ/webbridge/internal/handoff"
)

const defaultCapturePort = 10087

type App struct {
	Catalog  *catalog.Catalog
	Daemon   *daemon.Client
	Handoffs *handoff.Store
	Activity *activity.Log

	Toolset    string
	GroupTitle string

	sessionMu sync.RWMutex
	session   string

	visible  map[string]bool
	close    sync.Once
	receiver *capture.Receiver
}

// New validates the toolset and constructs the shared state. A bad
// WEBBRIDGE_TOOLSET is reported before the MCP transport starts, matching the
// Node server's startup failure.
func New() (*App, error) {
	loaded, err := catalog.Load()
	if err != nil {
		return nil, err
	}
	toolset := strings.ToLower(strings.TrimSpace(os.Getenv("WEBBRIDGE_TOOLSET")))
	if toolset == "" {
		toolset = "core"
	}
	if toolset != "core" && toolset != "full" {
		return nil, fmt.Errorf(`WEBBRIDGE_TOOLSET must be "core" or "full" (got %q)`, toolset)
	}
	session := os.Getenv("WEBBRIDGE_SESSION")
	if session == "" {
		session = "grok"
	}
	app := &App{
		Catalog:    loaded,
		Daemon:     daemon.New(),
		Handoffs:   handoff.New(),
		Activity:   activity.New(),
		Toolset:    toolset,
		GroupTitle: os.Getenv("WEBBRIDGE_GROUP_TITLE"),
		session:    session,
		visible:    make(map[string]bool),
	}
	for _, tool := range loaded.Visible(toolset) {
		app.visible[tool.Name] = true
	}
	return app, nil
}

func (a *App) Session() string {
	a.sessionMu.RLock()
	defer a.sessionMu.RUnlock()
	return a.session
}

func (a *App) setSession(name string) string {
	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()
	a.session = strings.TrimSpace(name)
	return a.session
}

// Serve runs the stdio MCP session and closes local resources when the client
// disconnects.
func (a *App) Serve(ctx context.Context) error {
	server := a.newServer()
	receiver, err := capture.Start("", capturePort(), "", a.Handoffs, a.Activity)
	if err != nil {
		log.Printf("webbridge: capture receiver: %v", err)
	} else {
		a.receiver = receiver
		log.Printf("webbridge: captures -> %s (http://%s:%d/capture)", receiver.Dir, receiver.Host, receiver.Port)
	}
	log.Printf("webbridge: toolset %s (%d tools)", a.Toolset, len(a.visible))
	runErr := server.Run(ctx, &mcp.StdioTransport{})
	a.shutdown()
	return runErr
}

func (a *App) shutdown() {
	a.close.Do(func() {
		if a.receiver != nil {
			a.receiver.Close()
		}
		a.Daemon.Shutdown(context.Background())
	})
}

func capturePort() int {
	raw := strings.TrimSpace(os.Getenv("WEBBRIDGE_CAPTURE_PORT"))
	if raw == "" {
		return defaultCapturePort
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 || value > 65535 {
		return defaultCapturePort
	}
	return value
}

func (a *App) newServer() *mcp.Server {
	server := mcp.NewServer(
		&mcp.Implementation{Name: "webbridge", Version: a.Catalog.Version},
		&mcp.ServerOptions{
			Capabilities: &mcp.ServerCapabilities{Tools: &mcp.ToolCapabilities{}},
		},
	)
	for index := range a.Catalog.Tools {
		definition := a.Catalog.Tools[index]
		server.AddTool(
			&mcp.Tool{
				Name:        definition.Name,
				Description: definition.Description,
				InputSchema: definition.InputSchema,
			},
			a.handler(definition.Name),
		)
	}
	server.AddReceivingMiddleware(a.profileMiddleware)
	return server
}

func (a *App) profileMiddleware(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
		switch method {
		case "tools/list":
			return &mcp.ListToolsResult{Tools: a.listedTools()}, nil
		case "tools/call":
			if params, ok := request.GetParams().(*mcp.CallToolParamsRaw); ok {
				if !a.visible[params.Name] {
					return &mcp.CallToolResult{
						Content: []mcp.Content{&mcp.TextContent{Text: a.hiddenToolMessage(params.Name)}},
						IsError: true,
					}, nil
				}
			}
		}
		return next(ctx, method, request)
	}
}

func (a *App) listedTools() []*mcp.Tool {
	definitions := a.Catalog.Visible(a.Toolset)
	tools := make([]*mcp.Tool, 0, len(definitions))
	for _, definition := range definitions {
		tools = append(tools, &mcp.Tool{
			Name:        definition.Name,
			Description: definition.Description,
			InputSchema: definition.InputSchema,
		})
	}
	return tools
}

func (a *App) hiddenToolMessage(name string) string {
	text := "unknown tool: " + name + "."
	if a.Toolset == "core" {
		text += fmt.Sprintf(` %q is not in the core toolset; call browser_tools to find it, then browser_call.`, name)
	}
	return text
}

func (a *App) handler(name string) mcp.ToolHandler {
	return func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		started := time.Now()
		args, err := decodeArgs(request.Params.Arguments)
		if err != nil {
			text := "Invalid arguments for " + name + ": " + err.Error() + "."
			a.Activity.Record(name, a.Session(), false, 0, text)
			return errorResult(text), nil
		}
		definition := a.Catalog.Find(name)
		invalid := catalog.Validate(definition, args)
		if len(invalid) > 0 {
			hint := ""
			if a.Toolset == "core" {
				hint = fmt.Sprintf(` Call browser_tools {tool:%q} for the schema.`, name)
			}
			text := fmt.Sprintf("Invalid arguments for %s: %s.%s", name, strings.Join(invalid, "; "), hint)
			a.Activity.Record(name, a.Session(), false, 0, text)
			return errorResult(text), nil
		}
		result, err := a.runTool(ctx, name, args)
		if err != nil {
			text := a.errorText(name, err)
			a.Activity.Record(name, a.Session(), false, time.Since(started).Milliseconds(), text)
			return errorResult(text), nil
		}
		a.Activity.Record(name, a.Session(), true, time.Since(started).Milliseconds(), "")
		content := make([]mcp.Content, 0, 2)
		if image := a.imageContent(result); image != nil {
			content = append(content, image)
		}
		content = append(content, &mcp.TextContent{Text: textResult(result)})
		return &mcp.CallToolResult{Content: content}, nil
	}
}

func decodeArgs(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]any{}, nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	if value == nil {
		return map[string]any{}, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("arguments must be an object")
	}
	return object, nil
}

func (a *App) errorText(name string, err error) string {
	message := err.Error()
	var daemonErr *daemon.Error
	if errors.As(err, &daemonErr) {
		if daemonErr.Code != "" {
			message += " [" + daemonErr.Code + "]"
		}
		if daemonErr.Code == "timeout" {
			switch name {
			case "snapshot":
				message += " The page may still be loading or the JSON tree is very large. Retry with format:\"aria\" and max_chars, " +
					"call snapshot with a ref, or wait for a selector first."
			case "read_page":
				message += " Reduce max_chars, continue with start, or wait for the page to settle first."
			}
		}
	}
	return message
}

func errorResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: text}},
		IsError: true,
	}
}

func textResult(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return prettyJSON(value)
}

func prettyJSON(value any) string {
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return fmt.Sprint(value)
	}
	return strings.TrimSuffix(builder.String(), "\n")
}

func (a *App) imageContent(result any) *mcp.ImageContent {
	object, ok := result.(map[string]any)
	if !ok {
		return nil
	}
	path, ok := object["path"].(string)
	if !ok || path == "" || !filepath.IsAbs(path) {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 6*1024*1024 {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	mimeType, _ := object["mimeType"].(string)
	if mimeType == "" {
		mimeType = "image/png"
	}
	return &mcp.ImageContent{Data: data, MIMEType: mimeType}
}

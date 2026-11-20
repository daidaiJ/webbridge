package capture

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/daidaiJ/webbridge/internal/activity"
	"github.com/daidaiJ/webbridge/internal/handoff"
)

func TestPersistMarkdownAndIndex(t *testing.T) {
	dir := t.TempDir()
	page := map[string]any{
		"url":         "https://example.com/a",
		"title":       "A & B",
		"text":        "Body",
		"chars":       4,
		"truncated":   false,
		"links":       []any{map[string]any{"text": "Docs", "href": "https://example.com/docs"}},
		"selected":    "",
		"description": "desc",
	}
	result, err := Persist(page, dir, nil, "session", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if result["truncated"] != false {
		t.Fatalf("truncated = %v", result["truncated"])
	}
	markdownPath := result["path"].(string)
	markdown, err := os.ReadFile(markdownPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(markdown)
	for _, expected := range []string{"---\n", `url: "https://example.com/a"`, `title: "A & B"`, "# A & B", "Body", "## Links", "- [Docs](https://example.com/docs)"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("markdown missing %q:\n%s", expected, text)
		}
	}
	if strings.Contains(text, "selection: true") {
		t.Fatal("empty selection should not add frontmatter")
	}
	index, err := os.ReadFile(filepath.Join(dir, "index.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var line map[string]any
	if err := json.Unmarshal(index, &line); err != nil {
		t.Fatal(err)
	}
	tags, ok := line["tags"].([]any)
	if !ok || len(tags) != 0 {
		t.Fatalf("tags = %#v", line["tags"])
	}
	if line["session"] != "session" {
		t.Fatalf("session = %v", line["session"])
	}
}

func TestPersistSelection(t *testing.T) {
	dir := t.TempDir()
	page := map[string]any{
		"url":      "https://example.com",
		"title":    "Page",
		"text":     "Body",
		"selected": "quoted text",
	}
	result, err := Persist(page, dir, []string{"tag"}, "s", "", "")
	if err != nil {
		t.Fatal(err)
	}
	markdown, err := os.ReadFile(result["path"].(string))
	if err != nil {
		t.Fatal(err)
	}
	text := string(markdown)
	if !strings.Contains(text, "selection: true") || !strings.Contains(text, "> Selected text\n\nquoted text") {
		t.Fatalf("selection missing:\n%s", text)
	}
	if !strings.Contains(text, `tags: ["tag"]`) {
		t.Fatalf("tags missing:\n%s", text)
	}
}

func TestCurrentTab(t *testing.T) {
	dir := t.TempDir()
	call := func(_ context.Context, action string, args map[string]any, session string, timeout time.Duration) (any, error) {
		if action != "evaluate" {
			t.Fatalf("unexpected action %s", action)
		}
		code, _ := args["code"].(string)
		if !strings.Contains(code, "5000") {
			t.Fatalf("code did not carry max_chars: %s", code)
		}
		return map[string]any{"value": map[string]any{
			"url":   "https://example.com",
			"title": "Page",
			"text":  "Body",
			"chars": 4,
		}}, nil
	}
	result, err := CurrentTab(context.Background(), map[string]any{"max_chars": 5000, "dir": dir}, "s", call, "function(){return {}}")
	if err != nil {
		t.Fatal(err)
	}
	if result["chars"] != 4 || result["title"] != "Page" {
		t.Fatalf("result = %v", result)
	}
	if _, err := os.Stat(result["path"].(string)); err != nil {
		t.Fatal(err)
	}
}

func TestReceiverEndpoints(t *testing.T) {
	handoffs := handoff.New()
	receiver, err := Start("127.0.0.1", 0, t.TempDir(), handoffs, activity.New())
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	base := "http://127.0.0.1:" + strconv.Itoa(receiver.Port)

	health, err := http.Get(base + "/health")
	if err != nil {
		t.Fatal(err)
	}
	healthBody, _ := io.ReadAll(health.Body)
	_ = health.Body.Close()
	if !strings.Contains(string(healthBody), `"ok":true`) {
		t.Fatalf("health = %s", healthBody)
	}

	body := `{"page":{"url":"https://example.com","title":"Page","text":"Body"},"tags":["t"],"session":"s"}`
	captured, err := http.Post(base+"/capture", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	captureBody, _ := io.ReadAll(captured.Body)
	_ = captured.Body.Close()
	if captured.StatusCode != http.StatusOK || !strings.Contains(string(captureBody), `"ok":true`) {
		t.Fatalf("capture = %d %s", captured.StatusCode, captureBody)
	}
}

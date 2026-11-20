// Package capture writes agent-friendly Markdown copies of pages. The page
// itself is read by a script that the MCP server injects; this package owns the
// file naming, frontmatter, index, and localhost receiver.
package capture

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

// CallFunc is the daemon command call the capture path needs.
type CallFunc func(ctx context.Context, action string, args map[string]any, session string, timeout time.Duration) (any, error)

func Root(override string) string {
	if override != "" {
		return override
	}
	if value := strings.TrimSpace(os.Getenv("WEBBRIDGE_CAPTURE_DIR")); value != "" {
		return value
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".webbridge", "captures")
}

func slugify(title string) string {
	var builder strings.Builder
	dash := false
	for _, value := range title {
		if value < 0x20 || strings.ContainsRune(`\/:*?"<>|`, value) {
			if !dash {
				builder.WriteRune('-')
				dash = true
			}
			continue
		}
		if unicode.IsSpace(value) {
			if !dash {
				builder.WriteRune('-')
				dash = true
			}
			continue
		}
		if value == '-' {
			if !dash {
				builder.WriteRune('-')
				dash = true
			}
			continue
		}
		builder.WriteRune(value)
		dash = false
	}
	slug := strings.Trim(builder.String(), "-.")
	runes := []rune(slug)
	if len(runes) > 60 {
		runes = runes[:60]
	}
	slug = strings.Trim(string(runes), "-.")
	if slug == "" {
		return "capture"
	}
	return slug
}

func stamp(at time.Time) string {
	return at.Format("20060102-150405")
}

func jsString(value string) string {
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(builder.String(), "\n")
}

func frontmatter(page map[string]any, tags []string, screenshot string) string {
	lines := []string{"---"}
	lines = append(lines, "url: "+jsString(stringValue(page["url"])))
	if canonical := stringValue(page["canonical"]); canonical != "" && canonical != stringValue(page["url"]) {
		lines = append(lines, "canonical: "+jsString(canonical))
	}
	lines = append(lines, "title: "+jsString(stringValue(page["title"])))
	lines = append(lines, "captured_at: "+time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	if lang := stringValue(page["lang"]); lang != "" {
		lines = append(lines, "lang: "+jsString(lang))
	}
	if description := stringValue(page["description"]); description != "" {
		lines = append(lines, "description: "+jsString(description))
	}
	if truthy(page["selected"]) {
		lines = append(lines, "selection: true")
	}
	if source := stringValue(page["source"]); source != "" {
		lines = append(lines, "source: "+jsString(source))
	}
	if len(tags) > 0 {
		encoded := make([]string, 0, len(tags))
		for _, tag := range tags {
			encoded = append(encoded, jsString(tag))
		}
		lines = append(lines, "tags: ["+strings.Join(encoded, ", ")+"]")
	}
	if screenshot != "" {
		lines = append(lines, "screenshot: "+jsString(screenshot))
	}
	lines = append(lines, "---", "")
	return strings.Join(lines, "\n")
}

func toMarkdown(page map[string]any, tags []string, screenshot string) string {
	parts := []string{frontmatter(page, tags, screenshot)}
	title := stringValue(page["title"])
	if title == "" {
		title = stringValue(page["url"])
	}
	if title == "" {
		title = "Captured page"
	}
	parts = append(parts, "# "+title, "")
	if truthy(page["selected"]) {
		parts = append(parts, "> Selected text", "", stringValue(page["selected"]), "")
	}
	parts = append(parts, stringValue(page["text"]), "")
	if links, ok := page["links"].([]any); ok && len(links) > 0 {
		parts = append(parts, "## Links", "")
		for _, raw := range links {
			link, _ := raw.(map[string]any)
			href := stringValue(link["href"])
			text := stringValue(link["text"])
			if text == "" {
				text = href
			}
			parts = append(parts, fmt.Sprintf("- [%s](%s)", text, href))
		}
		parts = append(parts, "")
	}
	return strings.Join(parts, "\n")
}

func uniqueBase(root, title string) string {
	base := stamp(time.Now()) + "-" + slugify(title)
	for suffix := 1; suffix < 100; suffix++ {
		name := base
		if suffix > 1 {
			name = fmt.Sprintf("%s-%d", base, suffix)
		}
		if _, err := os.Stat(filepath.Join(root, name+".md")); os.IsNotExist(err) {
			return name
		}
	}
	return fmt.Sprintf("%s-%d", base, time.Now().UnixMilli())
}

// Persist writes one Markdown file and appends its index line.
func Persist(page map[string]any, dir string, tags []string, session, screenshot, base string) (map[string]any, error) {
	root := Root(dir)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	if tags == nil {
		tags = []string{}
	}
	if base == "" {
		base = uniqueBase(root, stringValue(page["title"]))
	}
	markdownPath := filepath.Join(root, base+".md")
	markdown := toMarkdown(page, tags, screenshot)
	if err := os.WriteFile(markdownPath, []byte(markdown), 0o644); err != nil {
		return nil, err
	}
	line := map[string]any{
		"at":      time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"url":     page["url"],
		"title":   page["title"],
		"path":    markdownPath,
		"session": session,
		"tags":    tags,
	}
	if screenshot != "" {
		line["screenshot"] = screenshot
	}
	if chars, exists := page["chars"]; exists {
		line["chars"] = chars
	}
	encoded, err := encodeJSON(line)
	if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(root, "index.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	if _, err := file.WriteString(encoded + "\n"); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}

	result := map[string]any{
		"path":      markdownPath,
		"dir":       root,
		"bytes":     len([]byte(markdown)),
		"title":     page["title"],
		"url":       page["url"],
		"session":   session,
		"truncated": page["truncated"] == true,
	}
	if chars, exists := page["chars"]; exists {
		result["chars"] = chars
	}
	if screenshot != "" {
		result["screenshot"] = screenshot
	}
	return result, nil
}

func encodeJSON(value any) (string, error) {
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(builder.String(), "\n"), nil
}

// CurrentTab reads the page through one evaluate call and writes the capture.
func CurrentTab(ctx context.Context, opts map[string]any, session string, call CallFunc, pageScript string) (map[string]any, error) {
	limit := 120000
	if value, ok := numberValue(opts["max_chars"]); ok {
		limit = clamp(int(value), 1000, 400000)
	} else if value, ok := numberValue(opts["maxChars"]); ok {
		limit = clamp(int(value), 1000, 400000)
	}
	selection := stringValue(opts["selection"])
	code := fmt.Sprintf("(%s)(%d, %s)", pageScript, limit, jsString(selection))
	evaluated, err := call(ctx, "evaluate", map[string]any{"code": code}, session, 60*time.Second)
	if err != nil {
		return nil, err
	}
	page, ok := payloadValue(evaluated).(map[string]any)
	if !ok {
		return nil, fmt.Errorf("capture: unexpected page payload from the browser: %s", truncateJSON(evaluated, 200))
	}
	if _, ok := page["text"].(string); !ok {
		return nil, fmt.Errorf("capture: unexpected page payload from the browser: %s", truncateJSON(evaluated, 200))
	}

	dir := Root(stringValue(opts["dir"]))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	base := uniqueBase(dir, stringValue(page["title"]))

	screenshotName := ""
	if boolValue(opts["screenshot"]) {
		shotPath := filepath.Join(dir, base+".png")
		shot, shotErr := call(ctx, "screenshot", map[string]any{"format": "png", "path": shotPath}, session, 45*time.Second)
		if shotErr == nil {
			if object, ok := payloadValue(shot).(map[string]any); ok {
				if path := stringValue(object["path"]); path != "" {
					screenshotName = filepath.Base(path)
				}
			}
		}
	}

	tags := stringList(opts["tags"])
	return Persist(page, dir, tags, session, screenshotName, base)
}

func payloadValue(value any) any {
	if object, ok := value.(map[string]any); ok {
		if inner, exists := object["value"]; exists {
			return inner
		}
	}
	return value
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(typed)
	}
}

func numberValue(value any) (float64, bool) {
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

func boolValue(value any) bool {
	typed, ok := value.(bool)
	return ok && typed
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

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	if len(items) > 20 {
		items = items[:20]
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		values = append(values, stringValue(item))
	}
	return values
}

func clamp(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func truncateJSON(value any, limit int) string {
	encoded, err := encodeJSON(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	runes := []rune(encoded)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return encoded
}

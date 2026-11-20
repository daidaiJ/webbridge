// Package catalog loads the tool surface generated from the Node definitions.
//
// The Node file remains the source of truth. scripts/export-catalog.mjs writes
// catalog.json, and the Go server embeds it so the binary needs no runtime
// files next to it.
package catalog

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

//go:embed catalog.json
var raw []byte

// Schema is the subset of JSON Schema used by the tool definitions. Keeping
// the field set small makes the catalog easy to validate and keeps the wire
// shape identical to the Node server.
type Schema struct {
	Type                 string             `json:"type,omitempty"`
	Description          string             `json:"description,omitempty"`
	Properties           map[string]*Schema `json:"properties,omitempty"`
	Required             []string           `json:"required,omitempty"`
	Items                *Schema            `json:"items,omitempty"`
	Enum                 []any              `json:"enum,omitempty"`
	AdditionalProperties any                `json:"additionalProperties,omitempty"`
}

// MarshalJSON preserves the distinction between an absent properties field and
// an explicitly empty object, which no-argument tools need on the wire.
func (s *Schema) MarshalJSON() ([]byte, error) {
	value := map[string]any{}
	if s.Type != "" {
		value["type"] = s.Type
	}
	if s.Description != "" {
		value["description"] = s.Description
	}
	if s.Properties != nil {
		value["properties"] = s.Properties
	}
	if s.Required != nil {
		value["required"] = s.Required
	}
	if s.Items != nil {
		value["items"] = s.Items
	}
	if s.Enum != nil {
		value["enum"] = s.Enum
	}
	if s.AdditionalProperties != nil {
		value["additionalProperties"] = s.AdditionalProperties
	}
	return json.Marshal(value)
}

type Example struct {
	Tool string         `json:"tool"`
	Args map[string]any `json:"args"`
}

type Definition struct {
	Name        string    `json:"name"`
	Description string    `json:"description"`
	InputSchema *Schema   `json:"inputSchema"`
	TimeoutMs   int       `json:"timeoutMs,omitempty"`
	Core        bool      `json:"core"`
	Group       string    `json:"group"`
	Summary     string    `json:"summary"`
	Signature   string    `json:"signature"`
	Example     *Example  `json:"example,omitempty"`
	Related     *[]string `json:"related,omitempty"`
}

type Group struct {
	Name  string   `json:"name"`
	About string   `json:"about"`
	Tools []string `json:"tools"`
}

type Catalog struct {
	Version  string       `json:"version"`
	Core     []string     `json:"core"`
	Workflow []string     `json:"workflow"`
	Hint     string       `json:"hint"`
	Groups   []Group      `json:"groups"`
	Tools    []Definition `json:"tools"`

	byName  map[string]*Definition
	coreSet map[string]bool
}

var metaNames = map[string]bool{
	"browser_tools": true,
	"browser_call":  true,
}

// Load parses the embedded catalog once and indexes it.
func Load() (*Catalog, error) {
	var value Catalog
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("load tool catalog: %w", err)
	}
	value.byName = make(map[string]*Definition, len(value.Tools))
	value.coreSet = make(map[string]bool, len(value.Core))
	for index := range value.Tools {
		tool := &value.Tools[index]
		if tool.Name == "" {
			return nil, fmt.Errorf("load tool catalog: tool %d has no name", index)
		}
		if _, exists := value.byName[tool.Name]; exists {
			return nil, fmt.Errorf("load tool catalog: duplicate tool %q", tool.Name)
		}
		if tool.InputSchema == nil || tool.InputSchema.Type != "object" {
			return nil, fmt.Errorf("load tool catalog: %s inputSchema must be an object", tool.Name)
		}
		value.byName[tool.Name] = tool
	}
	for _, name := range value.Core {
		if _, exists := value.byName[name]; !exists {
			return nil, fmt.Errorf("load tool catalog: core tool %q is not defined", name)
		}
		value.coreSet[name] = true
	}
	return &value, nil
}

func (c *Catalog) Find(name string) *Definition {
	return c.byName[name]
}

func (c *Catalog) IsMeta(name string) bool {
	return metaNames[name]
}

// CoreTools returns the workflow-ordered core list, including the two catalog
// meta tools. This is the list the core toolset advertises.
func (c *Catalog) CoreTools() []Definition {
	tools := make([]Definition, 0, len(c.Core))
	for _, name := range c.Core {
		tools = append(tools, *c.byName[name])
	}
	return tools
}

// DirectTools returns the 40 tools the full profile advertises. The meta tools
// are the discovery layer for the core profile, so the full profile omits them.
func (c *Catalog) DirectTools() []Definition {
	tools := make([]Definition, 0, len(c.Tools))
	for _, tool := range c.Tools {
		if c.IsMeta(tool.Name) {
			continue
		}
		tools = append(tools, tool)
	}
	return tools
}

func (c *Catalog) Visible(toolset string) []Definition {
	if toolset == "full" {
		return c.DirectTools()
	}
	return c.CoreTools()
}

func (c *Catalog) IsCore(name string) bool {
	return c.coreSet[name] && !c.IsMeta(name)
}

func (c *Catalog) groupOf(name string) *Group {
	for index := range c.Groups {
		for _, tool := range c.Groups[index].Tools {
			if tool == name {
				return &c.Groups[index]
			}
		}
	}
	return nil
}

// Overview is the no-argument browser_tools response.
func (c *Catalog) Overview() map[string]any {
	groups := make([]map[string]any, 0, len(c.Groups))
	for _, group := range c.Groups {
		groups = append(groups, map[string]any{
			"name":  group.Name,
			"about": group.About,
			"tools": group.Tools,
		})
	}
	return map[string]any{
		"workflow": c.Workflow,
		"groups":   groups,
		"hint":     c.Hint,
	}
}

// Search mirrors src/catalog.mjs searchTools: exact, prefix, substring, then
// summary, description, and group matches, capped at ten results.
func (c *Catalog) Search(query string) map[string]any {
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return c.Overview()
	}
	type match struct {
		tool  *Definition
		core  bool
		score int
	}
	var matches []match
	for index := range c.Tools {
		tool := &c.Tools[index]
		if c.IsMeta(tool.Name) {
			continue
		}
		name := strings.ToLower(tool.Name)
		summary := strings.ToLower(tool.Summary)
		description := strings.ToLower(tool.Description)
		score := 0
		switch {
		case name == needle:
			score = 100
		case strings.HasPrefix(name, needle):
			score = 80
		case strings.Contains(name, needle):
			score = 60
		case strings.Contains(summary, needle):
			score = 40
		case strings.Contains(description, needle):
			score = 25
		default:
			if group := c.groupOf(tool.Name); group != nil && strings.Contains(group.Name, needle) {
				score = 20
			}
		}
		if score > 0 {
			matches = append(matches, match{tool: tool, core: c.IsCore(tool.Name), score: score})
		}
	}
	sort.SliceStable(matches, func(left, right int) bool {
		if matches[left].score != matches[right].score {
			return matches[left].score > matches[right].score
		}
		return matches[left].tool.Name < matches[right].tool.Name
	})
	if len(matches) > 10 {
		matches = matches[:10]
	}
	results := make([]map[string]any, 0, len(matches))
	hasCore := false
	hasLongTail := false
	for _, item := range matches {
		if item.core {
			hasCore = true
		} else {
			hasLongTail = true
		}
		entry := map[string]any{
			"name":      item.tool.Name,
			"core":      item.core,
			"summary":   item.tool.Summary,
			"signature": item.tool.Signature,
		}
		if item.core {
			entry["group"] = "core"
		} else if group := c.groupOf(item.tool.Name); group != nil {
			entry["group"] = group.Name
		}
		results = append(results, entry)
	}
	hint := "No match. Try a broader word, or call browser_tools with no arguments for the groups."
	if len(matches) > 0 {
		parts := make([]string, 0, 2)
		if hasCore {
			parts = append(parts, "Core results are listed directly; call them without browser_call.")
		}
		if hasLongTail {
			parts = append(parts, "For long-tail results, browser_tools {tool:\"name\"} then browser_call {tool, args}.")
		}
		hint = strings.Join(parts, " ")
	}
	return map[string]any{
		"query":   query,
		"matches": results,
		"hint":    hint,
	}
}

// Describe mirrors describeTool. Unknown names return nil.
func (c *Catalog) Describe(name string) map[string]any {
	tool := c.byName[name]
	if tool == nil {
		return nil
	}
	value := map[string]any{
		"name":        name,
		"summary":     tool.Summary,
		"signature":   tool.Signature,
		"description": tool.Description,
		"inputSchema": tool.InputSchema,
	}
	if group := c.groupOf(name); group != nil {
		value["group"] = group.Name
	}
	if tool.Example != nil {
		value["example"] = tool.Example
	}
	if tool.Related != nil {
		value["related"] = *tool.Related
	}
	if c.IsCore(name) {
		value["note"] = "This is a core tool; call it directly, without browser_call."
	}
	return value
}

// UnknownToolMessage mirrors unknownToolMessage, including the closest-name
// suggestion.
func (c *Catalog) UnknownToolMessage(name string) string {
	candidates := make([]string, 0, len(c.Tools))
	for _, tool := range c.Tools {
		if c.IsMeta(tool.Name) {
			continue
		}
		candidates = append(candidates, tool.Name)
	}
	suggestion := closestName(name, candidates)
	text := fmt.Sprintf("unknown tool %q.", name)
	if suggestion != "" {
		text += fmt.Sprintf(" Did you mean %q?", suggestion)
	}
	return text + " Call browser_tools with no arguments for the groups."
}

// Validate mirrors validateArgs: required fields, unknown properties, enums,
// primitives, arrays, and nested objects.
func Validate(tool *Definition, args map[string]any) []string {
	if tool == nil {
		return []string{"unknown tool"}
	}
	var errors []string
	checkObject("", args, tool.InputSchema, &errors)
	return errors
}

func checkObject(path string, value map[string]any, schema *Schema, errors *[]string) {
	properties := schema.Properties
	if properties == nil {
		properties = map[string]*Schema{}
	}
	for _, key := range schema.Required {
		if _, exists := value[key]; !exists {
			*errors = append(*errors, fmt.Sprintf("%s is required", join(path, key)))
		}
	}
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		child := properties[key]
		if child == nil {
			if schema.AdditionalProperties == true {
				continue
			}
			suggestion := closestName(key, mapKeys(properties))
			message := fmt.Sprintf("unknown argument %q", join(path, key))
			if suggestion != "" {
				message += fmt.Sprintf(" (did you mean %q?)", suggestion)
			}
			*errors = append(*errors, message)
			continue
		}
		checkValue(join(path, key), value[key], child, errors)
	}
}

func checkValue(path string, value any, schema *Schema, errors *[]string) {
	if value == nil {
		return
	}
	if len(schema.Enum) > 0 {
		matched := false
		for _, candidate := range schema.Enum {
			if equalJSON(candidate, value) {
				matched = true
				break
			}
		}
		if !matched {
			labels := make([]string, 0, len(schema.Enum))
			for _, candidate := range schema.Enum {
				encoded, _ := json.Marshal(candidate)
				labels = append(labels, string(encoded))
			}
			*errors = append(*errors, fmt.Sprintf("%s must be one of %s", path, strings.Join(labels, ", ")))
			return
		}
	}
	switch schema.Type {
	case "string":
		if _, ok := value.(string); !ok {
			*errors = append(*errors, fmt.Sprintf("%s must be a string", path))
		}
	case "number":
		switch value.(type) {
		case float64, float32, int, int32, int64, json.Number:
		default:
			*errors = append(*errors, fmt.Sprintf("%s must be a number", path))
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			*errors = append(*errors, fmt.Sprintf("%s must be a boolean", path))
		}
	case "array":
		items, ok := value.([]any)
		if !ok {
			*errors = append(*errors, fmt.Sprintf("%s must be an array", path))
			return
		}
		for index, item := range items {
			checkValue(fmt.Sprintf("%s[%d]", path, index), item, schema.Items, errors)
		}
	case "object":
		object, ok := value.(map[string]any)
		if !ok {
			*errors = append(*errors, fmt.Sprintf("%s must be an object", path))
			return
		}
		checkObject(path, object, schema, errors)
	default:
		if schema.Properties != nil {
			object, ok := value.(map[string]any)
			if !ok {
				*errors = append(*errors, fmt.Sprintf("%s must be an object", path))
				return
			}
			checkObject(path, object, schema, errors)
		}
	}
}

func equalJSON(left, right any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func mapKeys(value map[string]*Schema) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	return keys
}

func closestName(name string, candidates []string) string {
	needle := strings.ToLower(name)
	best := ""
	bestDistance := int(^uint(0) >> 1)
	for _, candidate := range candidates {
		distance := editDistance(needle, strings.ToLower(candidate))
		if distance < bestDistance {
			bestDistance = distance
			best = candidate
		}
	}
	limit := 2
	if len(needle) <= 4 {
		limit = 1
	}
	if best != "" && bestDistance <= limit {
		return best
	}
	return ""
}

func editDistance(left, right string) int {
	if left == right {
		return 0
	}
	leftRunes := []rune(left)
	rightRunes := []rune(right)
	if len(leftRunes) == 0 {
		return len(rightRunes)
	}
	if len(rightRunes) == 0 {
		return len(leftRunes)
	}
	previous := make([]int, len(rightRunes)+1)
	for index := range previous {
		previous[index] = index
	}
	for i := 1; i <= len(leftRunes); i++ {
		current := make([]int, len(rightRunes)+1)
		current[0] = i
		for j := 1; j <= len(rightRunes); j++ {
			cost := 1
			if leftRunes[i-1] == rightRunes[j-1] {
				cost = 0
			}
			current[j] = min3(current[j-1]+1, previous[j]+1, previous[j-1]+cost)
		}
		previous = current
	}
	return previous[len(rightRunes)]
}

func min3(a, b, c int) int {
	if a < b {
		if a < c {
			return a
		}
		return c
	}
	if b < c {
		return b
	}
	return c
}

package catalog

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCatalogShape(t *testing.T) {
	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Tools) != 42 {
		t.Fatalf("tools = %d, want 42", len(loaded.Tools))
	}
	if len(loaded.Core) != 13 {
		t.Fatalf("core = %d, want 13", len(loaded.Core))
	}
	if len(loaded.CoreTools()) != 13 {
		t.Fatalf("core list = %d, want 13", len(loaded.CoreTools()))
	}
	if len(loaded.DirectTools()) != 40 {
		t.Fatalf("direct list = %d, want 40", len(loaded.DirectTools()))
	}
	if loaded.Version == "" {
		t.Fatal("version is empty")
	}
}

func TestSchemaKeepsEmptyProperties(t *testing.T) {
	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"close_session", "list_tabs", "list_browser_tabs"} {
		tool := loaded.Find(name)
		if tool == nil {
			t.Fatalf("missing %s", name)
		}
		encoded, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(encoded), `"properties":{}`) {
			t.Fatalf("%s schema lost empty properties: %s", name, encoded)
		}
	}
}

func TestValidate(t *testing.T) {
	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	click := loaded.Find("click")
	if errors := Validate(click, map[string]any{"selector": "@e1"}); len(errors) != 0 {
		t.Fatalf("valid click rejected: %v", errors)
	}
	errors := Validate(click, map[string]any{})
	if len(errors) != 1 || !strings.Contains(errors[0], "selector is required") {
		t.Fatalf("missing selector = %v", errors)
	}
	errors = Validate(click, map[string]any{"selctor": "#x"})
	if len(errors) != 2 || !strings.Contains(strings.Join(errors, " "), `did you mean "selector"`) {
		t.Fatalf("typo = %v", errors)
	}
	history := loaded.Find("history")
	errors = Validate(history, map[string]any{"action": "sideways"})
	if len(errors) == 0 || !strings.Contains(errors[0], "must be one of") {
		t.Fatalf("enum = %v", errors)
	}
	extract := loaded.Find("extract")
	errors = Validate(extract, map[string]any{
		"selector": "#rows",
		"fields":   []any{map[string]any{"selector": ".name"}},
	})
	if len(errors) == 0 || !strings.Contains(errors[0], "fields[0].name is required") {
		t.Fatalf("nested required = %v", errors)
	}
}

func TestDescribeAndSearch(t *testing.T) {
	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	described := loaded.Describe("extract")
	if described == nil || described["example"] == nil {
		t.Fatal("extract should have an example")
	}
	if _, ok := described["note"]; ok {
		t.Fatal("extract is not a core tool")
	}
	click := loaded.Describe("click")
	if click == nil || !strings.Contains(click["note"].(string), "core tool") {
		t.Fatal("click should describe itself as core")
	}
	found := loaded.Search("extract")
	matches := found["matches"].([]map[string]any)
	if len(matches) == 0 || matches[0]["name"] != "extract" {
		t.Fatalf("search = %v", found)
	}
	overview := loaded.Overview()
	if len(overview["workflow"].([]string)) != 8 {
		t.Fatalf("workflow = %v", overview["workflow"])
	}
}

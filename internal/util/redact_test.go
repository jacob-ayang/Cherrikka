package util

import "testing"

func TestRedactAny(t *testing.T) {
	in := map[string]any{
		"apiKey": "abc",
		"nested": map[string]any{
			"token":     "t1",
			"safeField": "ok",
		},
		"list": []any{map[string]any{"password": "p"}},
	}
	out := RedactAny(in).(map[string]any)
	if out["apiKey"] != "***REDACTED***" {
		t.Fatalf("apiKey should be redacted")
	}
	nested := out["nested"].(map[string]any)
	if nested["token"] != "***REDACTED***" {
		t.Fatalf("nested token should be redacted")
	}
	if nested["safeField"] != "ok" {
		t.Fatalf("safe field should be unchanged")
	}
}

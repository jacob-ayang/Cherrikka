package mapping

import (
	"testing"

	"cherrikka/internal/ir"
)

func TestNormalizeFromCherryConfig(t *testing.T) {
	cfg := map[string]any{
		"cherry.persistSlices": map[string]any{
			"assistants": map[string]any{
				"assistants": []any{
					map[string]any{
						"id":     "a1",
						"name":   "Assistant",
						"prompt": "hello",
						"model":  map[string]any{"id": "m1"},
						"settings": map[string]any{
							"temperature": 0.8,
						},
					},
				},
			},
			"settings": map[string]any{
				"webdavHost": "https://dav.example.com",
				"webdavUser": "u",
				"webdavPass": "p",
			},
			"llm": map[string]any{
				"defaultModel": map[string]any{"id": "m1"},
				"providers": []any{
					map[string]any{"id": "p1", "type": "openai"},
					map[string]any{"id": "p2", "type": "anthropic"},
					map[string]any{"id": "p3", "type": "unknown-provider"},
				},
			},
		},
	}

	norm, warnings := NormalizeFromCherryConfig(cfg)
	if len(asSlice(norm["core.providers"])) != 3 {
		t.Fatalf("expected 3 normalized providers")
	}
	if len(asSlice(norm["core.assistants"])) != 1 {
		t.Fatalf("expected 1 normalized assistant")
	}
	webdav := asMap(norm["sync.webdav"])
	if webdav["webdavHost"] != "https://dav.example.com" {
		t.Fatalf("unexpected webdav host: %v", webdav["webdavHost"])
	}
	if len(warnings) == 0 {
		t.Fatalf("expected warning for unsupported provider")
	}
}

func TestBuildRikkaSettingsFromIR(t *testing.T) {
	cfg := map[string]any{
		"cherry.persistSlices": map[string]any{
			"assistants": map[string]any{
				"assistants": []any{
					map[string]any{"id": "a1", "name": "A1", "prompt": "p", "model": map[string]any{"id": "m1"}},
				},
			},
			"settings": map[string]any{
				"webdavHost": "https://dav.example.com",
				"webdavUser": "u",
				"webdavPass": "p",
				"webdavPath": "/x",
			},
			"llm": map[string]any{
				"providers": []any{
					map[string]any{"id": "p1", "type": "openai", "models": []any{map[string]any{"id": "m1"}}},
					map[string]any{"id": "p2", "type": "anthropic"},
				},
			},
		},
	}
	norm, _ := NormalizeFromCherryConfig(cfg)
	in := &ir.BackupIR{
		SourceFormat: "cherry",
		Settings:     norm,
		Config:       cfg,
	}

	settings, _ := BuildRikkaSettingsFromIR(in, nil)
	providers := asSlice(settings["providers"])
	if len(providers) != 2 {
		t.Fatalf("expected 2 mapped rikka providers, got=%d", len(providers))
	}
	p1 := asMap(providers[0])
	if p1["type"] != "openai" {
		t.Fatalf("expected first provider type openai, got=%v", p1["type"])
	}
	webdav := asMap(settings["webDavConfig"])
	if webdav["url"] != "https://dav.example.com" {
		t.Fatalf("expected mapped webdav url")
	}
	if asMap(settings)["assistantId"] == nil {
		t.Fatalf("assistantId should be set")
	}
}

func TestBuildRikkaSettingsFromIR_AssistantMissingModelFallsBack(t *testing.T) {
	cfg := map[string]any{
		"cherry.persistSlices": map[string]any{
			"assistants": map[string]any{
				"assistants": []any{
					map[string]any{"id": "a1", "name": "A1", "prompt": "p"},
				},
			},
			"llm": map[string]any{
				"defaultModel": map[string]any{"id": "m1"},
				"providers": []any{
					map[string]any{"id": "p1", "type": "openai", "models": []any{map[string]any{"id": "m1"}}},
				},
			},
		},
	}

	norm, _ := NormalizeFromCherryConfig(cfg)
	in := &ir.BackupIR{
		SourceFormat: "cherry",
		Settings:     norm,
		Config:       cfg,
	}

	settings, _ := BuildRikkaSettingsFromIR(in, nil)
	assistants := asSlice(settings["assistants"])
	if len(assistants) == 0 {
		t.Fatalf("expected mapped assistant")
	}
	firstAssistant := asMap(assistants[0])
	assistantModelID := str(firstAssistant["chatModelId"])
	if assistantModelID == "" {
		t.Fatalf("expected assistant chatModelId fallback")
	}
	if !isValidUUID(assistantModelID) {
		t.Fatalf("expected assistant chatModelId to be uuid, got=%s", assistantModelID)
	}
	if assistantModelID != str(settings["chatModelId"]) {
		t.Fatalf("assistant chatModelId should match selected chatModelId")
	}
}

func TestBuildRikkaSettingsFromIR_DropInvalidAssistantUUIDCollections(t *testing.T) {
	cfg := map[string]any{
		"cherry.persistSlices": map[string]any{
			"assistants": map[string]any{
				"assistants": []any{
					map[string]any{
						"id":     "a1",
						"name":   "A1",
						"prompt": "p",
						"model":  map[string]any{"id": "m1"},
						"mcpServers": []any{
							map[string]any{"id": "not-uuid"},
						},
					},
				},
			},
			"llm": map[string]any{
				"defaultModel": map[string]any{"id": "m1"},
				"providers": []any{
					map[string]any{"id": "p1", "type": "openai", "models": []any{map[string]any{"id": "m1"}}},
				},
			},
		},
	}

	norm, _ := NormalizeFromCherryConfig(cfg)
	in := &ir.BackupIR{
		SourceFormat: "cherry",
		Settings:     norm,
		Config:       cfg,
	}
	settings, warnings := BuildRikkaSettingsFromIR(in, nil)
	assistants := asSlice(settings["assistants"])
	if len(assistants) == 0 {
		t.Fatalf("expected mapped assistant")
	}
	first := asMap(assistants[0])
	if _, exists := first["mcpServers"]; exists {
		t.Fatalf("expected invalid assistant mcpServers to be dropped")
	}
	foundWarning := false
	for _, w := range warnings {
		if w == "dropped non-uuid assistant field: mcpServers" {
			foundWarning = true
			break
		}
	}
	if !foundWarning {
		t.Fatalf("expected warning for dropped assistant mcpServers, got=%v", warnings)
	}
}

func TestBuildCherryPersistSlicesFromIR(t *testing.T) {
	cfg := map[string]any{
		"rikka.settings": map[string]any{
			"providers": []any{
				map[string]any{"id": "rp1", "type": "google", "models": []any{map[string]any{"id": "gm1"}}},
			},
			"assistants": []any{
				map[string]any{"id": "ra1", "name": "R1", "systemPrompt": "S", "chatModelId": "gm1"},
			},
			"assistantId": "ra1",
			"webDavConfig": map[string]any{
				"url":      "https://dav.rikka",
				"username": "u",
				"password": "p",
				"path":     "/backup",
			},
			"s3Config": map[string]any{
				"endpoint": "https://s3.example.com",
				"bucket":   "bk",
			},
		},
	}
	norm, _ := NormalizeFromRikkaConfig(cfg)
	in := &ir.BackupIR{
		SourceFormat: "rikka",
		Settings:     norm,
		Config:       cfg,
	}
	assistantsSlice := map[string]any{
		"defaultAssistant": map[string]any{"id": "default"},
		"assistants":       []any{},
	}
	persist, _ := BuildCherryPersistSlicesFromIR(in, map[string]any{}, assistantsSlice)

	llm := asMap(persist["llm"])
	providers := asSlice(llm["providers"])
	if len(providers) != 1 {
		t.Fatalf("expected 1 mapped cherry provider")
	}
	p := asMap(providers[0])
	if p["type"] != "gemini" {
		t.Fatalf("expected rikka google -> cherry gemini, got=%v", p["type"])
	}

	settings := asMap(persist["settings"])
	if settings["webdavHost"] != "https://dav.rikka" {
		t.Fatalf("expected mapped webdavHost, got=%v", settings["webdavHost"])
	}
}

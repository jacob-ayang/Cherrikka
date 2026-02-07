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

func TestBuildRikkaSettingsFromIR_AssistantNameConflictRenamed(t *testing.T) {
	cfg := map[string]any{
		"cherry.persistSlices": map[string]any{
			"assistants": map[string]any{
				"assistants": []any{
					map[string]any{"id": "a1", "name": "默认助手", "prompt": "p", "model": map[string]any{"id": "m1"}},
					map[string]any{"id": "a2", "name": "默认助手", "prompt": "p2", "model": map[string]any{"id": "m1"}},
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
	if len(assistants) != 2 {
		t.Fatalf("expected 2 mapped assistants")
	}
	a1 := asMap(assistants[0])
	a2 := asMap(assistants[1])
	if str(a1["name"]) != "默认助手" {
		t.Fatalf("expected first assistant keep name, got=%v", a1["name"])
	}
	if str(a2["name"]) != "默认助手 (2)" {
		t.Fatalf("expected second assistant renamed, got=%v", a2["name"])
	}
	found := false
	for _, w := range warnings {
		if w == "assistant name conflict renamed: 默认助手 -> 默认助手 (2)" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected rename warning, got=%v", warnings)
	}
}

func TestBuildRikkaSettingsFromIR_NormalizeInvalidModelType(t *testing.T) {
	cfg := map[string]any{
		"cherry.persistSlices": map[string]any{
			"assistants": map[string]any{
				"assistants": []any{
					map[string]any{"id": "a1", "name": "A1", "prompt": "p", "model": map[string]any{"id": "m1"}},
				},
			},
			"llm": map[string]any{
				"defaultModel": map[string]any{"id": "m1"},
				"providers": []any{
					map[string]any{
						"id":   "p1",
						"type": "openai",
						"models": []any{
							map[string]any{"id": "m1", "type": "invalid-type"},
						},
					},
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
	providers := asSlice(settings["providers"])
	if len(providers) != 1 {
		t.Fatalf("expected 1 provider")
	}
	models := asSlice(asMap(providers[0])["models"])
	if len(models) != 1 {
		t.Fatalf("expected 1 model")
	}
	modelType := str(asMap(models[0])["type"])
	if modelType != "CHAT" {
		t.Fatalf("expected model type CHAT, got=%v", modelType)
	}
	found := false
	for _, w := range warnings {
		if w == "normalized unsupported model type to CHAT: invalid-type" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected normalization warning, got=%v", warnings)
	}
}

func TestBuildRikkaSettingsFromIR_AssistantStringNumbersCoerced(t *testing.T) {
	cfg := map[string]any{
		"cherry.persistSlices": map[string]any{
			"assistants": map[string]any{
				"assistants": []any{
					map[string]any{
						"id":     "a1",
						"name":   "A1",
						"prompt": "p",
						"model":  map[string]any{"id": "m1"},
						"settings": map[string]any{
							"temperature":  "0.7",
							"topP":         "0.8",
							"contextCount": "16",
							"streamOutput": "true",
							"maxTokens":    "1024",
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
	settings, _ := BuildRikkaSettingsFromIR(in, nil)
	assistants := asSlice(settings["assistants"])
	if len(assistants) != 1 {
		t.Fatalf("expected 1 assistant")
	}
	a := asMap(assistants[0])
	if _, ok := a["temperature"].(float64); !ok {
		t.Fatalf("expected temperature to be float64, got=%T", a["temperature"])
	}
	if _, ok := a["topP"].(float64); !ok {
		t.Fatalf("expected topP to be float64, got=%T", a["topP"])
	}
	if _, ok := a["contextMessageSize"].(int64); !ok {
		t.Fatalf("expected contextMessageSize to be int64, got=%T", a["contextMessageSize"])
	}
	if stream, ok := a["streamOutput"].(bool); !ok || !stream {
		t.Fatalf("expected streamOutput bool true, got=%v (%T)", a["streamOutput"], a["streamOutput"])
	}
	if _, ok := a["maxTokens"].(int64); !ok {
		t.Fatalf("expected maxTokens to be int64, got=%T", a["maxTokens"])
	}
}

func TestBuildRikkaSettingsFromIR_AssistantZeroMaxTokensDropped(t *testing.T) {
	cfg := map[string]any{
		"cherry.persistSlices": map[string]any{
			"assistants": map[string]any{
				"assistants": []any{
					map[string]any{
						"id":     "a1",
						"name":   "A1",
						"prompt": "p",
						"model":  map[string]any{"id": "m1"},
						"settings": map[string]any{
							"contextCount": "16",
							"streamOutput": "true",
							"maxTokens":    "0",
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
	settings, _ := BuildRikkaSettingsFromIR(in, nil)
	assistants := asSlice(settings["assistants"])
	if len(assistants) != 1 {
		t.Fatalf("expected 1 assistant")
	}
	a := asMap(assistants[0])
	if _, ok := a["maxTokens"]; ok {
		t.Fatalf("expected maxTokens dropped when value <= 0, got=%v", a["maxTokens"])
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

func TestBuildCherryPersistSlicesFromIR_RikkaModelToCherryModelShape(t *testing.T) {
	cfg := map[string]any{
		"rikka.settings": map[string]any{
			"providers": []any{
				map[string]any{
					"id":   "rp-openai",
					"type": "openai",
					"models": []any{
						map[string]any{
							"id":          "7fd8fb8e-b469-4dbc-8daa-40b2ac73b8e8",
							"modelId":     "gpt-4o-mini",
							"displayName": "GPT-4o Mini",
							"type":        "CHAT",
						},
					},
				},
			},
			"assistants": []any{
				map[string]any{
					"id":          "ra1",
					"name":        "R1",
					"systemPrompt": "S",
					"chatModelId": "7fd8fb8e-b469-4dbc-8daa-40b2ac73b8e8",
				},
			},
			"assistantId":  "ra1",
			"chatModelId":  "7fd8fb8e-b469-4dbc-8daa-40b2ac73b8e8",
			"titleModelId": "7fd8fb8e-b469-4dbc-8daa-40b2ac73b8e8",
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

	persist, warnings := BuildCherryPersistSlicesFromIR(in, map[string]any{}, assistantsSlice)
	_ = warnings
	llm := asMap(persist["llm"])
	providers := asSlice(llm["providers"])
	if len(providers) != 1 {
		t.Fatalf("expected 1 provider, got=%d", len(providers))
	}
	models := asSlice(asMap(providers[0])["models"])
	if len(models) != 1 {
		t.Fatalf("expected 1 model, got=%d", len(models))
	}
	model := asMap(models[0])
	if got := pickFirstString(model["id"]); got != "gpt-4o-mini" {
		t.Fatalf("expected cherry model id from rikka modelId, got=%s", got)
	}
	if got := pickFirstString(model["provider"]); got != "rp-openai" {
		t.Fatalf("expected cherry model provider=rp-openai, got=%s", got)
	}
	defaultModel := asMap(llm["defaultModel"])
	if got := pickFirstString(defaultModel["id"]); got != "gpt-4o-mini" {
		t.Fatalf("expected defaultModel id=gpt-4o-mini, got=%s", got)
	}
}

func TestBuildRikkaSettingsFromIR_SidecarRehydrateOverlay(t *testing.T) {
	in := &ir.BackupIR{
		SourceFormat: "cherry",
		Settings: map[string]any{
			"core.providers": []any{},
			"core.assistants": []any{},
		},
		Config: map[string]any{
			"rehydrate.rikka.settings": map[string]any{
				"modeInjections": []any{
					map[string]any{"id": "mi-1", "name": "Mode 1"},
				},
				"providers": []any{
					map[string]any{
						"id":      "bbca173f-f4d7-4db0-b4cf-9c9d5756eb03",
						"type":    "openai",
						"name":    "OpenAI",
						"enabled": true,
						"models": []any{
							map[string]any{
								"id":          "d8f480f2-2982-4d86-a67f-31e7d6f44d40",
								"modelId":     "gpt-4o-mini",
								"displayName": "GPT-4o Mini",
								"type":        "CHAT",
							},
						},
					},
				},
				"assistants": []any{
					map[string]any{
						"id":          "6f518bcc-f22f-4429-88e2-06995ba13653",
						"name":        "A1",
						"chatModelId": "d8f480f2-2982-4d86-a67f-31e7d6f44d40",
					},
				},
				"assistantId": "6f518bcc-f22f-4429-88e2-06995ba13653",
			},
		},
	}

	settings, warnings := BuildRikkaSettingsFromIR(in, map[string]any{})
	if _, ok := settings["modeInjections"]; !ok {
		t.Fatalf("expected modeInjections restored from sidecar rehydrate")
	}
	if len(asSlice(settings["providers"])) == 0 {
		t.Fatalf("expected providers restored from sidecar rehydrate")
	}
	found := false
	for _, w := range warnings {
		if w == "sidecar-rehydrate:rikka.settings" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected sidecar-rehydrate warning")
	}
}

func TestBuildRikkaSettingsFromIR_OpenAIBaseURLV1Normalization(t *testing.T) {
	in := &ir.BackupIR{
		SourceFormat: "cherry",
		Settings: map[string]any{
			"core.providers": []any{
				map[string]any{
					"id":         "p1",
					"name":       "herta",
					"mappedType": "openai",
					"raw": map[string]any{
						"id":      "p1",
						"name":    "herta",
						"apiHost": "https://herta.us.ci/",
						"models": []any{
							map[string]any{"id": "m1", "name": "gemini-3-flash-preview"},
						},
					},
				},
			},
			"core.assistants": []any{
				map[string]any{"id": "a1", "name": "A1", "chatModelId": "m1", "raw": map[string]any{"id": "a1", "name": "A1", "chatModelId": "m1"}},
			},
			"core.models": map[string]any{
				"chatModelId": "m1",
			},
		},
		Config: map[string]any{},
	}

	settings, _ := BuildRikkaSettingsFromIR(in, map[string]any{})
	providers := asSlice(settings["providers"])
	if len(providers) != 1 {
		t.Fatalf("expected 1 provider, got=%d", len(providers))
	}
	p := asMap(providers[0])
	if got := pickFirstString(p["baseUrl"]); got != "https://herta.us.ci/v1" {
		t.Fatalf("expected baseUrl normalized with /v1, got=%s", got)
	}
	if got := pickFirstString(p["chatCompletionsPath"]); got != "/chat/completions" {
		t.Fatalf("expected chatCompletionsPath=/chat/completions, got=%s", got)
	}
}

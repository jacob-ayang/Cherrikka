package mapping

import "fmt"

func NormalizeFromRikkaConfig(config map[string]any) (map[string]any, []string) {
	out := defaultNormalizedSettings()
	out["normalizer.source"] = "rikka"
	warnings := []string{}

	settings := cloneMap(asMap(config["rikka.settings"]))
	out["raw.rikka"] = map[string]any{"settings": settings}

	providersRaw := asSlice(settings["providers"])
	coreProviders := make([]any, 0, len(providersRaw))
	for _, item := range providersRaw {
		pm := asMap(item)
		if len(pm) == 0 {
			continue
		}
		pType := pickFirstString(pm["type"])
		mapped, ok := rikkaProviderToCanonical(pType)
		if !ok {
			warnings = appendUnique(warnings, fmt.Sprintf("unsupported rikka provider type: %s", pType))
		}
		entry := map[string]any{
			"id":         pickFirstString(pm["id"]),
			"name":       pickFirstString(pm["name"], pm["id"]),
			"sourceType": pType,
			"mappedType": mapped,
			"raw":        cloneMap(pm),
		}
		ensureID(entry)
		coreProviders = append(coreProviders, entry)
	}
	out["core.providers"] = coreProviders

	assistantsRaw := asSlice(settings["assistants"])
	coreAssistants := make([]any, 0, len(assistantsRaw))
	for _, item := range assistantsRaw {
		am := asMap(item)
		if len(am) == 0 {
			continue
		}
		entry := map[string]any{
			"id":           pickFirstString(am["id"]),
			"name":         pickFirstString(am["name"]),
			"systemPrompt": pickFirstString(am["systemPrompt"]),
			"chatModelId":  pickFirstString(am["chatModelId"]),
			"temperature":  am["temperature"],
			"topP":         am["topP"],
			"context":      am["contextMessageSize"],
			"stream":       am["streamOutput"],
			"maxTokens":    am["maxTokens"],
			"raw":          cloneMap(am),
		}
		ensureID(entry)
		coreAssistants = append(coreAssistants, entry)
	}
	out["core.assistants"] = coreAssistants

	coreModels := map[string]any{}
	for _, key := range []string{"chatModelId", "titleModelId", "translateModeId", "suggestionModelId", "imageGenerationModelId"} {
		setIfPresent(coreModels, key, settings[key])
	}
	out["core.models"] = coreModels

	selection := map[string]any{}
	setIfPresent(selection, "assistantId", settings["assistantId"])
	out["core.selection"] = selection

	out["sync.webdav"] = cloneMap(asMap(settings["webDavConfig"]))
	out["sync.s3"] = cloneMap(asMap(settings["s3Config"]))

	ui := map[string]any{}
	if display := asMap(settings["displaySetting"]); len(display) > 0 {
		ui["displaySetting"] = cloneMap(display)
	}
	out["ui.profile"] = ui

	search := map[string]any{}
	for _, key := range []string{"enableWebSearch", "searchServices", "searchCommonOptions", "searchServiceSelected"} {
		if v, ok := settings[key]; ok {
			search[key] = cloneAny(v)
		}
	}
	out["search"] = search

	mcp := map[string]any{}
	if v, ok := settings["mcpServers"]; ok {
		mcp["servers"] = cloneAny(v)
	}
	out["mcp"] = mcp

	tts := map[string]any{}
	for _, key := range []string{"ttsProviders", "selectedTTSProviderId"} {
		if v, ok := settings[key]; ok {
			tts[key] = cloneAny(v)
		}
	}
	out["tts"] = tts

	return out, warnings
}

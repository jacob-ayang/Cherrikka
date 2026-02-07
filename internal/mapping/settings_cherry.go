package mapping

import "fmt"

func NormalizeFromCherryConfig(config map[string]any) (map[string]any, []string) {
	out := defaultNormalizedSettings()
	out["normalizer.source"] = "cherry"
	warnings := []string{}

	persistSlices := asMap(config["cherry.persistSlices"])
	settings := cloneMap(asMap(config["cherry.settings"]))
	llm := cloneMap(asMap(config["cherry.llm"]))
	if len(settings) == 0 {
		settings = cloneMap(asMap(persistSlices["settings"]))
	}
	if len(llm) == 0 {
		llm = cloneMap(asMap(persistSlices["llm"]))
	}

	rawCherry := map[string]any{
		"settings": settings,
		"llm":      llm,
	}
	out["raw.cherry"] = rawCherry

	assistantsSlice := asMap(persistSlices["assistants"])
	assistantsRaw := asSlice(assistantsSlice["assistants"])
	coreAssistants := make([]any, 0, len(assistantsRaw))
	for _, item := range assistantsRaw {
		am := asMap(item)
		if len(am) == 0 {
			continue
		}
		model := asMap(am["model"])
		aSettings := asMap(am["settings"])
		entry := map[string]any{
			"id":           pickFirstString(am["id"]),
			"name":         pickFirstString(am["name"]),
			"systemPrompt": pickFirstString(am["prompt"]),
			"chatModelId":  pickFirstString(model["id"]),
			"temperature":  aSettings["temperature"],
			"topP":         aSettings["topP"],
			"context":      aSettings["contextCount"],
			"stream":       aSettings["streamOutput"],
			"maxTokens":    aSettings["maxTokens"],
			"raw":          cloneMap(am),
		}
		ensureID(entry)
		coreAssistants = append(coreAssistants, entry)
	}
	out["core.assistants"] = coreAssistants

	llmProviders := asSlice(llm["providers"])
	coreProviders := make([]any, 0, len(llmProviders))
	for _, item := range llmProviders {
		pm := asMap(item)
		if len(pm) == 0 {
			continue
		}
		pType := pickFirstString(pm["type"], pm["providerType"])
		mapped, ok := cherryProviderToCanonical(pType)
		if !ok {
			warnings = appendUnique(warnings, fmt.Sprintf("unsupported cherry provider type: %s", pType))
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

	coreModels := map[string]any{}
	for _, key := range []string{"defaultModel", "quickModel", "translateModel", "topicNamingModel"} {
		if m := asMap(llm[key]); len(m) > 0 {
			coreModels[key] = cloneMap(m)
		}
	}
	setModelSelection := func(selectionKey, sourceKey string) {
		if _, exists := coreModels[selectionKey]; exists {
			return
		}
		src := asMap(coreModels[sourceKey])
		if len(src) == 0 {
			return
		}
		if id := pickFirstString(src["id"], src["modelId"], src["name"]); id != "" {
			coreModels[selectionKey] = id
		}
	}
	setModelSelection("chatModelId", "defaultModel")
	setModelSelection("suggestionModelId", "quickModel")
	setModelSelection("translateModeId", "translateModel")
	setModelSelection("titleModelId", "topicNamingModel")
	out["core.models"] = coreModels

	selection := map[string]any{}
	if defaultAssistant := asMap(assistantsSlice["defaultAssistant"]); len(defaultAssistant) > 0 {
		setIfPresent(selection, "assistantId", defaultAssistant["id"])
	}
	setIfPresent(selection, "assistantId", settings["assistantId"])
	out["core.selection"] = selection

	webdav := map[string]any{}
	for _, key := range []string{"webdavHost", "webdavUser", "webdavPass", "webdavPath", "webdavAutoSync", "webdavSyncInterval", "webdavMaxBackups", "webdavSkipBackupFile", "webdavDisableStream"} {
		if v, ok := settings[key]; ok {
			webdav[key] = cloneAny(v)
		}
	}
	out["sync.webdav"] = webdav

	s3 := cloneMap(asMap(settings["s3"]))
	out["sync.s3"] = s3

	local := map[string]any{}
	for _, key := range []string{"localBackupDir", "localBackupAutoSync", "localBackupSyncInterval", "localBackupMaxBackups", "localBackupSkipBackupFile"} {
		if v, ok := settings[key]; ok {
			local[key] = cloneAny(v)
		}
	}
	out["sync.local"] = local

	uiProfile := map[string]any{}
	for _, key := range []string{"userId", "userName", "language", "targetLanguage"} {
		if v, ok := settings[key]; ok {
			uiProfile[key] = cloneAny(v)
		}
	}
	out["ui.profile"] = uiProfile

	search := map[string]any{}
	for _, key := range []string{"enableWebSearch", "webSearchProvider", "webSearchProviders"} {
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

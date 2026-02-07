package mapping

import (
	"strings"

	"cherrikka/internal/ir"
	"cherrikka/internal/util"
)

func BuildCherryPersistSlicesFromIR(in *ir.BackupIR, base map[string]any, assistantsSlice map[string]any) (map[string]any, []string) {
	warnings := []string{}
	dst := cloneMap(base)
	if len(dst) == 0 {
		dst = map[string]any{}
	}

	norm := cloneMap(in.Settings)
	if len(norm) == 0 {
		var ws []string
		norm, ws = normalizeFromSource(in)
		warnings = appendUnique(warnings, ws...)
	}

	if len(assistantsSlice) > 0 {
		dst["assistants"] = cloneMap(assistantsSlice)
	}

	settings := cloneMap(asMap(dst["settings"]))
	llm := cloneMap(asMap(dst["llm"]))

	if rehydratePersist := asMap(in.Config["rehydrate.cherry.persistSlices"]); len(rehydratePersist) > 0 {
		mergeOverlay(settings, asMap(rehydratePersist["settings"]))
		mergeOverlay(llm, asMap(rehydratePersist["llm"]))
		if len(asMap(dst["assistants"])) == 0 {
			if restoredAssistants := asMap(rehydratePersist["assistants"]); len(restoredAssistants) > 0 {
				dst["assistants"] = restoredAssistants
			}
		}
		warnings = appendUnique(warnings, "sidecar-rehydrate:cherry.persistSlices")
	}
	if rehydrateSettings := asMap(in.Config["rehydrate.cherry.settings"]); len(rehydrateSettings) > 0 {
		mergeOverlay(settings, rehydrateSettings)
		warnings = appendUnique(warnings, "sidecar-rehydrate:cherry.settings")
	}
	if rehydrateLLM := asMap(in.Config["rehydrate.cherry.llm"]); len(rehydrateLLM) > 0 {
		mergeOverlay(llm, rehydrateLLM)
		warnings = appendUnique(warnings, "sidecar-rehydrate:cherry.llm")
	}

	coreModels := asMap(norm["core.models"])
	cherryProviders, modelLookup, firstModel := buildCherryProviders(asSlice(norm["core.providers"]), &warnings)
	if len(cherryProviders) > 0 {
		llm["providers"] = cherryProviders
	}
	applyCherrySelection(llm, "defaultModel", modelLookup, firstModel, &warnings, coreModels["defaultModel"], coreModels["chatModelId"])
	applyCherrySelection(llm, "quickModel", modelLookup, firstModel, &warnings, coreModels["quickModel"], coreModels["suggestionModelId"])
	applyCherrySelection(llm, "translateModel", modelLookup, firstModel, &warnings, coreModels["translateModel"], coreModels["translateModeId"])
	applyCherrySelection(llm, "topicNamingModel", modelLookup, firstModel, &warnings, coreModels["topicNamingModel"], coreModels["titleModelId"])

	ui := asMap(norm["ui.profile"])
	for _, key := range []string{"userId", "userName", "language", "targetLanguage"} {
		if v, ok := ui[key]; ok {
			settings[key] = cloneAny(v)
		}
	}

	selection := asMap(norm["core.selection"])
	if aid := pickFirstString(selection["assistantId"]); aid != "" {
		settings["assistantId"] = aid
	}

	webdav := asMap(norm["sync.webdav"])
	copyWebDavKey := func(dstKey string, srcKeys ...string) {
		for _, srcKey := range srcKeys {
			if v, ok := webdav[srcKey]; ok {
				settings[dstKey] = cloneAny(v)
				return
			}
		}
	}
	copyWebDavKey("webdavHost", "webdavHost", "url")
	copyWebDavKey("webdavUser", "webdavUser", "username")
	copyWebDavKey("webdavPass", "webdavPass", "password")
	copyWebDavKey("webdavPath", "webdavPath", "path")
	copyWebDavKey("webdavAutoSync", "webdavAutoSync")
	copyWebDavKey("webdavSyncInterval", "webdavSyncInterval")
	copyWebDavKey("webdavMaxBackups", "webdavMaxBackups")
	copyWebDavKey("webdavSkipBackupFile", "webdavSkipBackupFile")
	copyWebDavKey("webdavDisableStream", "webdavDisableStream")

	if s3 := cloneMap(asMap(norm["sync.s3"])); len(s3) > 0 {
		settings["s3"] = s3
	}
	if local := asMap(norm["sync.local"]); len(local) > 0 {
		for _, key := range []string{"localBackupDir", "localBackupAutoSync", "localBackupSyncInterval", "localBackupMaxBackups", "localBackupSkipBackupFile"} {
			if v, ok := local[key]; ok {
				settings[key] = cloneAny(v)
			}
		}
	}

	if search := asMap(norm["search"]); len(search) > 0 {
		mergeMissing(settings, search)
	}
	if mcp := asMap(norm["mcp"]); len(mcp) > 0 {
		if v, ok := mcp["servers"]; ok {
			settings["mcpServers"] = cloneAny(v)
		}
	}
	if tts := asMap(norm["tts"]); len(tts) > 0 {
		mergeMissing(settings, tts)
	}

	if strings.EqualFold(in.SourceFormat, "cherry") {
		mergeMissing(settings, asMap(in.Config["cherry.settings"]))
		mergeMissing(llm, asMap(in.Config["cherry.llm"]))
	}

	if pickFirstString(settings["userId"]) == "" {
		settings["userId"] = util.NewUUID()
	}
	if _, ok := settings["skipBackupFile"]; !ok {
		settings["skipBackupFile"] = false
	}

	dst["settings"] = settings
	dst["llm"] = llm
	return dst, warnings
}

func buildCherryProviders(coreProviders []any, warnings *[]string) ([]any, map[string]map[string]any, map[string]any) {
	out := make([]any, 0, len(coreProviders))
	modelLookup := map[string]map[string]any{}
	firstModel := map[string]any{}
	for _, item := range coreProviders {
		pm := asMap(item)
		if len(pm) == 0 {
			continue
		}
		mapped := pickFirstString(pm["mappedType"])
		cherryType := canonicalToCherryType(mapped, pickFirstString(pm["sourceType"]))
		if cherryType == "" {
			*warnings = appendUnique(*warnings, "skip unsupported canonical provider mapping to cherry")
			continue
		}
		raw := cloneMap(asMap(pm["raw"]))
		providerID := pickFirstString(raw["id"], pm["id"])
		if providerID == "" {
			providerID = util.NewUUID()
		}
		if raw["id"] == nil || str(raw["id"]) == "" {
			raw["id"] = providerID
		} else {
			raw["id"] = providerID
		}
		if raw["name"] == nil || str(raw["name"]) == "" {
			raw["name"] = pickFirstString(pm["name"], strings.ToUpper(mapped))
		}
		raw["type"] = cherryType
		rawModels := asSlice(raw["models"])
		normModels := make([]any, 0, len(rawModels))
		for _, mv := range rawModels {
			mm := cloneMap(asMap(mv))
			if len(mm) == 0 {
				continue
			}
			sourceID := pickFirstString(mm["id"])
			modelID := pickFirstString(mm["modelId"], mm["id"], mm["name"], mm["displayName"])
			if modelID == "" {
				modelID = util.NewUUID()
			}
			model := cloneMap(mm)
			model["id"] = modelID
			model["provider"] = providerID
			model["name"] = pickFirstString(mm["name"], mm["displayName"], mm["modelId"], modelID)
			if pickFirstString(model["group"]) == "" {
				model["group"] = "default"
			}
			if pickFirstString(model["modelId"]) == "" {
				model["modelId"] = modelID
			}
			registerCherryModelAlias(modelLookup, sourceID, model)
			registerCherryModelAlias(modelLookup, pickFirstString(model["id"]), model)
			registerCherryModelAlias(modelLookup, pickFirstString(model["modelId"]), model)
			registerCherryModelAlias(modelLookup, pickFirstString(model["name"]), model)
			registerCherryModelAlias(modelLookup, pickFirstString(model["displayName"]), model)
			if len(firstModel) == 0 {
				firstModel = cloneMap(model)
			}
			normModels = append(normModels, model)
		}
		if len(normModels) == 0 {
			raw["models"] = []any{}
			raw["enabled"] = false
			*warnings = appendUnique(*warnings, "provider-invalid-disabled:"+pickFirstString(raw["name"], providerID)+":no-models")
		} else {
			raw["models"] = normModels
		}
		if pickFirstString(raw["apiHost"]) == "" {
			if baseURL := pickFirstString(raw["baseUrl"]); baseURL != "" {
				raw["apiHost"] = baseURL
			}
		}
		out = append(out, raw)
	}
	return out, modelLookup, firstModel
}

func registerCherryModelAlias(lookup map[string]map[string]any, key string, model map[string]any) {
	key = strings.TrimSpace(key)
	if key == "" {
		return
	}
	if _, ok := lookup[key]; !ok {
		lookup[key] = cloneMap(model)
	}
	low := strings.ToLower(key)
	if _, ok := lookup[low]; !ok {
		lookup[low] = cloneMap(model)
	}
}

func resolveCherryModel(candidate any, lookup map[string]map[string]any) map[string]any {
	resolveByString := func(v string) map[string]any {
		v = strings.TrimSpace(v)
		if v == "" {
			return nil
		}
		if m, ok := lookup[v]; ok && len(m) > 0 {
			return cloneMap(m)
		}
		if m, ok := lookup[strings.ToLower(v)]; ok && len(m) > 0 {
			return cloneMap(m)
		}
		return nil
	}
	if s := pickFirstString(candidate); s != "" {
		if m := resolveByString(s); len(m) > 0 {
			return m
		}
	}
	mm := asMap(candidate)
	if len(mm) == 0 {
		return nil
	}
	for _, key := range []string{"id", "modelId", "name", "displayName"} {
		if m := resolveByString(pickFirstString(mm[key])); len(m) > 0 {
			return m
		}
	}
	modelID := pickFirstString(mm["modelId"], mm["id"], mm["name"], mm["displayName"])
	if modelID == "" {
		return nil
	}
	out := cloneMap(mm)
	out["id"] = modelID
	out["name"] = pickFirstString(mm["name"], mm["displayName"], modelID)
	if pickFirstString(out["group"]) == "" {
		out["group"] = "default"
	}
	if pickFirstString(out["modelId"]) == "" {
		out["modelId"] = modelID
	}
	return out
}

func applyCherrySelection(llm map[string]any, key string, lookup map[string]map[string]any, firstModel map[string]any, warnings *[]string, candidates ...any) {
	for _, candidate := range candidates {
		if model := resolveCherryModel(candidate, lookup); len(model) > 0 {
			llm[key] = model
			return
		}
	}
	if len(firstModel) > 0 {
		llm[key] = cloneMap(firstModel)
		*warnings = appendUnique(*warnings, "provider-invalid-disabled:model-selection-fallback:"+key)
	}
}

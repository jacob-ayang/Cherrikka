package mapping

import (
	"strings"

	"cherrikka/internal/ir"
	"cherrikka/internal/util"
)

func BuildRikkaSettingsFromIR(in *ir.BackupIR, base map[string]any) (map[string]any, []string) {
	warnings := []string{}
	dst := cloneMap(base)
	if len(dst) == 0 {
		dst = map[string]any{
			"assistantId": defaultAssistantID,
			"providers":   []any{},
			"assistants":  []any{},
		}
	}

	norm := cloneMap(in.Settings)
	if len(norm) == 0 {
		var ws []string
		norm, ws = normalizeFromSource(in)
		warnings = appendUnique(warnings, ws...)
	}

	if dstProviders := buildRikkaProviders(asSlice(norm["core.providers"]), &warnings); len(dstProviders) > 0 {
		dst["providers"] = dstProviders
	} else if _, ok := dst["providers"]; !ok {
		dst["providers"] = []any{}
	}

	if dstAssistants := buildRikkaAssistants(in, asSlice(norm["core.assistants"])); len(dstAssistants) > 0 {
		dst["assistants"] = dstAssistants
	} else if _, ok := dst["assistants"]; !ok {
		dst["assistants"] = []any{}
	}

	models := asMap(norm["core.models"])
	for _, key := range []string{"chatModelId", "titleModelId", "translateModeId", "suggestionModelId", "imageGenerationModelId"} {
		if v, ok := models[key]; ok {
			dst[key] = cloneAny(v)
		}
	}

	selection := asMap(norm["core.selection"])
	if aid := pickFirstString(selection["assistantId"]); aid != "" {
		dst["assistantId"] = aid
	}

	if webdavRaw := cloneMap(asMap(norm["sync.webdav"])); len(webdavRaw) > 0 {
		webdav := map[string]any{}
		setIfPresent(webdav, "url", pickFirstString(webdavRaw["url"], webdavRaw["webdavHost"]))
		setIfPresent(webdav, "username", pickFirstString(webdavRaw["username"], webdavRaw["webdavUser"]))
		setIfPresent(webdav, "password", pickFirstString(webdavRaw["password"], webdavRaw["webdavPass"]))
		setIfPresent(webdav, "path", pickFirstString(webdavRaw["path"], webdavRaw["webdavPath"]))
		if items, ok := webdavRaw["items"]; ok {
			webdav["items"] = cloneAny(items)
		} else {
			webdav["items"] = []any{"DATABASE", "FILES"}
		}
		dst["webDavConfig"] = webdav
	}
	if s3 := cloneMap(asMap(norm["sync.s3"])); len(s3) > 0 {
		if _, ok := s3["items"]; !ok {
			s3["items"] = []any{"DATABASE", "FILES"}
		}
		dst["s3Config"] = s3
	}

	if ui := asMap(norm["ui.profile"]); len(ui) > 0 {
		if display, ok := ui["displaySetting"]; ok {
			dst["displaySetting"] = cloneAny(display)
		}
	}

	if search := asMap(norm["search"]); len(search) > 0 {
		for _, key := range []string{"enableWebSearch", "searchServices", "searchCommonOptions", "searchServiceSelected"} {
			if v, ok := search[key]; ok {
				dst[key] = cloneAny(v)
			}
		}
	}
	if mcp := asMap(norm["mcp"]); len(mcp) > 0 {
		if v, ok := mcp["servers"]; ok {
			dst["mcpServers"] = cloneAny(v)
		}
	}
	if tts := asMap(norm["tts"]); len(tts) > 0 {
		if v, ok := tts["ttsProviders"]; ok {
			dst["ttsProviders"] = cloneAny(v)
		}
		if v, ok := tts["selectedTTSProviderId"]; ok {
			dst["selectedTTSProviderId"] = cloneAny(v)
		}
	}

	if strings.EqualFold(in.SourceFormat, "rikka") {
		raw := asMap(asMap(in.Config["rikka.settings"]))
		mergeMissing(dst, raw)
	}

	warnings = appendUnique(warnings, enforceRikkaConsistency(dst)...)
	return dst, warnings
}

func buildRikkaProviders(coreProviders []any, warnings *[]string) []any {
	out := make([]any, 0, len(coreProviders))
	for _, item := range coreProviders {
		pm := asMap(item)
		if len(pm) == 0 {
			continue
		}
		raw := cloneMap(asMap(pm["raw"]))
		mapped := pickFirstString(pm["mappedType"])
		pType := canonicalToRikkaType(mapped)
		if pType == "" {
			*warnings = appendUnique(*warnings, "skip unsupported canonical provider mapping to rikka")
			continue
		}
		if raw["id"] == nil || str(raw["id"]) == "" {
			raw["id"] = pickFirstString(pm["id"], util.NewUUID())
		}
		if raw["name"] == nil || str(raw["name"]) == "" {
			raw["name"] = pickFirstString(pm["name"], strings.ToUpper(mapped))
		}
		raw["type"] = pType
		if _, ok := raw["models"]; !ok {
			raw["models"] = []any{}
		}
		if baseURL := pickFirstString(raw["baseUrl"]); baseURL == "" {
			if apiHost := pickFirstString(raw["apiHost"]); apiHost != "" {
				raw["baseUrl"] = apiHost
			}
		}
		out = append(out, raw)
	}
	return out
}

func buildRikkaAssistants(in *ir.BackupIR, coreAssistants []any) []any {
	out := make([]any, 0, len(coreAssistants)+len(in.Assistants))
	appendAssistant := func(raw map[string]any) {
		if len(raw) == 0 {
			return
		}
		if str(raw["id"]) == "" {
			raw["id"] = util.NewUUID()
		}
		if str(raw["name"]) == "" {
			raw["name"] = "Imported Assistant"
		}
		if _, ok := raw["streamOutput"]; !ok {
			raw["streamOutput"] = true
		}
		if _, ok := raw["contextMessageSize"]; !ok {
			raw["contextMessageSize"] = 64
		}
		out = append(out, raw)
	}

	for _, item := range coreAssistants {
		am := asMap(item)
		if len(am) == 0 {
			continue
		}
		raw := cloneMap(asMap(am["raw"]))
		raw["id"] = pickFirstString(raw["id"], am["id"])
		raw["name"] = pickFirstString(raw["name"], am["name"])
		raw["systemPrompt"] = pickFirstString(raw["systemPrompt"], am["systemPrompt"])
		raw["chatModelId"] = pickFirstString(raw["chatModelId"], am["chatModelId"])
		if _, ok := raw["temperature"]; !ok {
			raw["temperature"] = am["temperature"]
		}
		if _, ok := raw["topP"]; !ok {
			raw["topP"] = am["topP"]
		}
		if _, ok := raw["contextMessageSize"]; !ok {
			raw["contextMessageSize"] = am["context"]
		}
		if _, ok := raw["streamOutput"]; !ok {
			raw["streamOutput"] = am["stream"]
		}
		if _, ok := raw["maxTokens"]; !ok {
			raw["maxTokens"] = am["maxTokens"]
		}
		appendAssistant(raw)
	}

	if len(out) > 0 || len(in.Assistants) == 0 {
		return out
	}

	for _, a := range in.Assistants {
		raw := map[string]any{
			"id":           pickFirstString(a.ID),
			"name":         pickFirstString(a.Name, "Imported Assistant"),
			"systemPrompt": a.Prompt,
			"chatModelId":  pickFirstString(a.Model["chatModelId"], a.Model["id"]),
		}
		if v, ok := a.Settings["temperature"]; ok {
			raw["temperature"] = v
		}
		if v, ok := a.Settings["topP"]; ok {
			raw["topP"] = v
		}
		if v, ok := a.Settings["contextCount"]; ok {
			raw["contextMessageSize"] = v
		}
		if v, ok := a.Settings["streamOutput"]; ok {
			raw["streamOutput"] = v
		}
		if v, ok := a.Settings["maxTokens"]; ok {
			raw["maxTokens"] = v
		}
		appendAssistant(raw)
	}
	return out
}

func enforceRikkaConsistency(settings map[string]any) []string {
	warnings := []string{}

	assistants := asSlice(settings["assistants"])
	assistantIDs := map[string]struct{}{}
	for i, item := range assistants {
		am := asMap(item)
		id := pickFirstString(am["id"])
		if id == "" {
			id = util.NewUUID()
			am["id"] = id
			assistants[i] = am
		}
		assistantIDs[id] = struct{}{}
	}
	settings["assistants"] = assistants

	if len(assistantIDs) > 0 {
		assistantID := pickFirstString(settings["assistantId"])
		if _, ok := assistantIDs[assistantID]; !ok {
			for id := range assistantIDs {
				settings["assistantId"] = id
				warnings = append(warnings, "selected assistant not found, fallback to first assistant")
				break
			}
		}
	} else if pickFirstString(settings["assistantId"]) == "" {
		settings["assistantId"] = defaultAssistantID
	}

	modelIDs := map[string]struct{}{}
	for _, item := range asSlice(settings["providers"]) {
		pm := asMap(item)
		for _, m := range asSlice(pm["models"]) {
			mm := asMap(m)
			if id := pickFirstString(mm["id"]); id != "" {
				modelIDs[id] = struct{}{}
			}
		}
	}

	for _, key := range []string{"chatModelId", "titleModelId", "translateModeId", "suggestionModelId"} {
		if id := pickFirstString(settings[key]); id != "" {
			if _, ok := modelIDs[id]; !ok {
				warnings = appendUnique(warnings, "selected model "+key+" not found in providers")
			}
		}
	}

	return warnings
}

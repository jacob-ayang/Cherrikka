package mapping

import (
	"fmt"
	"strconv"
	"strings"

	guuid "github.com/google/uuid"

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

	providerList, modelAlias := buildRikkaProviders(asSlice(norm["core.providers"]), &warnings)
	if len(providerList) > 0 {
		dst["providers"] = providerList
	} else if _, ok := dst["providers"]; !ok {
		dst["providers"] = []any{}
	}

	if dstAssistants := buildRikkaAssistants(in, asSlice(norm["core.assistants"]), modelAlias, &warnings); len(dstAssistants) > 0 {
		dst["assistants"] = dstAssistants
	} else if _, ok := dst["assistants"]; !ok {
		dst["assistants"] = []any{}
	}

	models := asMap(norm["core.models"])
	applyRikkaModelSelection(dst, models, modelAlias)

	selection := asMap(norm["core.selection"])
	if aid := pickFirstString(selection["assistantId"]); aid != "" {
		dst["assistantId"] = ensureUUID(aid, "assistant:selection:"+aid)
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

func applyRikkaModelSelection(dst, coreModels map[string]any, modelAlias map[string]string) {
	if len(coreModels) == 0 {
		return
	}

	setSelection := func(settingKey string, candidates ...any) {
		for _, candidate := range candidates {
			if id := resolveModelID(candidate, modelAlias); id != "" {
				dst[settingKey] = id
				return
			}
		}
	}

	setSelection("chatModelId", coreModels["chatModelId"], coreModels["defaultModel"])
	setSelection("titleModelId", coreModels["titleModelId"], coreModels["topicNamingModel"])
	setSelection("translateModeId", coreModels["translateModeId"], coreModels["translateModel"])
	setSelection("suggestionModelId", coreModels["suggestionModelId"], coreModels["quickModel"])
	setSelection("imageGenerationModelId", coreModels["imageGenerationModelId"])
}

func buildRikkaProviders(coreProviders []any, warnings *[]string) ([]any, map[string]string) {
	out := make([]any, 0, len(coreProviders))
	modelAlias := map[string]string{}

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

		providerSeed := pickFirstString(raw["id"], pm["id"], raw["name"], pm["name"], mapped, util.NewUUID())
		providerID := ensureUUID(pickFirstString(raw["id"], pm["id"]), "provider:"+providerSeed)
		provider := map[string]any{
			"id":      providerID,
			"name":    pickFirstString(raw["name"], pm["name"], strings.ToUpper(mapped), "Imported Provider"),
			"type":    pType,
			"enabled": true,
		}
		if enabled, ok := coerceBool(raw["enabled"]); ok {
			provider["enabled"] = enabled
		}
		switch pType {
		case "openai":
			setIfPresent(provider, "apiKey", pickFirstString(raw["apiKey"]))
			setIfPresent(provider, "baseUrl", pickFirstString(raw["baseUrl"], raw["apiHost"], "https://api.openai.com/v1"))
			setIfPresent(provider, "chatCompletionsPath", pickFirstString(raw["chatCompletionsPath"], "/chat/completions"))
			if useResponseAPI, ok := coerceBool(raw["useResponseApi"]); ok {
				provider["useResponseApi"] = useResponseAPI
			}
		case "claude":
			setIfPresent(provider, "apiKey", pickFirstString(raw["apiKey"]))
			setIfPresent(provider, "baseUrl", pickFirstString(raw["baseUrl"], raw["apiHost"], "https://api.anthropic.com/v1"))
		case "google":
			setIfPresent(provider, "apiKey", pickFirstString(raw["apiKey"]))
			setIfPresent(provider, "baseUrl", pickFirstString(raw["baseUrl"], raw["apiHost"], "https://generativelanguage.googleapis.com/v1beta"))
			if vertexAI, ok := coerceBool(raw["vertexAI"]); ok {
				provider["vertexAI"] = vertexAI
			}
			setIfPresent(provider, "privateKey", pickFirstString(raw["privateKey"]))
			setIfPresent(provider, "serviceAccountEmail", pickFirstString(raw["serviceAccountEmail"]))
			setIfPresent(provider, "location", pickFirstString(raw["location"]))
			setIfPresent(provider, "projectId", pickFirstString(raw["projectId"]))
		}

		rawModels := asSlice(raw["models"])
		normModels := make([]any, 0, len(rawModels))
		for _, m := range rawModels {
			mm := cloneMap(asMap(m))
			if len(mm) == 0 {
				continue
			}

			modelRef := pickFirstString(mm["modelId"], mm["id"], mm["name"], mm["displayName"])
			if modelRef == "" {
				modelRef = util.NewUUID()
			}
			modelID := ensureUUID(pickFirstString(mm["id"]), "model:"+providerID+":"+modelRef)
			modelType := normalizeRikkaModelType(mm["type"])
			if pickFirstString(mm["type"]) != "" && modelType != strings.ToUpper(strings.TrimSpace(pickFirstString(mm["type"]))) {
				*warnings = appendUnique(*warnings, "normalized unsupported model type to CHAT: "+pickFirstString(mm["type"]))
			}
			model := map[string]any{
				"id":          modelID,
				"modelId":     pickFirstString(mm["modelId"], modelRef),
				"displayName": pickFirstString(mm["displayName"], mm["name"], modelRef),
				"type":        modelType,
			}
			if vals := normalizeModelModalities(mm["inputModalities"]); len(vals) > 0 {
				model["inputModalities"] = vals
			}
			if vals := normalizeModelModalities(mm["outputModalities"]); len(vals) > 0 {
				model["outputModalities"] = vals
			}
			if vals := normalizeModelAbilities(mm["abilities"]); len(vals) > 0 {
				model["abilities"] = vals
			}
			if vals := normalizeModelTools(mm["tools"]); len(vals) > 0 {
				model["tools"] = vals
			}

			registerModelAlias(modelAlias, modelRef, modelID)
			registerModelAlias(modelAlias, pickFirstString(model["id"]), modelID)
			registerModelAlias(modelAlias, pickFirstString(model["displayName"]), modelID)
			registerModelAlias(modelAlias, pickFirstString(mm["name"]), modelID)
			normModels = append(normModels, model)
		}
		provider["models"] = normModels

		out = append(out, provider)
	}

	return out, modelAlias
}

func buildRikkaAssistants(in *ir.BackupIR, coreAssistants []any, modelAlias map[string]string, warnings *[]string) []any {
	out := make([]any, 0, len(coreAssistants)+len(in.Assistants))
	usedNames := map[string]struct{}{}
	appendAssistant := func(raw map[string]any) {
		if len(raw) == 0 {
			return
		}
		assistant := map[string]any{
			"id":           pickFirstString(raw["id"]),
			"name":         pickFirstString(raw["name"]),
			"systemPrompt": pickFirstString(raw["systemPrompt"]),
			"chatModelId":  pickFirstString(raw["chatModelId"]),
		}
		if temperature, ok := coerceFloat(raw["temperature"]); ok {
			assistant["temperature"] = temperature
		}
		if topP, ok := coerceFloat(raw["topP"]); ok {
			assistant["topP"] = topP
		}
		if contextSize, ok := coerceInt(raw["contextMessageSize"]); ok {
			assistant["contextMessageSize"] = contextSize
		}
		if stream, ok := coerceBool(raw["streamOutput"]); ok {
			assistant["streamOutput"] = stream
		}
		if maxTokens, ok := coerceInt(raw["maxTokens"]); ok {
			assistant["maxTokens"] = maxTokens
		}
		if enableMemory, ok := coerceBool(raw["enableMemory"]); ok {
			assistant["enableMemory"] = enableMemory
		}
		if useGlobalMemory, ok := coerceBool(raw["useGlobalMemory"]); ok {
			assistant["useGlobalMemory"] = useGlobalMemory
		}
		if enableRecentChatsReference, ok := coerceBool(raw["enableRecentChatsReference"]); ok {
			assistant["enableRecentChatsReference"] = enableRecentChatsReference
		}
		setIfPresent(assistant, "messageTemplate", pickFirstString(raw["messageTemplate"]))
		assistant["mcpServers"] = cloneAny(raw["mcpServers"])
		assistant["tags"] = cloneAny(raw["tags"])
		assistant["modeInjectionIds"] = cloneAny(raw["modeInjectionIds"])
		assistant["lorebookIds"] = cloneAny(raw["lorebookIds"])

		assistantSeed := pickFirstString(assistant["id"], assistant["name"], util.NewUUID())
		assistant["id"] = ensureUUID(pickFirstString(assistant["id"]), "assistant:"+assistantSeed)
		assignUniqueAssistantName(assistant, usedNames, warnings)
		sanitizeAssistantUUIDListField(assistant, "mcpServers", warnings)
		sanitizeAssistantUUIDListField(assistant, "tags", warnings)
		sanitizeAssistantUUIDListField(assistant, "modeInjectionIds", warnings)
		sanitizeAssistantUUIDListField(assistant, "lorebookIds", warnings)
		if chatModel := pickFirstString(assistant["chatModelId"]); chatModel != "" {
			if resolved := resolveModelID(chatModel, modelAlias); resolved != "" {
				assistant["chatModelId"] = resolved
			} else {
				delete(assistant, "chatModelId")
				*warnings = appendUnique(*warnings, "assistant chat model not found, dropped: "+chatModel)
			}
		} else {
			delete(assistant, "chatModelId")
		}
		if _, ok := assistant["streamOutput"]; !ok {
			assistant["streamOutput"] = true
		}
		if _, ok := assistant["contextMessageSize"]; !ok {
			assistant["contextMessageSize"] = 64
		}
		out = append(out, assistant)
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

	providers := asSlice(settings["providers"])
	modelIDs := map[string]struct{}{}
	firstModelID := ""
	for pi, pItem := range providers {
		pm := asMap(pItem)
		providerSeed := pickFirstString(pm["id"], pm["name"], util.NewUUID())
		pm["id"] = ensureUUID(pickFirstString(pm["id"]), "provider:consistency:"+providerSeed)

		models := asSlice(pm["models"])
		for mi, mItem := range models {
			mm := asMap(mItem)
			modelRef := pickFirstString(mm["modelId"], mm["id"], mm["name"], mm["displayName"], util.NewUUID())
			mm["id"] = ensureUUID(pickFirstString(mm["id"]), "model:consistency:"+pickFirstString(pm["id"])+":"+modelRef)
			if pickFirstString(mm["modelId"]) == "" {
				mm["modelId"] = modelRef
			}
			if pickFirstString(mm["displayName"]) == "" {
				mm["displayName"] = pickFirstString(mm["name"], mm["modelId"])
			}
			mm["type"] = normalizeRikkaModelType(mm["type"])

			id := pickFirstString(mm["id"])
			if id != "" {
				modelIDs[id] = struct{}{}
				if firstModelID == "" {
					firstModelID = id
				}
			}
			models[mi] = mm
		}
		pm["models"] = models
		providers[pi] = pm
	}
	settings["providers"] = providers

	assistants := asSlice(settings["assistants"])
	assistantIDs := map[string]struct{}{}
	firstAssistantID := ""
	for i, item := range assistants {
		am := asMap(item)
		assistantSeed := pickFirstString(am["id"], am["name"], util.NewUUID())
		id := ensureUUID(pickFirstString(am["id"]), "assistant:consistency:"+assistantSeed)
		am["id"] = id
		if am["name"] == nil || str(am["name"]) == "" {
			am["name"] = "Imported Assistant"
		}
		if chatModel := pickFirstString(am["chatModelId"]); chatModel != "" {
			if _, ok := modelIDs[chatModel]; !ok {
				if firstModelID != "" {
					am["chatModelId"] = firstModelID
				} else {
					delete(am, "chatModelId")
				}
			}
		} else if firstModelID != "" {
			am["chatModelId"] = firstModelID
		}
		assistants[i] = am
		assistantIDs[id] = struct{}{}
		if firstAssistantID == "" {
			firstAssistantID = id
		}
	}
	settings["assistants"] = assistants

	if len(assistantIDs) > 0 {
		assistantID := ensureUUID(pickFirstString(settings["assistantId"]), "assistant:selected:"+pickFirstString(settings["assistantId"]))
		if _, ok := assistantIDs[assistantID]; !ok {
			settings["assistantId"] = firstAssistantID
			warnings = append(warnings, "selected assistant not found, fallback to first assistant")
		} else {
			settings["assistantId"] = assistantID
		}
	} else {
		settings["assistantId"] = defaultAssistantID
	}

	for _, key := range []string{"chatModelId", "titleModelId", "translateModeId", "suggestionModelId", "imageGenerationModelId"} {
		id := pickFirstString(settings[key])
		if id == "" {
			if firstModelID != "" {
				settings[key] = firstModelID
			}
			continue
		}
		if _, ok := modelIDs[id]; !ok {
			if firstModelID != "" {
				settings[key] = firstModelID
			}
			warnings = appendUnique(warnings, "selected model "+key+" not found in providers")
		}
	}

	return warnings
}

func resolveModelID(value any, alias map[string]string) string {
	resolveByString := func(s string) string {
		s = strings.TrimSpace(s)
		if s == "" {
			return ""
		}
		if isValidUUID(s) {
			return s
		}
		if v, ok := alias[s]; ok && v != "" {
			return v
		}
		low := strings.ToLower(s)
		if v, ok := alias[low]; ok && v != "" {
			return v
		}
		return ""
	}

	if id := resolveByString(pickFirstString(value)); id != "" {
		return id
	}

	m := asMap(value)
	if len(m) == 0 {
		return ""
	}
	for _, key := range []string{"id", "modelId", "name", "displayName"} {
		if id := resolveByString(pickFirstString(m[key])); id != "" {
			return id
		}
	}
	return ""
}

func ensureUUID(candidate, seed string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate != "" {
		if _, err := guuid.Parse(candidate); err == nil {
			return candidate
		}
	}
	if strings.TrimSpace(seed) == "" {
		seed = util.NewUUID()
	}
	return guuid.NewSHA1(guuid.NameSpaceOID, []byte(seed)).String()
}

func isValidUUID(v string) bool {
	_, err := guuid.Parse(strings.TrimSpace(v))
	return err == nil
}

func registerModelAlias(alias map[string]string, key, value string) {
	key = strings.TrimSpace(key)
	value = strings.TrimSpace(value)
	if key == "" || value == "" {
		return
	}
	if _, ok := alias[key]; !ok {
		alias[key] = value
	}
	low := strings.ToLower(key)
	if _, ok := alias[low]; !ok {
		alias[low] = value
	}
}

func sanitizeAssistantUUIDListField(raw map[string]any, key string, warnings *[]string) {
	if _, ok := raw[key]; !ok {
		return
	}
	items := asSlice(raw[key])
	if len(items) == 0 {
		delete(raw, key)
		return
	}
	kept := make([]any, 0, len(items))
	for _, item := range items {
		id := pickFirstString(item)
		if id == "" {
			m := asMap(item)
			id = pickFirstString(m["id"], m["uuid"])
		}
		if isValidUUID(id) {
			kept = append(kept, id)
		}
	}
	if len(kept) == 0 {
		delete(raw, key)
		*warnings = appendUnique(*warnings, "dropped non-uuid assistant field: "+key)
		return
	}
	raw[key] = kept
}

func assignUniqueAssistantName(raw map[string]any, used map[string]struct{}, warnings *[]string) {
	base := strings.TrimSpace(str(raw["name"]))
	if base == "" {
		base = "Imported Assistant"
	}
	name := base
	suffix := 2
	for {
		key := strings.ToLower(strings.TrimSpace(name))
		if _, exists := used[key]; !exists {
			used[key] = struct{}{}
			break
		}
		name = fmt.Sprintf("%s (%d)", base, suffix)
		suffix++
	}
	raw["name"] = name
	if name != base {
		*warnings = appendUnique(*warnings, "assistant name conflict renamed: "+base+" -> "+name)
	}
}

func coerceBool(v any) (bool, bool) {
	switch t := v.(type) {
	case bool:
		return t, true
	case string:
		parsed, err := strconv.ParseBool(strings.TrimSpace(t))
		if err == nil {
			return parsed, true
		}
	}
	return false, false
}

func coerceInt(v any) (int64, bool) {
	switch t := v.(type) {
	case int:
		return int64(t), true
	case int8:
		return int64(t), true
	case int16:
		return int64(t), true
	case int32:
		return int64(t), true
	case int64:
		return t, true
	case float32:
		return int64(t), true
	case float64:
		return int64(t), true
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		if err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func coerceFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float32:
		return float64(t), true
	case float64:
		return t, true
	case int:
		return float64(t), true
	case int8:
		return float64(t), true
	case int16:
		return float64(t), true
	case int32:
		return float64(t), true
	case int64:
		return float64(t), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func normalizeRikkaModelType(v any) string {
	switch strings.ToUpper(strings.TrimSpace(pickFirstString(v))) {
	case "IMAGE":
		return "IMAGE"
	case "EMBEDDING":
		return "EMBEDDING"
	default:
		return "CHAT"
	}
}

func normalizeModelModalities(v any) []any {
	out := []any{}
	seen := map[string]struct{}{}
	for _, item := range asSlice(v) {
		val := strings.ToUpper(strings.TrimSpace(pickFirstString(item)))
		if val != "TEXT" && val != "IMAGE" {
			continue
		}
		if _, exists := seen[val]; exists {
			continue
		}
		seen[val] = struct{}{}
		out = append(out, val)
	}
	return out
}

func normalizeModelAbilities(v any) []any {
	out := []any{}
	seen := map[string]struct{}{}
	for _, item := range asSlice(v) {
		val := strings.ToUpper(strings.TrimSpace(pickFirstString(item)))
		if val != "TOOL" && val != "REASONING" {
			continue
		}
		if _, exists := seen[val]; exists {
			continue
		}
		seen[val] = struct{}{}
		out = append(out, val)
	}
	return out
}

func normalizeModelTools(v any) []any {
	out := []any{}
	seen := map[string]struct{}{}
	for _, item := range asSlice(v) {
		val := strings.TrimSpace(pickFirstString(item))
		switch strings.ToLower(val) {
		case "search":
			val = "search"
		case "url_context":
			val = "url_context"
		default:
			continue
		}
		if _, exists := seen[val]; exists {
			continue
		}
		seen[val] = struct{}{}
		out = append(out, val)
	}
	return out
}

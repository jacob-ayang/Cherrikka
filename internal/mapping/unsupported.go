package mapping

import "strings"

// ExtractRikkaUnsupportedSettings isolates Rikka-specific fields that are not
// mapped cross-app in V1.1 but should be preserved for sidecar rehydration.
func ExtractRikkaUnsupportedSettings(settings map[string]any) map[string]any {
	if len(settings) == 0 {
		return nil
	}
	out := map[string]any{}

	topLevelKeys := []string{
		"modeInjections",
		"lorebooks",
		"memoryEntities",
		"memories",
	}
	for _, key := range topLevelKeys {
		if v, ok := settings[key]; ok && isMeaningfulUnsupported(v) {
			out[key] = cloneAny(v)
		}
	}

	assistantKeys := []string{
		"modeInjectionIds",
		"lorebookIds",
		"enableMemory",
		"useGlobalMemory",
		"regexes",
		"localTools",
	}
	assistantsOut := []any{}
	for _, item := range asSlice(settings["assistants"]) {
		assistant := asMap(item)
		if len(assistant) == 0 {
			continue
		}
		entry := map[string]any{}
		if id := pickFirstString(assistant["id"]); id != "" {
			entry["id"] = id
		}
		if name := pickFirstString(assistant["name"]); name != "" {
			entry["name"] = name
		}
		for _, key := range assistantKeys {
			if v, ok := assistant[key]; ok && isMeaningfulUnsupported(v) {
				entry[key] = cloneAny(v)
			}
		}
		if len(entry) > 0 {
			assistantsOut = append(assistantsOut, entry)
		}
	}
	if len(assistantsOut) > 0 {
		out["assistants"] = assistantsOut
	}

	if len(out) == 0 {
		return nil
	}
	return out
}

// ExtractCherryUnsupportedSettings isolates Cherry-specific fields that are not
// mapped cross-app in V1.1 but should be preserved for sidecar rehydration.
func ExtractCherryUnsupportedSettings(config map[string]any) map[string]any {
	if len(config) == 0 {
		return nil
	}
	out := map[string]any{}

	if settings := asMap(config["cherry.settings"]); len(settings) > 0 {
		mem := map[string]any{}
		for k, v := range settings {
			if strings.Contains(strings.ToLower(strings.TrimSpace(k)), "memory") && isMeaningfulUnsupported(v) {
				mem[k] = cloneAny(v)
			}
		}
		if len(mem) > 0 {
			out["settings"] = mem
		}
	}

	if persist := asMap(config["cherry.persistSlices"]); len(persist) > 0 {
		mem := map[string]any{}
		for k, v := range persist {
			if strings.Contains(strings.ToLower(strings.TrimSpace(k)), "memory") && isMeaningfulUnsupported(v) {
				mem[k] = cloneAny(v)
			}
		}
		if len(mem) > 0 {
			out["persistSlices"] = mem
		}
	}

	if len(out) == 0 {
		return nil
	}
	return out
}

func isMeaningfulUnsupported(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(t) != ""
	case bool:
		return t
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	default:
		return true
	}
}

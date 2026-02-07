package mapping

import (
	"strings"

	"cherrikka/internal/ir"
	"cherrikka/internal/util"
)

const (
	defaultAssistantID = "0950e2dc-9bd5-4801-afa3-aa887aa36b4e"
)

func EnsureNormalizedSettings(in *ir.BackupIR) []string {
	if in == nil {
		return nil
	}
	if len(in.Settings) > 0 {
		return nil
	}
	settings, warnings := normalizeFromSource(in)
	in.Settings = settings
	if len(warnings) > 0 {
		in.Warnings = append(in.Warnings, warnings...)
	}
	return warnings
}

func normalizeFromSource(in *ir.BackupIR) (map[string]any, []string) {
	switch strings.ToLower(strings.TrimSpace(in.SourceFormat)) {
	case "cherry":
		return NormalizeFromCherryConfig(in.Config)
	case "rikka":
		return NormalizeFromRikkaConfig(in.Config)
	default:
		return defaultNormalizedSettings(), nil
	}
}

func defaultNormalizedSettings() map[string]any {
	return map[string]any{
		"core.providers":    []any{},
		"core.models":       map[string]any{},
		"core.assistants":   []any{},
		"core.selection":    map[string]any{},
		"sync.webdav":       map[string]any{},
		"sync.s3":           map[string]any{},
		"sync.local":        map[string]any{},
		"ui.profile":        map[string]any{},
		"search":            map[string]any{},
		"mcp":               map[string]any{},
		"tts":               map[string]any{},
		"raw.cherry":        map[string]any{},
		"raw.rikka":         map[string]any{},
		"raw.unsupported":   []any{},
		"normalizer.ver":    1,
		"normalizer.source": "",
	}
}

func cloneMap(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = cloneAny(v)
	}
	return out
}

func cloneSlice(in []any) []any {
	if in == nil {
		return nil
	}
	out := make([]any, len(in))
	for i, v := range in {
		out[i] = cloneAny(v)
	}
	return out
}

func cloneAny(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return cloneMap(t)
	case []any:
		return cloneSlice(t)
	default:
		return t
	}
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	if s == nil {
		return []any{}
	}
	return s
}

func str(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func boolVal(v any) (bool, bool) {
	b, ok := v.(bool)
	return b, ok
}

func pickFirstString(values ...any) string {
	for _, v := range values {
		if s := str(v); s != "" {
			return s
		}
	}
	return ""
}

func setIfPresent(dst map[string]any, key string, val any) {
	switch t := val.(type) {
	case nil:
		return
	case string:
		if strings.TrimSpace(t) == "" {
			return
		}
	case map[string]any:
		if len(t) == 0 {
			return
		}
	case []any:
		if len(t) == 0 {
			return
		}
	}
	dst[key] = val
}

func mergeMissing(dst, src map[string]any) {
	if src == nil {
		return
	}
	for k, v := range src {
		if _, ok := dst[k]; ok {
			continue
		}
		dst[k] = cloneAny(v)
	}
}

func mergeOverlay(dst, src map[string]any) {
	if src == nil {
		return
	}
	for k, v := range src {
		dst[k] = cloneAny(v)
	}
}

func appendUnique(list []string, items ...string) []string {
	set := make(map[string]struct{}, len(list))
	for _, v := range list {
		if strings.TrimSpace(v) == "" {
			continue
		}
		set[v] = struct{}{}
	}
	for _, v := range items {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if _, ok := set[v]; ok {
			continue
		}
		set[v] = struct{}{}
		list = append(list, v)
	}
	return list
}

func cherryProviderToCanonical(providerType string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(providerType)) {
	case "openai", "openai-response", "new-api", "gateway", "azure-openai", "ollama", "lmstudio", "gpustack", "aws-bedrock":
		return "openai", true
	case "anthropic", "vertex-anthropic":
		return "claude", true
	case "gemini", "vertexai":
		return "google", true
	default:
		return "", false
	}
}

func rikkaProviderToCanonical(providerType string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(providerType)) {
	case "openai":
		return "openai", true
	case "claude":
		return "claude", true
	case "google":
		return "google", true
	default:
		return "", false
	}
}

func canonicalToRikkaType(mappedType string) string {
	switch strings.ToLower(strings.TrimSpace(mappedType)) {
	case "openai":
		return "openai"
	case "claude":
		return "claude"
	case "google":
		return "google"
	default:
		return ""
	}
}

func canonicalToCherryType(mappedType, sourceType string) string {
	if strings.TrimSpace(sourceType) != "" {
		if sourceMapped, ok := cherryProviderToCanonical(sourceType); ok {
			if strings.TrimSpace(mappedType) == "" || sourceMapped == mappedType {
				return sourceType
			}
		}
	}
	switch strings.ToLower(strings.TrimSpace(mappedType)) {
	case "openai":
		return "openai"
	case "claude":
		return "anthropic"
	case "google":
		return "gemini"
	default:
		return ""
	}
}

func ensureID(m map[string]any) string {
	id := pickFirstString(m["id"], m["uuid"])
	if id == "" {
		id = util.NewUUID()
		m["id"] = id
	}
	return id
}

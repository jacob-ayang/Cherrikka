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

	coreModels := asMap(norm["core.models"])
	for _, key := range []string{"defaultModel", "quickModel", "translateModel", "topicNamingModel"} {
		if model := asMap(coreModels[key]); len(model) > 0 {
			llm[key] = cloneMap(model)
		}
	}

	cherryProviders := buildCherryProviders(asSlice(norm["core.providers"]), &warnings)
	if len(cherryProviders) > 0 {
		llm["providers"] = cherryProviders
	}

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

func buildCherryProviders(coreProviders []any, warnings *[]string) []any {
	out := make([]any, 0, len(coreProviders))
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
		if raw["id"] == nil || str(raw["id"]) == "" {
			raw["id"] = pickFirstString(pm["id"], util.NewUUID())
		}
		if raw["name"] == nil || str(raw["name"]) == "" {
			raw["name"] = pickFirstString(pm["name"], strings.ToUpper(mapped))
		}
		raw["type"] = cherryType
		if _, ok := raw["models"]; !ok {
			raw["models"] = []any{}
		}
		if pickFirstString(raw["apiHost"]) == "" {
			if baseURL := pickFirstString(raw["baseUrl"]); baseURL != "" {
				raw["apiHost"] = baseURL
			}
		}
		out = append(out, raw)
	}
	return out
}

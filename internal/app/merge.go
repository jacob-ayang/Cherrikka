package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	guuid "github.com/google/uuid"

	"cherrikka/internal/ir"
)

type MergedSourceMeta struct {
	Index      int
	Name       string
	SourceApp  string
	Format     string
	SHA256     string
	Hints      []string
	LatestUnix int64
}

type MergeOptions struct {
	TargetFormat      string
	ConfigPrecedence  string
	ConfigSourceIndex int
}

type MergeReport struct {
	PrimarySourceIndex int
	Sources            []MergedSourceMeta
	Warnings           []string
}

type parsedSource struct {
	Index       int
	Tag         string
	Path        string
	Name        string
	Format      string
	Hints       []string
	SHA256      string
	LatestUnix  int64
	SourceBytes []byte
	IR          *ir.BackupIR
}

func mergeSources(sources []parsedSource, opts MergeOptions) (*ir.BackupIR, *MergeReport, error) {
	if len(sources) == 0 {
		return nil, nil, fmt.Errorf("no input sources")
	}
	primary, err := choosePrimarySourceIndex(sources, opts)
	if err != nil {
		return nil, nil, err
	}

	report := &MergeReport{
		PrimarySourceIndex: primary + 1,
		Sources:            make([]MergedSourceMeta, 0, len(sources)),
	}
	for _, src := range sources {
		report.Sources = append(report.Sources, MergedSourceMeta{
			Index:      src.Index,
			Name:       src.Name,
			SourceApp:  src.IR.SourceApp,
			Format:     src.Format,
			SHA256:     src.SHA256,
			Hints:      cloneStringSlice(src.Hints),
			LatestUnix: src.LatestUnix,
		})
	}

	if len(sources) == 1 {
		return sources[0].IR, report, nil
	}

	primaryIR := sources[primary].IR
	merged := &ir.BackupIR{
		SourceApp:     primaryIR.SourceApp,
		SourceFormat:  primaryIR.SourceFormat,
		TargetFormat:  strings.ToLower(strings.TrimSpace(opts.TargetFormat)),
		CreatedAt:     time.Now().UTC(),
		Assistants:    []ir.IRAssistant{},
		Conversations: []ir.IRConversation{},
		Files:         []ir.IRFile{},
		Config:        cloneMapAny(primaryIR.Config),
		Settings:      mergeSettingsFromSources(sources, primary),
		Opaque:        map[string]any{},
		Secrets:       map[string]string{},
		Warnings:      []string{},
	}

	mergeWarnings := []string{fmt.Sprintf("multi-source-merge:count=%d", len(sources))}
	opaqueSources := map[string]any{}

	assistantBySource := map[int]map[string]string{}
	defaultAssistantBySource := map[int]string{}
	usedAssistantNames := map[string]struct{}{}
	usedAssistantIDs := map[string]struct{}{}

	for _, src := range sources {
		assistantBySource[src.Index] = map[string]string{}
		for _, assistant := range src.IR.Assistants {
			cloned := cloneAssistant(assistant)
			oldID := strings.TrimSpace(cloned.ID)
			if oldID == "" {
				oldID = deterministicUUID("", fmt.Sprintf("merge:%s:assistant:missing:%s", src.Tag, cloned.Name))
			}
			newID := deterministicUUID("", fmt.Sprintf("merge:%s:assistant:%s:%s", src.Tag, oldID, cloned.Name))
			if _, exists := usedAssistantIDs[newID]; exists {
				newID = deterministicUUID("", fmt.Sprintf("merge:%s:assistant:%s:%s:dup", src.Tag, oldID, cloned.Name))
			}
			usedAssistantIDs[newID] = struct{}{}
			assistantBySource[src.Index][oldID] = newID
			if strings.TrimSpace(cloned.ID) != "" {
				assistantBySource[src.Index][strings.TrimSpace(cloned.ID)] = newID
			}
			cloned.ID = newID

			originalName := strings.TrimSpace(cloned.Name)
			if originalName == "" {
				originalName = "Imported Assistant"
			}
			cloned.Name = originalName
			nameKey := strings.ToLower(cloned.Name)
			if _, exists := usedAssistantNames[nameKey]; exists {
				cloned.Name = uniqueAssistantName(cloned.Name, src.Tag, usedAssistantNames)
				mergeWarnings = append(mergeWarnings, fmt.Sprintf("merge-assistant-renamed:%s:%s", originalName, cloned.Name))
			} else {
				usedAssistantNames[nameKey] = struct{}{}
			}
			merged.Assistants = append(merged.Assistants, cloned)
			if defaultAssistantBySource[src.Index] == "" {
				defaultAssistantBySource[src.Index] = cloned.ID
			}
		}

		opaqueSources[src.Tag] = map[string]any{
			"name":         src.Name,
			"sourceApp":    src.IR.SourceApp,
			"sourceFormat": src.IR.SourceFormat,
			"opaque":       cloneMapAny(src.IR.Opaque),
		}
		mergeWarnings = append(mergeWarnings, src.IR.Warnings...)
	}

	fileBySource := map[int]map[string]string{}
	usedRelPath := map[string]struct{}{}
	usedCherryStem := map[string]struct{}{}
	for _, src := range sources {
		fileBySource[src.Index] = map[string]string{}
		for _, file := range src.IR.Files {
			cloned := cloneFile(file)
			oldID := strings.TrimSpace(cloned.ID)
			if oldID == "" {
				oldID = deterministicUUID("", fmt.Sprintf("merge:%s:file:missing:%s", src.Tag, cloned.Name))
			}
			newID := deterministicUUID("", fmt.Sprintf("merge:%s:file:%s:%s:%s", src.Tag, oldID, cloned.Name, cloned.HashSHA256))
			fileBySource[src.Index][oldID] = newID
			cloned.ID = newID
			if cloned.Metadata == nil {
				cloned.Metadata = map[string]any{}
			}
			cloned.Metadata["merge.source"] = src.Tag

			if merged.TargetFormat == "rikka" {
				rel := normalizeMergeRelPath(cloned)
				if rel == "" {
					rel = filepath.ToSlash(filepath.Join("upload", deterministicFileName(newID, cloned.Ext)))
				}
				uniqueRel := rel
				if _, exists := usedRelPath[uniqueRel]; exists {
					uniqueRel = filepath.ToSlash(filepath.Join("upload", deterministicFileName(newID+"-collision", cloned.Ext)))
					mergeWarnings = append(mergeWarnings, fmt.Sprintf("merge-file-path-collision:%s:%s", rel, uniqueRel))
				}
				usedRelPath[uniqueRel] = struct{}{}
				cloned.RelativeSrc = uniqueRel
				cloned.Metadata["rikka.relative_path"] = uniqueRel
			} else {
				stem := normalizeCherryStem(cloned)
				if stem == "" {
					stem = strings.ReplaceAll(newID, "-", "")
				}
				uniqueStem := stem
				if _, exists := usedCherryStem[strings.ToLower(uniqueStem)]; exists {
					uniqueStem = strings.ReplaceAll(deterministicUUID("", "merge:cherry:"+stem+":"+newID), "-", "")
					mergeWarnings = append(mergeWarnings, fmt.Sprintf("merge-file-path-collision:%s:%s", stem, uniqueStem))
				}
				usedCherryStem[strings.ToLower(uniqueStem)] = struct{}{}
				cloned.Metadata["cherry_id"] = uniqueStem
			}
			merged.Files = append(merged.Files, cloned)
		}
	}

	usedConversationIDs := map[string]struct{}{}
	for _, src := range sources {
		sourceAssistantMap := assistantBySource[src.Index]
		sourceFileMap := fileBySource[src.Index]
		for _, conv := range src.IR.Conversations {
			clonedConv := cloneConversation(conv)
			oldID := strings.TrimSpace(clonedConv.ID)
			if oldID == "" {
				oldID = deterministicUUID("", fmt.Sprintf("merge:%s:conversation:missing:%s", src.Tag, clonedConv.Title))
			}
			newConvID := deterministicUUID("", fmt.Sprintf("merge:%s:conversation:%s:%s", src.Tag, oldID, clonedConv.Title))
			if _, exists := usedConversationIDs[newConvID]; exists {
				newConvID = deterministicUUID("", fmt.Sprintf("merge:%s:conversation:%s:%s:dup", src.Tag, oldID, clonedConv.Title))
			}
			usedConversationIDs[newConvID] = struct{}{}
			clonedConv.ID = newConvID

			if remapped, ok := sourceAssistantMap[strings.TrimSpace(conv.AssistantID)]; ok && remapped != "" {
				clonedConv.AssistantID = remapped
			} else if fallback := defaultAssistantBySource[src.Index]; fallback != "" {
				clonedConv.AssistantID = fallback
				mergeWarnings = append(mergeWarnings, fmt.Sprintf("merge-conversation-rebound:%s:%s", src.Tag, oldID))
			} else if len(merged.Assistants) > 0 {
				clonedConv.AssistantID = merged.Assistants[0].ID
				mergeWarnings = append(mergeWarnings, fmt.Sprintf("merge-conversation-rebound:%s:%s", src.Tag, oldID))
			}

			for mi, msg := range clonedConv.Messages {
				oldMsgID := strings.TrimSpace(msg.ID)
				if oldMsgID == "" {
					oldMsgID = deterministicUUID("", fmt.Sprintf("merge:%s:conversation:%s:message:%d", src.Tag, oldID, mi))
				}
				msg.ID = deterministicUUID("", fmt.Sprintf("merge:%s:conversation:%s:message:%s:%d", src.Tag, oldID, oldMsgID, mi))
				msg.Parts = remapMessageParts(msg.Parts, sourceFileMap, &mergeWarnings)
				clonedConv.Messages[mi] = msg
			}
			merged.Conversations = append(merged.Conversations, clonedConv)
		}
	}

	merged.Settings["core.assistants"] = buildCoreAssistants(merged.Assistants)
	selection := asMap(merged.Settings["core.selection"])
	if len(selection) == 0 {
		selection = map[string]any{}
	}
	if primaryDefault := defaultAssistantBySource[sources[primary].Index]; primaryDefault != "" {
		selection["assistantId"] = primaryDefault
	}
	merged.Settings["core.selection"] = selection

	if merged.Opaque == nil {
		merged.Opaque = map[string]any{}
	}
	merged.Opaque["opaque.merge.sources"] = opaqueSources
	merged.Warnings = dedupeStrings(append(append([]string{}, merged.Warnings...), mergeWarnings...))
	report.Warnings = dedupeStrings(mergeWarnings)
	return merged, report, nil
}

func choosePrimarySourceIndex(sources []parsedSource, opts MergeOptions) (int, error) {
	if len(sources) == 0 {
		return 0, fmt.Errorf("no sources")
	}
	mode := strings.ToLower(strings.TrimSpace(opts.ConfigPrecedence))
	if mode == "" {
		mode = "latest"
	}
	switch mode {
	case "latest":
		best := 0
		for i := 1; i < len(sources); i++ {
			if sources[i].LatestUnix > sources[best].LatestUnix {
				best = i
			}
		}
		return best, nil
	case "first":
		return 0, nil
	case "target":
		target := strings.ToLower(strings.TrimSpace(opts.TargetFormat))
		for i := range sources {
			if strings.EqualFold(strings.TrimSpace(sources[i].Format), target) {
				return i, nil
			}
		}
		return choosePrimarySourceIndex(sources, MergeOptions{ConfigPrecedence: "latest"})
	case "source":
		if opts.ConfigSourceIndex <= 0 || opts.ConfigSourceIndex > len(sources) {
			return 0, fmt.Errorf("--config-source-index must be within 1..%d when --config-precedence=source", len(sources))
		}
		return opts.ConfigSourceIndex - 1, nil
	default:
		return 0, fmt.Errorf("--config-precedence must be latest|first|target|source")
	}
}

func inferLatestUnixMillis(sourcePath string, data *ir.BackupIR) int64 {
	best := int64(0)
	parse := func(raw string) {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return
		}
		if t, err := time.Parse(time.RFC3339, raw); err == nil && t.UnixMilli() > best {
			best = t.UnixMilli()
		}
	}
	for _, conv := range data.Conversations {
		parse(conv.UpdatedAt)
		parse(conv.CreatedAt)
		for _, msg := range conv.Messages {
			parse(msg.CreatedAt)
		}
	}
	if best > 0 {
		return best
	}
	if st, err := os.Stat(sourcePath); err == nil {
		return st.ModTime().UTC().UnixMilli()
	}
	return time.Now().UTC().UnixMilli()
}

func mergeSettingsFromSources(sources []parsedSource, primary int) map[string]any {
	if len(sources) == 0 {
		return map[string]any{}
	}
	out := cloneMapAny(sources[primary].IR.Settings)
	if len(out) == 0 {
		out = map[string]any{}
	}
	appendListBySignature(out, "core.providers", asSlice(out["core.providers"]))
	appendListBySignature(out, "core.assistants", asSlice(out["core.assistants"]))

	for i, src := range sources {
		if i == primary {
			continue
		}
		other := src.IR.Settings
		appendListBySignature(out, "core.providers", asSlice(other["core.providers"]))
		appendListBySignature(out, "core.assistants", asSlice(other["core.assistants"]))
		appendListBySignature(out, "raw.unsupported", asSlice(other["raw.unsupported"]))
		mergeMapMissing(out, "raw.cherry", asMap(other["raw.cherry"]))
		mergeMapMissing(out, "raw.rikka", asMap(other["raw.rikka"]))
	}
	return out
}

func appendListBySignature(dst map[string]any, key string, incoming []any) {
	current := asSlice(dst[key])
	seen := map[string]struct{}{}
	for _, item := range current {
		seen[itemSignature(item)] = struct{}{}
	}
	for _, item := range incoming {
		sig := itemSignature(item)
		if _, exists := seen[sig]; exists {
			continue
		}
		seen[sig] = struct{}{}
		current = append(current, cloneAny(item))
	}
	dst[key] = current
}

func itemSignature(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}

func mergeMapMissing(dst map[string]any, key string, incoming map[string]any) {
	if len(incoming) == 0 {
		return
	}
	base := asMap(dst[key])
	if len(base) == 0 {
		base = map[string]any{}
	}
	for k, v := range incoming {
		if _, exists := base[k]; exists {
			continue
		}
		base[k] = cloneAny(v)
	}
	dst[key] = base
}

func buildCoreAssistants(assistants []ir.IRAssistant) []any {
	out := make([]any, 0, len(assistants))
	for _, assistant := range assistants {
		item := map[string]any{
			"id":           assistant.ID,
			"name":         assistant.Name,
			"systemPrompt": assistant.Prompt,
		}
		if modelID := pickModelID(assistant.Model); modelID != "" {
			item["chatModelId"] = modelID
		}
		if temp, ok := assistant.Settings["temperature"]; ok {
			item["temperature"] = temp
		}
		if topP, ok := assistant.Settings["topP"]; ok {
			item["topP"] = topP
		}
		if context, ok := assistant.Settings["contextCount"]; ok {
			item["context"] = context
		}
		if stream, ok := assistant.Settings["streamOutput"]; ok {
			item["stream"] = stream
		}
		if maxTokens, ok := assistant.Settings["maxTokens"]; ok {
			item["maxTokens"] = maxTokens
		}
		out = append(out, item)
	}
	return out
}

func pickModelID(model map[string]any) string {
	candidates := []string{
		str(model["chatModelId"]),
		str(model["modelId"]),
		str(model["id"]),
		str(model["name"]),
	}
	for _, candidate := range candidates {
		if strings.TrimSpace(candidate) != "" {
			return strings.TrimSpace(candidate)
		}
	}
	return ""
}

func remapMessageParts(parts []ir.IRPart, fileMap map[string]string, warnings *[]string) []ir.IRPart {
	out := make([]ir.IRPart, 0, len(parts))
	for _, part := range parts {
		cloned := clonePart(part)
		if original := strings.TrimSpace(part.FileID); original != "" {
			if mapped := strings.TrimSpace(fileMap[original]); mapped != "" {
				cloned.FileID = mapped
			} else {
				*warnings = append(*warnings, "merge-file-reference-missing:"+original)
			}
		}
		if len(cloned.Output) > 0 {
			cloned.Output = remapMessageParts(cloned.Output, fileMap, warnings)
		}
		out = append(out, cloned)
	}
	return out
}

func normalizeMergeRelPath(file ir.IRFile) string {
	meta := asMap(file.Metadata)
	for _, candidate := range []string{
		str(meta["rikka.relative_path"]),
		str(file.RelativeSrc),
	} {
		candidate = filepath.ToSlash(strings.TrimSpace(candidate))
		if candidate == "" {
			continue
		}
		if strings.HasPrefix(candidate, "upload/") {
			return candidate
		}
		base := filepath.Base(candidate)
		if base != "." && base != "/" && base != "" {
			return filepath.ToSlash(filepath.Join("upload", base))
		}
	}
	name := strings.TrimSpace(file.Name)
	if name == "" {
		name = strings.TrimSpace(file.ID) + strings.TrimSpace(file.Ext)
	}
	if name == "" {
		name = deterministicFileName(file.ID, file.Ext)
	}
	return filepath.ToSlash(filepath.Join("upload", filepath.Base(name)))
}

func deterministicFileName(seed, ext string) string {
	ext = strings.TrimSpace(ext)
	if ext != "" && !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}
	id := strings.ReplaceAll(deterministicUUID("", "merge:file:"+seed), "-", "")
	return id + ext
}

func normalizeCherryStem(file ir.IRFile) string {
	meta := asMap(file.Metadata)
	candidate := strings.TrimSpace(str(meta["cherry_id"]))
	if candidate == "" {
		candidate = strings.TrimSpace(file.ID)
	}
	candidate = strings.ReplaceAll(candidate, "-", "")
	candidate = strings.ReplaceAll(candidate, " ", "_")
	candidate = strings.Trim(candidate, "._/")
	if candidate == "" {
		return ""
	}
	return candidate
}

func uniqueAssistantName(base, tag string, used map[string]struct{}) string {
	trimmed := strings.TrimSpace(base)
	if trimmed == "" {
		trimmed = "Imported Assistant"
	}
	candidate := fmt.Sprintf("%s (%s)", trimmed, tag)
	if _, exists := used[strings.ToLower(candidate)]; !exists {
		used[strings.ToLower(candidate)] = struct{}{}
		return candidate
	}
	for i := 2; ; i++ {
		alt := fmt.Sprintf("%s (%s-%d)", trimmed, tag, i)
		if _, exists := used[strings.ToLower(alt)]; exists {
			continue
		}
		used[strings.ToLower(alt)] = struct{}{}
		return alt
	}
}

func deterministicUUID(candidate, seed string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate != "" {
		if _, err := guuid.Parse(candidate); err == nil {
			return candidate
		}
	}
	if strings.TrimSpace(seed) == "" {
		seed = strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return guuid.NewSHA1(guuid.NameSpaceOID, []byte(seed)).String()
}

func cloneAssistant(in ir.IRAssistant) ir.IRAssistant {
	out := in
	out.Model = cloneMapAny(in.Model)
	out.Settings = cloneMapAny(in.Settings)
	out.Opaque = cloneMapAny(in.Opaque)
	return out
}

func cloneConversation(in ir.IRConversation) ir.IRConversation {
	out := in
	out.Messages = make([]ir.IRMessage, 0, len(in.Messages))
	for _, msg := range in.Messages {
		out.Messages = append(out.Messages, cloneMessage(msg))
	}
	out.Opaque = cloneMapAny(in.Opaque)
	return out
}

func cloneMessage(in ir.IRMessage) ir.IRMessage {
	out := in
	out.Parts = make([]ir.IRPart, 0, len(in.Parts))
	for _, part := range in.Parts {
		out.Parts = append(out.Parts, clonePart(part))
	}
	out.Opaque = cloneMapAny(in.Opaque)
	return out
}

func clonePart(in ir.IRPart) ir.IRPart {
	out := in
	out.Output = make([]ir.IRPart, 0, len(in.Output))
	for _, child := range in.Output {
		out.Output = append(out.Output, clonePart(child))
	}
	out.Metadata = cloneMapAny(in.Metadata)
	return out
}

func cloneFile(in ir.IRFile) ir.IRFile {
	out := in
	out.Metadata = cloneMapAny(in.Metadata)
	return out
}

func cloneMapAny(in map[string]any) map[string]any {
	if len(in) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = cloneAny(v)
	}
	return out
}

func cloneSliceAny(in []any) []any {
	if len(in) == 0 {
		return []any{}
	}
	out := make([]any, 0, len(in))
	for _, item := range in {
		out = append(out, cloneAny(item))
	}
	return out
}

func cloneAny(v any) any {
	switch typed := v.(type) {
	case map[string]any:
		return cloneMapAny(typed)
	case []any:
		return cloneSliceAny(typed)
	default:
		return typed
	}
}

func cloneStringSlice(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, 0, len(in))
	for _, item := range in {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

func str(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

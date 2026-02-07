package cherry

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	guuid "github.com/google/uuid"

	"cherrikka/internal/ir"
	"cherrikka/internal/mapping"
	"cherrikka/internal/util"
)

func ParseToIR(extractedDir string) (*ir.BackupIR, error) {
	dataPath := filepath.Join(extractedDir, "data.json")
	b, err := os.ReadFile(dataPath)
	if err != nil {
		return nil, err
	}

	var root map[string]json.RawMessage
	if err := json.Unmarshal(b, &root); err != nil {
		return nil, fmt.Errorf("parse data.json: %w", err)
	}

	res := &ir.BackupIR{
		SourceApp:    "cherry-studio",
		SourceFormat: "cherry",
		CreatedAt:    time.Now().UTC(),
		Config:       map[string]any{},
		Settings:     map[string]any{},
		Opaque:       map[string]any{},
		Secrets:      map[string]string{},
	}
	if sidecarExists(extractedDir) {
		res.Opaque["interop.sidecar.available"] = true
	}

	var localStorage map[string]any
	if raw, ok := root["localStorage"]; ok {
		_ = json.Unmarshal(raw, &localStorage)
	} else {
		localStorage = map[string]any{}
	}
	res.Config["cherry.localStorageRaw"] = localStorage

	indexed := map[string]json.RawMessage{}
	if raw, ok := root["indexedDB"]; ok {
		if err := json.Unmarshal(raw, &indexed); err != nil {
			return nil, fmt.Errorf("parse indexedDB: %w", err)
		}
	}

	blocksByID := map[string]map[string]any{}
	if raw, ok := indexed["message_blocks"]; ok {
		var blocks []map[string]any
		if err := json.Unmarshal(raw, &blocks); err == nil {
			for _, block := range blocks {
				id := str(block["id"])
				if id != "" {
					blocksByID[id] = block
				}
			}
		}
	}

	filesByID := map[string]ir.IRFile{}
	if raw, ok := indexed["files"]; ok {
		var files []map[string]any
		if err := json.Unmarshal(raw, &files); err == nil {
			for _, rec := range files {
				id := str(rec["id"])
				if id == "" {
					continue
				}
				name := str(rec["origin_name"])
				if name == "" {
					name = str(rec["name"])
				}
				ext := str(rec["ext"])
				if ext == "" && strings.Contains(name, ".") {
					ext = filepath.Ext(name)
				}
				sourcePath := resolveCherryFilePath(extractedDir, id, ext)
				st, statErr := os.Stat(sourcePath)
				if statErr != nil {
					sourcePath = ""
				}
				file := ir.IRFile{
					ID:          id,
					Name:        name,
					Ext:         ext,
					MimeType:    str(rec["type"]),
					SourcePath:  sourcePath,
					RelativeSrc: toRel(extractedDir, sourcePath),
					CreatedAt:   anyString(rec["created_at"]),
					LogicalType: normalizeLogicalType(str(rec["type"]), ext),
					Missing:     sourcePath == "",
					Metadata:    rec,
				}
				if statErr == nil {
					file.Size = st.Size()
					if hash, err := util.SHA256File(sourcePath); err == nil {
						file.HashSHA256 = hash
					}
				}
				if file.CreatedAt == "" {
					file.CreatedAt = anyString(rec["createdAt"])
				}
				file.Metadata["cherry_id"] = id
				file.Metadata["cherry_ext"] = ext
				filesByID[id] = file
			}
		}
	}

	mergeDataFiles(extractedDir, filesByID)
	for _, f := range sortFiles(filesByID) {
		res.Files = append(res.Files, f)
	}

	explicitTopicAssistant := map[string]bool{}
	messageAssistantByTopic := map[string]string{}
	if raw, ok := indexed["topics"]; ok {
		var topics []map[string]any
		if err := json.Unmarshal(raw, &topics); err != nil {
			return nil, fmt.Errorf("parse indexedDB.topics: %w", err)
		}
		for _, topic := range topics {
			conv := ir.IRConversation{
				ID:       str(topic["id"]),
				Title:    str(topic["name"]),
				Opaque:   map[string]any{},
				Messages: []ir.IRMessage{},
			}
			if conv.ID == "" {
				conv.ID = util.NewUUID()
			}
			msgItems, _ := topic["messages"].([]any)
			for _, item := range msgItems {
				msgMap, ok := item.(map[string]any)
				if !ok {
					continue
				}
				m := toIRMessage(msgMap, blocksByID, filesByID)
				if m.ID == "" {
					m.ID = util.NewUUID()
				}
				if m.Role == "" {
					m.Role = "user"
				}
				conv.Messages = append(conv.Messages, m)
			}
			if aid := str(topic["assistantId"]); aid != "" {
				conv.AssistantID = aid
				explicitTopicAssistant[conv.ID] = true
			} else {
				messageAssistantByTopic[conv.ID] = chooseDominantAssistantID(msgItems)
			}
			res.Conversations = append(res.Conversations, conv)
		}
	}

	if err := parsePersistSlices(res, localStorage); err != nil {
		return nil, err
	}
	applyConversationAssistantFallbacks(res, explicitTopicAssistant, messageAssistantByTopic)
	applyConversationTitleFallbacks(res)
	if isolated := mapping.ExtractCherryUnsupportedSettings(res.Config); len(isolated) > 0 {
		res.Opaque["interop.cherry.unsupported"] = isolated
		res.Warnings = append(res.Warnings, "unsupported-isolated:cherry.settings")
	}
	settings, warnings := mapping.NormalizeFromCherryConfig(res.Config)
	res.Settings = settings
	res.Warnings = append(res.Warnings, warnings...)

	// keep unknown indexeddb tables in opaque for round-trip preservation
	unknownTables := map[string]any{}
	for k, v := range indexed {
		if k == "topics" || k == "message_blocks" || k == "files" {
			continue
		}
		var val any
		if err := json.Unmarshal(v, &val); err == nil {
			unknownTables[k] = val
		}
	}
	if len(unknownTables) > 0 {
		res.Opaque["cherry.indexedDB.extra"] = unknownTables
	}
	for _, f := range res.Files {
		if f.Missing {
			res.Warnings = append(res.Warnings, fmt.Sprintf("missing cherry file payload: %s", f.ID))
		}
	}

	return res, nil
}

func parsePersistSlices(res *ir.BackupIR, localStorage map[string]any) error {
	persistStr, _ := localStorage["persist:cherry-studio"].(string)
	if persistStr == "" {
		return nil
	}

	var persistSlices map[string]any
	if err := json.Unmarshal([]byte(persistStr), &persistSlices); err != nil {
		return fmt.Errorf("parse persist:cherry-studio: %w", err)
	}

	decodedSlices := map[string]any{}
	for k, v := range persistSlices {
		s, ok := v.(string)
		if !ok {
			decodedSlices[k] = v
			continue
		}
		var parsed any
		if err := json.Unmarshal([]byte(s), &parsed); err != nil {
			decodedSlices[k] = s
			continue
		}
		decodedSlices[k] = parsed
	}
	res.Config["cherry.persistSlices"] = decodedSlices

	assistantsSlice, _ := decodedSlices["assistants"].(map[string]any)
	assistants, _ := assistantsSlice["assistants"].([]any)
	for _, a := range assistants {
		m, ok := a.(map[string]any)
		if !ok {
			continue
		}
		assistant := ir.IRAssistant{
			ID:          str(m["id"]),
			Name:        str(m["name"]),
			Prompt:      str(m["prompt"]),
			Description: str(m["description"]),
			Model:       asMap(m["model"]),
			Settings:    asMap(m["settings"]),
			Opaque:      map[string]any{},
		}
		if assistant.ID == "" {
			assistant.ID = util.NewUUID()
		}
		res.Assistants = append(res.Assistants, assistant)
	}

	if settings, ok := decodedSlices["settings"]; ok {
		res.Config["cherry.settings"] = settings
	}
	if llm, ok := decodedSlices["llm"]; ok {
		res.Config["cherry.llm"] = llm
	}
	return nil
}

func applyConversationAssistantFallbacks(res *ir.BackupIR, explicitTopicAssistant map[string]bool, messageAssistantByTopic map[string]string) {
	assistantsByTopic := cherryAssistantTopicsFromPersist(res)
	for i := range res.Conversations {
		conv := &res.Conversations[i]
		if explicitTopicAssistant[conv.ID] {
			continue
		}
		if aid := strings.TrimSpace(assistantsByTopic[conv.ID]); aid != "" {
			conv.AssistantID = aid
			continue
		}
		if aid := strings.TrimSpace(messageAssistantByTopic[conv.ID]); aid != "" {
			conv.AssistantID = aid
		}
	}
}

func applyConversationTitleFallbacks(res *ir.BackupIR) {
	topicNames := cherryTopicNamesFromPersist(res)
	for i := range res.Conversations {
		conv := &res.Conversations[i]
		if strings.TrimSpace(conv.Title) != "" {
			continue
		}
		if title := strings.TrimSpace(topicNames[conv.ID]); title != "" {
			conv.Title = title
		}
	}
}

func cherryAssistantTopicsFromPersist(res *ir.BackupIR) map[string]string {
	out := map[string]string{}
	persist, _ := res.Config["cherry.persistSlices"].(map[string]any)
	assistantsSlice, _ := persist["assistants"].(map[string]any)
	assistants, _ := assistantsSlice["assistants"].([]any)
	for _, item := range assistants {
		assistant := asMap(item)
		assistantID := strings.TrimSpace(str(assistant["id"]))
		for _, topicItem := range toSlice(assistant["topics"]) {
			topic := asMap(topicItem)
			topicID := strings.TrimSpace(str(topic["id"]))
			if topicID == "" {
				continue
			}
			mappedAssistantID := assistantID
			topicAssistantID := strings.TrimSpace(str(topic["assistantId"]))
			if mappedAssistantID == "" {
				mappedAssistantID = topicAssistantID
			} else if topicAssistantID != "" && topicAssistantID != mappedAssistantID {
				res.Warnings = append(res.Warnings, fmt.Sprintf("topic %s assistantId (%s) mismatches owner assistant (%s), using owner", topicID, topicAssistantID, mappedAssistantID))
			}
			if mappedAssistantID == "" {
				continue
			}
			if existing := strings.TrimSpace(out[topicID]); existing != "" && existing != mappedAssistantID {
				res.Warnings = append(res.Warnings, fmt.Sprintf("topic %s mapped to multiple assistants in persist slices: %s vs %s", topicID, existing, mappedAssistantID))
				continue
			}
			out[topicID] = mappedAssistantID
		}
	}
	return out
}

func cherryTopicNamesFromPersist(res *ir.BackupIR) map[string]string {
	out := map[string]string{}
	persist, _ := res.Config["cherry.persistSlices"].(map[string]any)
	assistantsSlice, _ := persist["assistants"].(map[string]any)
	assistants, _ := assistantsSlice["assistants"].([]any)
	for _, item := range assistants {
		assistant := asMap(item)
		for _, topicItem := range toSlice(assistant["topics"]) {
			topic := asMap(topicItem)
			topicID := strings.TrimSpace(str(topic["id"]))
			if topicID == "" {
				continue
			}
			topicName := strings.TrimSpace(str(topic["name"]))
			if topicName == "" {
				continue
			}
			if _, exists := out[topicID]; !exists {
				out[topicID] = topicName
			}
		}
	}
	return out
}

func chooseDominantAssistantID(messages []any) string {
	counts := map[string]int{}
	order := []string{}
	for _, item := range messages {
		msgMap, ok := item.(map[string]any)
		if !ok {
			continue
		}
		assistantID := strings.TrimSpace(str(msgMap["assistantId"]))
		if assistantID == "" {
			continue
		}
		if _, exists := counts[assistantID]; !exists {
			order = append(order, assistantID)
		}
		counts[assistantID]++
	}
	best := ""
	bestCount := 0
	for _, assistantID := range order {
		if counts[assistantID] > bestCount {
			best = assistantID
			bestCount = counts[assistantID]
		}
	}
	return best
}

func mergeDataFiles(extractedDir string, filesByID map[string]ir.IRFile) {
	filesDir := filepath.Join(extractedDir, "Data", "Files")
	entries, err := os.ReadDir(filesDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		ext := filepath.Ext(name)
		id := strings.TrimSuffix(name, ext)
		if id == "" {
			continue
		}
		if _, exists := filesByID[id]; exists {
			continue
		}
		fullPath := filepath.Join(filesDir, name)
		st, err := os.Stat(fullPath)
		if err != nil {
			continue
		}
		hash, _ := util.SHA256File(fullPath)
		filesByID[id] = ir.IRFile{
			ID:          id,
			Name:        name,
			Ext:         ext,
			SourcePath:  fullPath,
			RelativeSrc: toRel(extractedDir, fullPath),
			Size:        st.Size(),
			CreatedAt:   st.ModTime().UTC().Format(time.RFC3339),
			UpdatedAt:   st.ModTime().UTC().Format(time.RFC3339),
			HashSHA256:  hash,
			LogicalType: normalizeLogicalType("", ext),
			Orphan:      true,
			Metadata: map[string]any{
				"discovered": true,
				"cherry_id":  id,
				"cherry_ext": ext,
			},
		}
	}
}

func sortFiles(m map[string]ir.IRFile) []ir.IRFile {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	res := make([]ir.IRFile, 0, len(keys))
	for _, k := range keys {
		res = append(res, m[k])
	}
	return res
}

func toIRMessage(msg map[string]any, blocksByID map[string]map[string]any, filesByID map[string]ir.IRFile) ir.IRMessage {
	m := ir.IRMessage{
		ID:        str(msg["id"]),
		Role:      str(msg["role"]),
		CreatedAt: str(msg["createdAt"]),
		ModelID:   str(msg["modelId"]),
		Parts:     []ir.IRPart{},
		Opaque:    map[string]any{},
	}
	if m.Role == "" {
		m.Role = "user"
	}

	blockIDs := toStringSlice(msg["blocks"])
	for _, blockID := range blockIDs {
		block := blocksByID[blockID]
		if len(block) == 0 {
			continue
		}
		m.Parts = append(m.Parts, mapBlockToPart(block, filesByID))
	}

	if len(m.Parts) == 0 {
		if c := str(msg["content"]); c != "" {
			m.Parts = append(m.Parts, ir.IRPart{Type: "text", Content: c})
		}
	}
	if len(m.Parts) == 0 {
		m.Parts = append(m.Parts, ir.IRPart{Type: "text", Content: ""})
	}
	return m
}

func mapBlockToPart(block map[string]any, filesByID map[string]ir.IRFile) ir.IRPart {
	t := str(block["type"])
	p := ir.IRPart{Type: "text", Metadata: map[string]any{"cherryBlockType": t}}

	switch t {
	case "main_text", "code", "translation", "compact":
		p.Type = "text"
		p.Content = str(block["content"])
	case "thinking":
		p.Type = "reasoning"
		p.Content = str(block["content"])
	case "tool":
		p.Type = "tool"
		p.Name = str(block["toolName"])
		p.ToolCallID = str(block["toolId"])
		if args, ok := block["arguments"]; ok {
			p.Input = util.MustJSON(args)
		}
		if c := str(block["content"]); c != "" {
			p.Output = []ir.IRPart{{Type: "text", Content: c}}
		}
	case "image":
		p.Type = "image"
		p.MediaURL = str(block["url"])
		fillPartFileInfo(&p, block, filesByID)
	case "video":
		p.Type = "video"
		p.MediaURL = str(block["url"])
		fillPartFileInfo(&p, block, filesByID)
	case "file":
		p.Type = "document"
		fillPartFileInfo(&p, block, filesByID)
		if p.Name == "" {
			p.Name = str(block["name"])
		}
	default:
		p.Type = "text"
		if c := str(block["content"]); c != "" {
			p.Content = c
		} else {
			p.Content = "[unsupported cherry block: " + t + "]"
		}
		p.Metadata["raw"] = block
	}
	if len(p.Metadata) == 0 {
		p.Metadata = nil
	}
	return p
}

func fillPartFileInfo(p *ir.IRPart, block map[string]any, filesByID map[string]ir.IRFile) {
	fm := asMap(block["file"])
	if len(fm) == 0 {
		return
	}
	fid := str(fm["id"])
	if fid != "" {
		p.FileID = fid
	}
	if p.Name == "" {
		p.Name = str(fm["origin_name"])
		if p.Name == "" {
			p.Name = str(fm["name"])
		}
	}
	if p.MimeType == "" {
		if f, ok := filesByID[fid]; ok {
			p.MimeType = f.MimeType
		}
	}
}

func BuildFromIR(in *ir.BackupIR, outputDir, templateDir string, redactSecrets bool, idMap map[string]string) ([]string, error) {
	warnings := []string{}
	var baseData map[string]any
	if templateDir != "" {
		b, ok, err := util.ReadFileIfExists(filepath.Join(templateDir, "data.json"))
		if err != nil {
			return nil, err
		}
		if ok {
			_ = json.Unmarshal(b, &baseData)
		}
	}
	if baseData == nil {
		baseData = map[string]any{}
	}

	if err := util.EnsureDir(filepath.Join(outputDir, "Data", "Files")); err != nil {
		return nil, err
	}
	warnings = append(warnings, mapping.EnsureNormalizedSettings(in)...)

	indexedDB := map[string]any{}
	if existing, ok := baseData["indexedDB"].(map[string]any); ok {
		for k, v := range existing {
			indexedDB[k] = v
		}
	}
	localStorage := map[string]any{}
	if existing, ok := baseData["localStorage"].(map[string]any); ok {
		for k, v := range existing {
			localStorage[k] = v
		}
	}

	convByAssistant := map[string][]ir.IRConversation{}
	for _, conv := range in.Conversations {
		convByAssistant[conv.AssistantID] = append(convByAssistant[conv.AssistantID], conv)
	}

	fileTable, fileWarnings, err := materializeCherryFiles(outputDir, in.Files, idMap)
	if err != nil {
		return nil, err
	}
	warnings = append(warnings, fileWarnings...)
	indexedDB["files"] = fileTable

	messageBlocks := make([]map[string]any, 0, 1024)
	topics := make([]map[string]any, 0, len(in.Conversations))
	for _, conv := range in.Conversations {
		topicID := conv.ID
		if topicID == "" {
			topicID = util.NewUUID()
		}
		if _, exists := idMap["topic:"+conv.ID]; !exists {
			idMap["topic:"+conv.ID] = topicID
		}
		messages := make([]map[string]any, 0, len(conv.Messages))
		for _, m := range conv.Messages {
			msgID := m.ID
			if msgID == "" {
				msgID = util.NewUUID()
			}
			idMap["message:"+m.ID] = msgID
			blockIDs := make([]string, 0, len(m.Parts))
			for _, p := range m.Parts {
				blockID := util.NewUUID()
				blockIDs = append(blockIDs, blockID)
				messageBlocks = append(messageBlocks, partToCherryBlock(blockID, msgID, p, in.Files, idMap))
			}
			messages = append(messages, map[string]any{
				"id":          msgID,
				"role":        normalizeRole(m.Role),
				"assistantId": conv.AssistantID,
				"topicId":     topicID,
				"createdAt":   fallbackTime(m.CreatedAt),
				"status":      "success",
				"blocks":      blockIDs,
			})
		}
		topics = append(topics, map[string]any{
			"id":          topicID,
			"name":        fallbackString(conv.Title, "Imported Conversation"),
			"assistantId": conv.AssistantID,
			"createdAt":   fallbackTime(conv.CreatedAt),
			"updatedAt":   fallbackTime(conv.UpdatedAt),
			"messages":    messages,
		})
	}
	indexedDB["topics"] = topics
	indexedDB["message_blocks"] = messageBlocks

	if extra := asMap(in.Opaque["cherry.indexedDB.extra"]); len(extra) > 0 {
		for k, v := range extra {
			if _, exists := indexedDB[k]; !exists {
				indexedDB[k] = v
			}
		}
	}

	persistSlices := map[string]any{}
	if cfg, ok := in.Config["cherry.persistSlices"].(map[string]any); ok {
		for k, v := range cfg {
			persistSlices[k] = v
		}
	}
	if len(persistSlices) == 0 {
		persistSlices = defaultPersistSlices()
	}
	assistantsSlice := buildAssistantsSlice(in.Assistants, convByAssistant)
	persistSlices, mapWarnings := mapping.BuildCherryPersistSlicesFromIR(in, persistSlices, assistantsSlice)
	warnings = append(warnings, mapWarnings...)

	if redactSecrets {
		persistSlices = util.RedactAny(persistSlices).(map[string]any)
	}

	persistRaw := map[string]any{}
	for k, v := range persistSlices {
		persistRaw[k] = util.MustJSON(v)
	}
	localStorage["persist:cherry-studio"] = util.MustJSON(persistRaw)

	baseData["time"] = time.Now().UnixMilli()
	baseData["version"] = 5
	baseData["localStorage"] = localStorage
	baseData["indexedDB"] = indexedDB

	dataJSON, err := json.Marshal(baseData)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(outputDir, "data.json"), dataJSON, 0o644); err != nil {
		return nil, err
	}
	return dedupeWarnings(warnings), nil
}

func materializeCherryFiles(outputDir string, files []ir.IRFile, idMap map[string]string) ([]map[string]any, []string, error) {
	table := make([]map[string]any, 0, len(files))
	warnings := []string{}
	usedIDs := map[string]struct{}{}
	destDir := filepath.Join(outputDir, "Data", "Files")
	if err := util.EnsureDir(destDir); err != nil {
		return nil, nil, err
	}
	for _, f := range files {
		fid := chooseCherryFileID(f)
		if _, exists := usedIDs[fid]; exists {
			fid = util.NewUUID()
		}
		usedIDs[fid] = struct{}{}
		idMap["file:"+f.ID] = fid
		ext := f.Ext
		if ext == "" {
			ext = filepath.Ext(f.Name)
		}
		name := fid + ext
		if f.SourcePath != "" {
			if err := util.CopyFile(f.SourcePath, filepath.Join(destDir, name)); err != nil {
				return nil, nil, err
			}
		} else {
			if err := os.WriteFile(filepath.Join(destDir, name), nil, 0o644); err != nil {
				return nil, nil, err
			}
			warnings = append(warnings, fmt.Sprintf("file %s missing source payload; created empty placeholder", f.ID))
		}
		table = append(table, map[string]any{
			"id":          fid,
			"name":        name,
			"origin_name": fallbackName(f.Name, name),
			"path":        filepath.ToSlash(filepath.Join("Data", "Files", name)),
			"size":        f.Size,
			"ext":         ext,
			"type":        fallbackString(f.LogicalType, fallbackString(f.MimeType, "other")),
			"created_at":  fallbackTime(f.CreatedAt),
			"count":       1,
		})
	}
	if len(table) == 0 {
		keepPath := filepath.Join(destDir, ".keep")
		if err := os.WriteFile(keepPath, nil, 0o644); err != nil {
			return nil, nil, err
		}
	}
	return table, dedupeWarnings(warnings), nil
}

func partToCherryBlock(blockID, messageID string, p ir.IRPart, files []ir.IRFile, idMap map[string]string) map[string]any {
	meta := map[string]any{
		"id":        blockID,
		"messageId": messageID,
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"status":    "success",
	}
	if p.Metadata != nil {
		meta["metadata"] = p.Metadata
	}
	findFile := func(fileID string) map[string]any {
		mapped := idMap["file:"+fileID]
		for _, f := range files {
			if f.ID == fileID || idMap["file:"+f.ID] == mapped {
				id := mapped
				if id == "" {
					id = f.ID
				}
				ext := f.Ext
				if ext == "" {
					ext = filepath.Ext(f.Name)
				}
				return map[string]any{
					"id":          id,
					"name":        id + ext,
					"origin_name": f.Name,
					"ext":         ext,
					"size":        f.Size,
					"type":        fallbackString(f.MimeType, "other"),
				}
			}
		}
		return nil
	}

	switch p.Type {
	case "reasoning":
		meta["type"] = "thinking"
		meta["content"] = p.Content
	case "tool":
		meta["type"] = "tool"
		meta["toolId"] = fallbackString(p.ToolCallID, util.NewUUID())
		meta["toolName"] = p.Name
		if p.Input != "" {
			var in any
			if json.Unmarshal([]byte(p.Input), &in) == nil {
				meta["arguments"] = in
			} else {
				meta["arguments"] = map[string]any{"raw": p.Input}
			}
		}
		if len(p.Output) > 0 {
			meta["content"] = p.Output[0].Content
		}
	case "image":
		meta["type"] = "image"
		meta["url"] = p.MediaURL
		if p.FileID != "" {
			if f := findFile(p.FileID); f != nil {
				meta["file"] = f
			}
		}
	case "video":
		meta["type"] = "video"
		meta["url"] = p.MediaURL
		if p.FileID != "" {
			if f := findFile(p.FileID); f != nil {
				meta["file"] = f
			}
		}
	case "audio", "document":
		meta["type"] = "file"
		if p.FileID != "" {
			if f := findFile(p.FileID); f != nil {
				meta["file"] = f
			}
		}
		if p.Content != "" {
			meta["content"] = p.Content
		}
	default:
		meta["type"] = "main_text"
		meta["content"] = p.Content
	}
	return meta
}

func buildAssistantsSlice(assistants []ir.IRAssistant, convByAssistant map[string][]ir.IRConversation) map[string]any {
	if len(assistants) == 0 {
		assistants = []ir.IRAssistant{{
			ID:   "default",
			Name: "Default",
		}}
	}

	arr := make([]any, 0, len(assistants))
	for i, a := range assistants {
		if a.ID == "" {
			a.ID = util.NewUUID()
		}
		topics := make([]any, 0)
		for _, c := range convByAssistant[a.ID] {
			topics = append(topics, map[string]any{
				"id":                   c.ID,
				"assistantId":          a.ID,
				"name":                 fallbackString(c.Title, "Imported Conversation"),
				"createdAt":            fallbackTime(c.CreatedAt),
				"updatedAt":            fallbackTime(c.UpdatedAt),
				"messages":             []any{},
				"isNameManuallyEdited": true,
			})
		}
		arr = append(arr, map[string]any{
			"id":             a.ID,
			"name":           fallbackName(a.Name, fmt.Sprintf("Assistant %d", i+1)),
			"prompt":         a.Prompt,
			"topics":         topics,
			"type":           "assistant",
			"emoji":          "😀",
			"settings":       fallbackMap(a.Settings, map[string]any{"contextCount": 32, "temperature": 0.7, "streamOutput": true}),
			"regularPhrases": []any{},
		})
	}
	def := arr[0].(map[string]any)
	defaultAssistant := map[string]any{}
	for k, v := range def {
		defaultAssistant[k] = v
	}
	defaultAssistant["id"] = "default"
	defaultAssistant["name"] = "Default"

	return map[string]any{
		"defaultAssistant": defaultAssistant,
		"assistants":       arr,
		"tagsOrder":        []any{},
		"collapsedTags":    map[string]any{},
		"presets":          []any{},
		"unifiedListOrder": []any{},
	}
}

func defaultPersistSlices() map[string]any {
	return map[string]any{
		"settings": map[string]any{
			"userId":         util.NewUUID(),
			"userName":       "",
			"skipBackupFile": false,
		},
		"llm": map[string]any{
			"defaultModel": map[string]any{
				"id":       "default-model",
				"provider": "openai",
				"name":     "gpt-4o-mini",
				"group":    "default",
			},
			"quickModel":     nil,
			"translateModel": nil,
		},
		"backup": map[string]any{
			"webdavSync":      map[string]any{"lastSyncTime": nil, "syncing": false, "lastSyncError": nil},
			"localBackupSync": map[string]any{"lastSyncTime": nil, "syncing": false, "lastSyncError": nil},
			"s3Sync":          map[string]any{"lastSyncTime": nil, "syncing": false, "lastSyncError": nil},
		},
	}
}

func normalizeRole(role string) string {
	r := strings.ToLower(strings.TrimSpace(role))
	switch r {
	case "assistant", "user", "system":
		return r
	default:
		return "assistant"
	}
}

func fallbackTime(v string) string {
	if v == "" {
		return time.Now().UTC().Format(time.RFC3339)
	}
	return v
}

func toRel(root, p string) string {
	if p == "" {
		return ""
	}
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return filepath.ToSlash(p)
	}
	return filepath.ToSlash(rel)
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

func toStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func toSlice(v any) []any {
	arr, _ := v.([]any)
	return arr
}

func fallbackName(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return v
}

func fallbackString(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return v
}

func fallbackMap(v map[string]any, d map[string]any) map[string]any {
	if len(v) == 0 {
		return d
	}
	return v
}

func resolveCherryFilePath(extractedDir, id, ext string) string {
	basePath := filepath.Join(extractedDir, "Data", "Files", id+ext)
	if _, err := os.Stat(basePath); err == nil {
		return basePath
	}
	filesDir := filepath.Join(extractedDir, "Data", "Files")
	entries, err := os.ReadDir(filesDir)
	if err != nil {
		return basePath
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, id+".") || name == id {
			return filepath.Join(filesDir, name)
		}
	}
	return basePath
}

func anyString(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%f", t)
	default:
		return ""
	}
}

func normalizeLogicalType(fileType, ext string) string {
	ft := strings.ToLower(strings.TrimSpace(fileType))
	if ft == "" {
		ft = strings.ToLower(strings.TrimSpace(ext))
	}
	switch ft {
	case "image", ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return "image"
	case "video", ".mp4", ".mov", ".mkv", ".webm":
		return "video"
	case "audio", ".mp3", ".wav", ".m4a", ".aac", ".ogg":
		return "audio"
	case "text", ".txt", ".md", ".csv":
		return "text"
	default:
		return "document"
	}
}

func chooseCherryFileID(f ir.IRFile) string {
	meta := asMap(f.Metadata)
	if id := str(meta["cherry_id"]); isSafeFileStem(id) {
		return id
	}
	if isSafeFileStem(f.ID) {
		return f.ID
	}
	return deterministicCherryFileID(f)
}

func deterministicCherryFileID(f ir.IRFile) string {
	seedParts := []string{
		strings.TrimSpace(f.ID),
		strings.TrimSpace(f.Name),
		strings.TrimSpace(f.Ext),
		strings.TrimSpace(f.RelativeSrc),
		strings.TrimSpace(f.HashSHA256),
	}
	seed := strings.Join(seedParts, "|")
	if strings.TrimSpace(seed) == "" {
		seed = "cherrikka:file:unknown"
	}
	return guuid.NewSHA1(guuid.NameSpaceURL, []byte(seed)).String()
}

func isSafeFileStem(v string) bool {
	if strings.TrimSpace(v) == "" {
		return false
	}
	for _, r := range v {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}

func dedupeWarnings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	set := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, item := range in {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, ok := set[item]; ok {
			continue
		}
		set[item] = struct{}{}
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

func ValidateExtracted(dir string) error {
	issues := []string{}
	if _, err := os.Stat(filepath.Join(dir, "data.json")); err != nil {
		issues = append(issues, "missing data.json")
	}
	if st, err := os.Stat(filepath.Join(dir, "Data")); err != nil || !st.IsDir() {
		issues = append(issues, "missing Data directory")
	}
	if len(issues) > 0 {
		return errors.New(strings.Join(issues, "; "))
	}

	dataBytes, err := os.ReadFile(filepath.Join(dir, "data.json"))
	if err != nil {
		return err
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(dataBytes, &root); err != nil {
		return fmt.Errorf("parse data.json: %w", err)
	}
	indexed := map[string]json.RawMessage{}
	if raw, ok := root["indexedDB"]; ok {
		if err := json.Unmarshal(raw, &indexed); err != nil {
			return fmt.Errorf("parse indexedDB: %w", err)
		}
	}

	fileIDs := map[string]struct{}{}
	if raw, ok := indexed["files"]; ok {
		var files []map[string]any
		if err := json.Unmarshal(raw, &files); err == nil {
			for _, rec := range files {
				id := str(rec["id"])
				if id == "" {
					continue
				}
				fileIDs[id] = struct{}{}
				ext := str(rec["ext"])
				path := resolveCherryFilePath(dir, id, ext)
				if _, err := os.Stat(path); err != nil {
					issues = append(issues, "indexedDB.files entry missing payload: "+id)
				}
			}
		}
	}

	if raw, ok := indexed["message_blocks"]; ok {
		var blocks []map[string]any
		if err := json.Unmarshal(raw, &blocks); err == nil {
			for _, block := range blocks {
				fileMap := asMap(block["file"])
				fileID := str(fileMap["id"])
				if fileID == "" {
					continue
				}
				if _, ok := fileIDs[fileID]; !ok {
					issues = append(issues, "message_blocks.file.id not found in indexedDB.files: "+fileID)
				}
			}
		}
	}

	localStorage := map[string]any{}
	if raw, ok := root["localStorage"]; ok {
		_ = json.Unmarshal(raw, &localStorage)
	}
	persistStr := str(localStorage["persist:cherry-studio"])
	if strings.TrimSpace(persistStr) != "" {
		persistSlices := map[string]any{}
		if err := json.Unmarshal([]byte(persistStr), &persistSlices); err != nil {
			issues = append(issues, "parse persist:cherry-studio failed: "+err.Error())
		} else {
			decoded := map[string]any{}
			for k, v := range persistSlices {
				s, ok := v.(string)
				if !ok {
					decoded[k] = v
					continue
				}
				var parsed any
				if err := json.Unmarshal([]byte(s), &parsed); err != nil {
					continue
				}
				decoded[k] = parsed
			}
			llm := asMap(decoded["llm"])
			modelIDs := map[string]struct{}{}
			providerIDs := map[string]struct{}{}
			for _, pItem := range toSlice(llm["providers"]) {
				pm := asMap(pItem)
				providerID := strings.TrimSpace(str(pm["id"]))
				if providerID == "" {
					issues = append(issues, "llm.providers has provider with empty id")
					continue
				}
				providerIDs[providerID] = struct{}{}
				models := toSlice(pm["models"])
				if len(models) == 0 {
					issues = append(issues, "llm.providers has provider without models: "+providerID)
				}
				for _, mItem := range models {
					mm := asMap(mItem)
					modelID := firstNonEmpty(str(mm["id"]), str(mm["modelId"]))
					if modelID == "" {
						issues = append(issues, "llm.providers model missing id: "+providerID)
						continue
					}
					modelIDs[modelID] = struct{}{}
					if alt := strings.TrimSpace(str(mm["modelId"])); alt != "" {
						modelIDs[alt] = struct{}{}
					}
					modelProvider := strings.TrimSpace(str(mm["provider"]))
					if modelProvider == "" {
						issues = append(issues, "llm.providers model missing provider: "+modelID)
						continue
					}
					if _, ok := providerIDs[modelProvider]; !ok {
						issues = append(issues, "llm.providers model provider not found: "+modelProvider)
					}
				}
			}
			for _, key := range []string{"defaultModel", "quickModel", "translateModel", "topicNamingModel"} {
				m := asMap(llm[key])
				if len(m) == 0 {
					continue
				}
				if len(modelIDs) == 0 {
					continue
				}
				modelID := firstNonEmpty(str(m["id"]), str(m["modelId"]))
				if modelID == "" {
					issues = append(issues, "llm."+key+" missing model id")
					continue
				}
				if _, ok := modelIDs[modelID]; !ok {
					issues = append(issues, "llm."+key+" not found in llm.providers: "+modelID)
				}
			}

			assistantsSlice := asMap(decoded["assistants"])
			for _, aItem := range toSlice(assistantsSlice["assistants"]) {
				assistant := asMap(aItem)
				model := asMap(assistant["model"])
				modelID := firstNonEmpty(str(model["id"]), str(model["modelId"]))
				if modelID == "" {
					continue
				}
				if len(modelIDs) == 0 {
					continue
				}
				if _, ok := modelIDs[modelID]; !ok {
					issues = append(issues, "assistant model not found in llm.providers: "+modelID)
				}
			}
		}
	}
	if len(issues) > 0 {
		return errors.New(strings.Join(dedupeWarnings(issues), "; "))
	}
	return nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v != "" {
			return v
		}
	}
	return ""
}

func sidecarExists(root string) bool {
	manifestPath := filepath.Join(root, "cherrikka", "manifest.json")
	sourcePath := filepath.Join(root, "cherrikka", "raw", "source.zip")
	if _, err := os.Stat(manifestPath); err != nil {
		return false
	}
	if _, err := os.Stat(sourcePath); err != nil {
		return false
	}
	return true
}

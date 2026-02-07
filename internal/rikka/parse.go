package rikka

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"cherrikka/internal/ir"
	"cherrikka/internal/mapping"
	"cherrikka/internal/util"
)

func ValidateExtracted(dir string) error {
	issues := []string{}
	if _, err := os.Stat(filepath.Join(dir, "settings.json")); err != nil {
		issues = append(issues, "missing settings.json")
	}
	if _, err := os.Stat(filepath.Join(dir, "rikka_hub.db")); err != nil {
		issues = append(issues, "missing rikka_hub.db")
	}
	if len(issues) > 0 {
		return errors.New(strings.Join(issues, "; "))
	}

	db, err := sql.Open("sqlite", filepath.Join(dir, "rikka_hub.db"))
	if err != nil {
		return err
	}
	defer db.Close()

	validAssistantIDs := map[string]struct{}{}
	if b, err := os.ReadFile(filepath.Join(dir, "settings.json")); err == nil {
		settings := map[string]any{}
		if err := json.Unmarshal(b, &settings); err != nil {
			issues = append(issues, "parse settings.json failed: "+err.Error())
		} else {
			for _, item := range asSlice(settings["assistants"]) {
				assistant := asMap(item)
				if id := str(assistant["id"]); id != "" {
					validAssistantIDs[id] = struct{}{}
				}
			}
		}
	}

	managed := map[string]struct{}{}
	rows, err := db.Query(`SELECT relative_path FROM managed_files`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var rel string
			if err := rows.Scan(&rel); err != nil {
				issues = append(issues, "scan managed_files failed: "+err.Error())
				continue
			}
			rel = filepath.ToSlash(rel)
			managed[rel] = struct{}{}
			if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
				issues = append(issues, "managed_files payload missing: "+rel)
			}
		}
	}

	msgRows, err := db.Query(`SELECT messages FROM message_node`)
	if err == nil {
		defer msgRows.Close()
		for msgRows.Next() {
			var messagesJSON string
			if err := msgRows.Scan(&messagesJSON); err != nil {
				issues = append(issues, "scan message_node failed: "+err.Error())
				continue
			}
			var messages []map[string]any
			if err := json.Unmarshal([]byte(messagesJSON), &messages); err != nil {
				continue
			}
			for _, m := range messages {
				parts := asSlice(m["parts"])
				for _, partItem := range parts {
					part := asMap(partItem)
					url := str(part["url"])
					if !strings.HasPrefix(url, "file://") {
						continue
					}
					fileName := filepath.Base(strings.TrimPrefix(url, "file://"))
					if fileName == "" || fileName == "." || fileName == "/" {
						continue
					}
					rel := filepath.ToSlash(filepath.Join("upload", fileName))
					if _, ok := managed[rel]; !ok {
						issues = append(issues, "message_node file url has no managed_files entry: "+rel)
					}
				}
			}
		}
	}
	if len(validAssistantIDs) > 0 {
		convRows, err := db.Query(`SELECT DISTINCT assistant_id FROM ConversationEntity`)
		if err == nil {
			defer convRows.Close()
			for convRows.Next() {
				var assistantID string
				if err := convRows.Scan(&assistantID); err != nil {
					issues = append(issues, "scan ConversationEntity assistant_id failed: "+err.Error())
					continue
				}
				if _, ok := validAssistantIDs[strings.TrimSpace(assistantID)]; !ok && strings.TrimSpace(assistantID) != "" {
					issues = append(issues, "conversation assistant_id missing in settings.assistants: "+assistantID)
				}
			}
		}
	}
	if len(issues) > 0 {
		return errors.New(strings.Join(dedupeWarnings(issues), "; "))
	}
	return nil
}

func ParseToIR(extractedDir string) (*ir.BackupIR, error) {
	settingsBytes, err := os.ReadFile(filepath.Join(extractedDir, "settings.json"))
	if err != nil {
		return nil, err
	}
	var settings map[string]any
	if err := json.Unmarshal(settingsBytes, &settings); err != nil {
		return nil, fmt.Errorf("parse settings.json: %w", err)
	}

	res := &ir.BackupIR{
		SourceApp:    "rikkahub",
		SourceFormat: "rikka",
		CreatedAt:    time.Now().UTC(),
		Config:       map[string]any{"rikka.settings": settings},
		Settings:     map[string]any{},
		Opaque:       map[string]any{},
		Secrets:      map[string]string{},
	}

	db, err := sql.Open("sqlite", filepath.Join(extractedDir, "rikka_hub.db"))
	if err != nil {
		return nil, err
	}
	defer db.Close()

	fileByRelPath := map[string]ir.IRFile{}
	fileWarnings, err := parseManagedFiles(db, extractedDir, fileByRelPath)
	if err != nil {
		return nil, err
	}
	fileWarnings = append(fileWarnings, mergeUploadFiles(extractedDir, fileByRelPath)...)
	for _, f := range sortedFiles(fileByRelPath) {
		res.Files = append(res.Files, f)
	}

	if err := parseConversations(db, res, fileByRelPath); err != nil {
		return nil, err
	}

	if assistants, ok := settings["assistants"].([]any); ok {
		for _, raw := range assistants {
			m, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			assistant := ir.IRAssistant{
				ID:          str(m["id"]),
				Name:        str(m["name"]),
				Prompt:      str(m["systemPrompt"]),
				Description: "",
				Model:       map[string]any{"chatModelId": m["chatModelId"]},
				Settings:    map[string]any{},
				Opaque:      m,
			}
			if assistant.ID == "" {
				assistant.ID = util.NewUUID()
			}
			res.Assistants = append(res.Assistants, assistant)
		}
	}
	settingsNorm, warnings := mapping.NormalizeFromRikkaConfig(res.Config)
	res.Settings = settingsNorm
	res.Warnings = append(res.Warnings, warnings...)
	res.Warnings = append(res.Warnings, fileWarnings...)

	return res, nil
}

func parseManagedFiles(db *sql.DB, extractedDir string, out map[string]ir.IRFile) ([]string, error) {
	warnings := []string{}
	rows, err := db.Query(`SELECT id, folder, relative_path, display_name, mime_type, size_bytes, created_at, updated_at FROM managed_files`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id          int64
			folder      string
			relPath     string
			displayName string
			mime        string
			size        int64
			createdAt   int64
			updatedAt   int64
		)
		if err := rows.Scan(&id, &folder, &relPath, &displayName, &mime, &size, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		sourcePath := filepath.Join(extractedDir, filepath.FromSlash(relPath))
		if _, err := os.Stat(sourcePath); err != nil {
			sourcePath = ""
		}
		hash := ""
		if sourcePath != "" {
			hash, _ = util.SHA256File(sourcePath)
		} else {
			warnings = append(warnings, fmt.Sprintf("missing managed file payload: %s", relPath))
		}
		out[relPath] = ir.IRFile{
			ID:          fmt.Sprintf("managed:%d", id),
			Name:        displayName,
			RelativeSrc: filepath.ToSlash(relPath),
			SourcePath:  sourcePath,
			Size:        size,
			MimeType:    mime,
			Ext:         filepath.Ext(displayName),
			CreatedAt:   time.UnixMilli(createdAt).UTC().Format(time.RFC3339),
			UpdatedAt:   time.UnixMilli(updatedAt).UTC().Format(time.RFC3339),
			HashSHA256:  hash,
			LogicalType: inferLogicalTypeFromMime(mime, filepath.Ext(displayName)),
			Missing:     sourcePath == "",
			Metadata: map[string]any{
				"managed_id":           id,
				"folder":               folder,
				"created_at":           createdAt,
				"updated_at":           updatedAt,
				"rikka.relative_path":  filepath.ToSlash(relPath),
				"rikka.display_name":   displayName,
				"rikka.original_mime":  mime,
				"rikka.original_bytes": size,
			},
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return dedupeWarnings(warnings), nil
}

func mergeUploadFiles(extractedDir string, out map[string]ir.IRFile) []string {
	warnings := []string{}
	uploadDir := filepath.Join(extractedDir, "upload")
	entries, err := os.ReadDir(uploadDir)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		rel := filepath.ToSlash(filepath.Join("upload", entry.Name()))
		if _, exists := out[rel]; exists {
			continue
		}
		full := filepath.Join(uploadDir, entry.Name())
		st, err := os.Stat(full)
		if err != nil {
			continue
		}
		hash, _ := util.SHA256File(full)
		ext := filepath.Ext(entry.Name())
		out[rel] = ir.IRFile{
			ID:          "upload:" + entry.Name(),
			Name:        entry.Name(),
			RelativeSrc: rel,
			SourcePath:  full,
			Size:        st.Size(),
			Ext:         ext,
			CreatedAt:   st.ModTime().UTC().Format(time.RFC3339),
			UpdatedAt:   st.ModTime().UTC().Format(time.RFC3339),
			HashSHA256:  hash,
			LogicalType: inferLogicalTypeFromMime("", ext),
			Orphan:      true,
			Metadata: map[string]any{
				"discovered":          true,
				"rikka.relative_path": rel,
			},
		}
		warnings = append(warnings, fmt.Sprintf("orphan upload file discovered: %s", rel))
	}
	return dedupeWarnings(warnings)
}

func inferLogicalTypeFromMime(mime, ext string) string {
	lowMime := strings.ToLower(strings.TrimSpace(mime))
	lowExt := strings.ToLower(strings.TrimSpace(ext))
	switch {
	case strings.HasPrefix(lowMime, "image/"):
		return "image"
	case strings.HasPrefix(lowMime, "video/"):
		return "video"
	case strings.HasPrefix(lowMime, "audio/"):
		return "audio"
	case strings.HasPrefix(lowMime, "text/"):
		return "text"
	}
	switch lowExt {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return "image"
	case ".mp4", ".mov", ".mkv", ".webm":
		return "video"
	case ".mp3", ".wav", ".m4a", ".aac", ".ogg":
		return "audio"
	default:
		return "document"
	}
}

func parseConversations(db *sql.DB, out *ir.BackupIR, fileByRelPath map[string]ir.IRFile) error {
	rows, err := db.Query(`SELECT id, assistant_id, title, create_at, update_at, truncate_index, suggestions, is_pinned FROM ConversationEntity ORDER BY update_at DESC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id          string
			assistantID string
			title       string
			createAtMS  int64
			updateAtMS  int64
			truncateIdx int
			suggestions string
			isPinned    int
		)
		if err := rows.Scan(&id, &assistantID, &title, &createAtMS, &updateAtMS, &truncateIdx, &suggestions, &isPinned); err != nil {
			return err
		}
		conv := ir.IRConversation{
			ID:          id,
			AssistantID: assistantID,
			Title:       title,
			CreatedAt:   time.UnixMilli(createAtMS).UTC().Format(time.RFC3339),
			UpdatedAt:   time.UnixMilli(updateAtMS).UTC().Format(time.RFC3339),
			Messages:    []ir.IRMessage{},
			Opaque: map[string]any{
				"truncateIndex": truncateIdx,
				"suggestions":   suggestions,
				"isPinned":      isPinned,
			},
		}

		nodes, err := db.Query(`SELECT id, node_index, messages, select_index FROM message_node WHERE conversation_id = ? ORDER BY node_index ASC`, id)
		if err != nil {
			return err
		}
		for nodes.Next() {
			var nodeID string
			var nodeIndex int
			var messagesJSON string
			var selectIndex int
			if err := nodes.Scan(&nodeID, &nodeIndex, &messagesJSON, &selectIndex); err != nil {
				nodes.Close()
				return err
			}
			var messages []map[string]any
			if err := json.Unmarshal([]byte(messagesJSON), &messages); err != nil {
				conv.Opaque["node_unparsed:"+nodeID] = messagesJSON
				continue
			}
			if len(messages) == 0 {
				continue
			}
			if selectIndex < 0 || selectIndex >= len(messages) {
				selectIndex = 0
			}
			selected := messages[selectIndex]
			msg := parseRikkaMessage(selected, fileByRelPath)
			if msg.ID == "" {
				msg.ID = util.NewUUID()
			}
			if msg.Role == "" {
				msg.Role = "assistant"
			}
			conv.Messages = append(conv.Messages, msg)
			if len(messages) > 1 {
				conv.Opaque[fmt.Sprintf("node:%s:branches", nodeID)] = messages
			}
		}
		nodes.Close()
		out.Conversations = append(out.Conversations, conv)
	}
	return rows.Err()
}

func parseRikkaMessage(m map[string]any, filesByRel map[string]ir.IRFile) ir.IRMessage {
	msg := ir.IRMessage{
		ID:        str(m["id"]),
		Role:      strings.ToLower(str(m["role"])),
		CreatedAt: str(m["createdAt"]),
		ModelID:   str(m["modelId"]),
		Parts:     []ir.IRPart{},
		Opaque:    map[string]any{},
	}
	parts, _ := m["parts"].([]any)
	for _, item := range parts {
		pm, ok := item.(map[string]any)
		if !ok {
			continue
		}
		msg.Parts = append(msg.Parts, parseRikkaPart(pm, filesByRel))
	}
	if len(msg.Parts) == 0 {
		msg.Parts = []ir.IRPart{{Type: "text", Content: ""}}
	}
	return msg
}

func parseRikkaPart(pm map[string]any, filesByRel map[string]ir.IRFile) ir.IRPart {
	typeStr := str(pm["type"])
	p := ir.IRPart{Type: "text", Metadata: map[string]any{"rikkaType": typeStr}}

	switch {
	case has(pm, "text"):
		p.Type = "text"
		p.Content = str(pm["text"])
	case has(pm, "reasoning"):
		p.Type = "reasoning"
		p.Content = str(pm["reasoning"])
	case has(pm, "toolCallId") && has(pm, "toolName") && has(pm, "input"):
		p.Type = "tool"
		p.ToolCallID = str(pm["toolCallId"])
		p.Name = str(pm["toolName"])
		p.Input = str(pm["input"])
		if outParts, ok := pm["output"].([]any); ok {
			for _, o := range outParts {
				om, _ := o.(map[string]any)
				if has(om, "text") {
					p.Output = append(p.Output, ir.IRPart{Type: "text", Content: str(om["text"])})
				}
			}
		}
	case has(pm, "fileName") && has(pm, "url"):
		p.Type = "document"
		p.Name = str(pm["fileName"])
		p.MimeType = str(pm["mime"])
		mapPartURLFile(&p, str(pm["url"]), filesByRel)
	case has(pm, "url"):
		url := str(pm["url"])
		pType := inferMediaType(url, typeStr)
		p.Type = pType
		mapPartURLFile(&p, url, filesByRel)
	default:
		p.Type = "text"
		p.Content = "[unsupported rikka part]"
		p.Metadata["raw"] = pm
	}
	if len(p.Metadata) == 0 {
		p.Metadata = nil
	}
	return p
}

func mapPartURLFile(p *ir.IRPart, url string, filesByRel map[string]ir.IRFile) {
	if url == "" {
		return
	}
	p.MediaURL = url
	if !strings.HasPrefix(url, "file://") {
		return
	}
	fileName := filepath.Base(strings.TrimPrefix(url, "file://"))
	if fileName == "." || fileName == "/" || fileName == "" {
		return
	}
	relPath := "upload/" + fileName
	if f, ok := filesByRel[relPath]; ok {
		p.FileID = f.ID
		if p.Name == "" {
			p.Name = f.Name
		}
		if p.MimeType == "" {
			p.MimeType = f.MimeType
		}
	}
}

func inferMediaType(url, typeField string) string {
	lowType := strings.ToLower(typeField)
	if strings.Contains(lowType, ".video") {
		return "video"
	}
	if strings.Contains(lowType, ".audio") {
		return "audio"
	}
	if strings.Contains(lowType, ".image") {
		return "image"
	}
	ext := strings.ToLower(filepath.Ext(url))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif":
		return "image"
	case ".mp4", ".mov", ".mkv", ".webm":
		return "video"
	case ".mp3", ".wav", ".m4a", ".aac", ".ogg":
		return "audio"
	default:
		return "document"
	}
}

func sortedFiles(m map[string]ir.IRFile) []ir.IRFile {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]ir.IRFile, 0, len(keys))
	for _, k := range keys {
		out = append(out, m[k])
	}
	return out
}

func has(m map[string]any, key string) bool {
	_, ok := m[key]
	return ok
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
	return s
}

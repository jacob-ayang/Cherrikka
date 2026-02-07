package rikka

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	guuid "github.com/google/uuid"
	_ "modernc.org/sqlite"

	"cherrikka/internal/ir"
	"cherrikka/internal/mapping"
	"cherrikka/internal/util"
)

func BuildFromIR(in *ir.BackupIR, outputDir, templateDir string, redactSecrets bool, idMap map[string]string) ([]string, error) {
	warnings := []string{}
	if err := util.EnsureDir(filepath.Join(outputDir, "upload")); err != nil {
		return nil, err
	}

	warnings = append(warnings, mapping.EnsureNormalizedSettings(in)...)

	settingsBase := loadBaseSettings(in, templateDir)
	settings, mappingWarnings := mapping.BuildRikkaSettingsFromIR(in, settingsBase)
	warnings = append(warnings, mappingWarnings...)
	if redactSecrets {
		redacted, _ := util.RedactAny(settings).(map[string]any)
		settings = redacted
	}
	settingsJSON, err := json.Marshal(settings)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(outputDir, "settings.json"), settingsJSON, 0o644); err != nil {
		return nil, err
	}

	dbPath := filepath.Join(outputDir, "rikka_hub.db")
	identityHash := resolveIdentityHash(templateDir)
	if err := createRikkaDB(dbPath, identityHash); err != nil {
		return nil, err
	}
	// Ensure restore overwrites stale WAL/SHM files in target app.
	if err := os.WriteFile(filepath.Join(outputDir, "rikka_hub-wal"), nil, 0o644); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(outputDir, "rikka_hub-shm"), nil, 0o644); err != nil {
		return nil, err
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	filePathByID := map[string]string{}
	fileWarnings, err := materializeFiles(db, outputDir, in.Files, filePathByID, idMap)
	if err != nil {
		return nil, err
	}
	warnings = append(warnings, fileWarnings...)
	resolveAssistantID := newAssistantResolver(settings)
	convWarnings, err := writeConversations(db, in.Conversations, filePathByID, idMap, resolveAssistantID)
	if err != nil {
		return nil, err
	}
	warnings = append(warnings, convWarnings...)
	return dedupeWarnings(warnings), nil
}

func loadBaseSettings(in *ir.BackupIR, templateDir string) map[string]any {
	settings := map[string]any{}
	if templateDir != "" {
		if b, ok, _ := util.ReadFileIfExists(filepath.Join(templateDir, "settings.json")); ok {
			_ = json.Unmarshal(b, &settings)
		}
	}
	if len(settings) == 0 {
		if cfg, ok := in.Config["rikka.settings"].(map[string]any); ok {
			for k, v := range cfg {
				settings[k] = v
			}
		}
	}
	if len(settings) == 0 {
		settings = map[string]any{
			"assistantId": "0950e2dc-9bd5-4801-afa3-aa887aa36b4e",
			"providers":   []any{},
			"assistants":  []any{},
		}
	}
	return settings
}

func resolveIdentityHash(templateDir string) string {
	if templateDir == "" {
		return defaultIdentityHash
	}
	dbPath := filepath.Join(templateDir, "rikka_hub.db")
	if _, err := os.Stat(dbPath); err != nil {
		return defaultIdentityHash
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return defaultIdentityHash
	}
	defer db.Close()
	var hash string
	err = db.QueryRow(`SELECT identity_hash FROM room_master_table WHERE id = 42`).Scan(&hash)
	if err != nil || hash == "" {
		return defaultIdentityHash
	}
	return hash
}

func createRikkaDB(dbPath, identityHash string) error {
	if err := os.RemoveAll(dbPath); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	for _, stmt := range schemaSQL {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("schema exec failed: %w", err)
		}
	}
	if _, err := db.Exec(`INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, ?)`, identityHash); err != nil {
		return err
	}
	return nil
}

func materializeFiles(db *sql.DB, outputDir string, files []ir.IRFile, pathByID map[string]string, idMap map[string]string) ([]string, error) {
	warnings := []string{}
	usedRelPath := map[string]struct{}{}

	for _, f := range files {
		fileID := f.ID
		if fileID == "" {
			fileID = util.NewUUID()
		}
		ext := f.Ext
		if ext == "" {
			ext = filepath.Ext(f.Name)
		}
		relPath := preferredRikkaRelPath(f, ext)
		if _, exists := usedRelPath[relPath]; exists {
			relPath = filepath.ToSlash(filepath.Join("upload", util.NewUUID()+ext))
		}
		usedRelPath[relPath] = struct{}{}
		fileName := filepath.Base(relPath)
		fullPath := filepath.Join(outputDir, filepath.FromSlash(relPath))
		if f.SourcePath != "" {
			if err := util.CopyFile(f.SourcePath, fullPath); err != nil {
				return nil, err
			}
		} else {
			if err := os.WriteFile(fullPath, nil, 0o644); err != nil {
				return nil, err
			}
			warnings = append(warnings, fmt.Sprintf("file %s missing source payload; created empty placeholder", fileID))
		}
		st, _ := os.Stat(fullPath)
		size := int64(0)
		if st != nil {
			size = st.Size()
		}
		createdAt := parseMillisOrNow(f.CreatedAt)
		updatedAt := parseMillisOrNow(f.UpdatedAt)
		if _, err := db.Exec(`INSERT INTO managed_files (folder, relative_path, display_name, mime_type, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			"upload", relPath, fallbackName(f.Name, fileName), fallbackString(f.MimeType, "application/octet-stream"), size, createdAt, updatedAt,
		); err != nil {
			return nil, err
		}
		pathByID[fileID] = absRikkaUploadPath(fileName)
		idMap["file:"+f.ID] = relPath
	}
	return dedupeWarnings(warnings), nil
}

func writeConversations(
	db *sql.DB,
	convs []ir.IRConversation,
	filePathByID map[string]string,
	idMap map[string]string,
	resolveAssistantID func(string) string,
) ([]string, error) {
	warnings := []string{}
	for _, conv := range convs {
		convID := normalizeUUIDOrDeterministic(conv.ID, "conversation:"+conv.ID+":"+conv.Title)
		idMap["topic:"+conv.ID] = convID
		created := parseTimeMillis(conv.CreatedAt)
		updated := parseTimeMillis(conv.UpdatedAt)
		assistantID := resolveAssistantID(conv.AssistantID)
		if _, err := db.Exec(`INSERT INTO ConversationEntity (id, assistant_id, title, nodes, create_at, update_at, truncate_index, suggestions, is_pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			convID,
			assistantID,
			deriveRikkaConversationTitle(conv),
			"[]",
			created,
			updated,
			-1,
			"[]",
			0,
		); err != nil {
			return nil, err
		}
		for idx, m := range conv.Messages {
			for _, p := range m.Parts {
				if p.FileID != "" {
					if _, ok := filePathByID[p.FileID]; !ok {
						warnings = append(warnings, fmt.Sprintf("conversation %s message %s references missing file %s", convID, m.ID, p.FileID))
					}
				}
			}
			nodeID := util.NewUUID()
			msg := rikkaMessageFromIR(m, filePathByID)
			msgJSON := util.MustJSON([]any{msg})
			if _, err := db.Exec(`INSERT INTO message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)`,
				nodeID,
				convID,
				idx,
				msgJSON,
				0,
			); err != nil {
				return nil, err
			}
			if sid, ok := msg["id"].(string); ok {
				idMap["message:"+m.ID] = sid
			}
		}
	}
	return dedupeWarnings(warnings), nil
}

func deriveRikkaConversationTitle(conv ir.IRConversation) string {
	if title := normalizeConversationTitleText(conv.Title); title != "" {
		return title
	}
	if title := deriveTitleFromMessages(conv.Messages, true); title != "" {
		return title
	}
	if title := deriveTitleFromMessages(conv.Messages, false); title != "" {
		return title
	}
	return "Imported Conversation"
}

func deriveTitleFromMessages(messages []ir.IRMessage, preferUser bool) string {
	for _, m := range messages {
		if preferUser && !strings.EqualFold(strings.TrimSpace(m.Role), "user") {
			continue
		}
		for _, p := range m.Parts {
			switch p.Type {
			case "text", "reasoning":
				if title := normalizeConversationTitleText(p.Content); title != "" {
					return title
				}
			case "tool":
				if title := normalizeConversationTitleText(p.Name); title != "" {
					return title
				}
				if title := normalizeConversationTitleText(p.Content); title != "" {
					return title
				}
			case "document", "image", "video", "audio":
				if title := normalizeConversationTitleText(p.Name); title != "" {
					return title
				}
			}
		}
	}
	return ""
}

func normalizeConversationTitleText(input string) string {
	s := strings.TrimSpace(input)
	if s == "" {
		return ""
	}
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return ""
	}
	runes := []rune(s)
	const maxRunes = 80
	if len(runes) > maxRunes {
		s = strings.TrimSpace(string(runes[:maxRunes])) + "…"
	}
	return s
}

func rikkaMessageFromIR(m ir.IRMessage, filePathByID map[string]string) map[string]any {
	messageID := normalizeUUIDOrDeterministic(m.ID, "message:"+m.ID+":"+m.Role)
	parts := make([]any, 0, len(m.Parts))
	for _, p := range m.Parts {
		parts = append(parts, rikkaPartFromIR(p, filePathByID))
	}
	if len(parts) == 0 {
		parts = append(parts, map[string]any{
			"type": "me.rerere.ai.ui.UIMessagePart.Text",
			"text": "",
		})
	}
	return map[string]any{
		"id":          messageID,
		"role":        normalizeRikkaRole(m.Role),
		"parts":       parts,
		"annotations": []any{},
	}
}

func rikkaPartFromIR(p ir.IRPart, filePathByID map[string]string) map[string]any {
	switch p.Type {
	case "reasoning":
		return map[string]any{
			"type":      "me.rerere.ai.ui.UIMessagePart.Reasoning",
			"reasoning": p.Content,
		}
	case "tool":
		out := make([]any, 0, len(p.Output))
		for _, o := range p.Output {
			out = append(out, map[string]any{
				"type": "me.rerere.ai.ui.UIMessagePart.Text",
				"text": o.Content,
			})
		}
		return map[string]any{
			"type":       "me.rerere.ai.ui.UIMessagePart.Tool",
			"toolCallId": normalizeUUIDOrDeterministic(p.ToolCallID, "tool-call:"+p.ToolCallID+":"+p.Name),
			"toolName":   fallbackName(p.Name, "tool"),
			"input":      fallbackString(strings.TrimSpace(p.Input), "{}"),
			"output":     out,
		}
	case "image":
		return map[string]any{
			"type": "me.rerere.ai.ui.UIMessagePart.Image",
			"url":  chooseMediaURL(p, filePathByID),
		}
	case "video":
		return map[string]any{
			"type": "me.rerere.ai.ui.UIMessagePart.Video",
			"url":  chooseMediaURL(p, filePathByID),
		}
	case "audio":
		return map[string]any{
			"type": "me.rerere.ai.ui.UIMessagePart.Audio",
			"url":  chooseMediaURL(p, filePathByID),
		}
	case "document":
		return map[string]any{
			"type":     "me.rerere.ai.ui.UIMessagePart.Document",
			"url":      chooseMediaURL(p, filePathByID),
			"fileName": fallbackName(p.Name, "document"),
			"mime":     fallbackString(p.MimeType, "application/octet-stream"),
		}
	default:
		return map[string]any{
			"type": "me.rerere.ai.ui.UIMessagePart.Text",
			"text": p.Content,
		}
	}
}

func chooseMediaURL(p ir.IRPart, filePathByID map[string]string) string {
	if p.FileID != "" {
		if v, ok := filePathByID[p.FileID]; ok {
			return "file://" + v
		}
	}
	if strings.HasPrefix(p.MediaURL, "file://") {
		return p.MediaURL
	}
	if p.MediaURL != "" {
		return p.MediaURL
	}
	return ""
}

func absRikkaUploadPath(fileName string) string {
	return filepath.ToSlash(filepath.Join("/data/user/0/me.rerere.rikkahub/files/upload", fileName))
}

func preferredRikkaRelPath(f ir.IRFile, ext string) string {
	meta := asMetaMap(f.Metadata)
	if rel := pickRelPath(meta["rikka.relative_path"]); rel != "" {
		return rel
	}
	if rel := pickRelPath(f.RelativeSrc); rel != "" {
		return rel
	}
	return filepath.ToSlash(filepath.Join("upload", util.NewUUID()+ext))
}

func pickRelPath(v any) string {
	s, _ := v.(string)
	s = filepath.ToSlash(strings.TrimSpace(s))
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, "upload/") {
		return s
	}
	base := filepath.Base(s)
	if base == "." || base == "/" || base == "" {
		return ""
	}
	return filepath.ToSlash(filepath.Join("upload", base))
}

func asMetaMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

func parseMillisOrNow(v string) int64 {
	if strings.TrimSpace(v) == "" {
		return time.Now().UnixMilli()
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t.UnixMilli()
	}
	return time.Now().UnixMilli()
}

func newAssistantResolver(settings map[string]any) func(string) string {
	assistantIDs := map[string]struct{}{}
	first := ""
	for _, item := range asSlice(settings["assistants"]) {
		am := asMap(item)
		id := strings.TrimSpace(str(am["id"]))
		if id == "" {
			continue
		}
		if !isValidUUID(id) {
			continue
		}
		if first == "" {
			first = id
		}
		assistantIDs[id] = struct{}{}
	}
	selected := strings.TrimSpace(str(settings["assistantId"]))
	if !isValidUUID(selected) {
		selected = ""
	}
	if selected != "" {
		if _, ok := assistantIDs[selected]; !ok {
			selected = ""
		}
	}
	fallback := selected
	if fallback == "" {
		fallback = first
	}
	if fallback == "" {
		fallback = "0950e2dc-9bd5-4801-afa3-aa887aa36b4e"
	}
	return func(candidate string) string {
		candidate = strings.TrimSpace(candidate)
		if candidate != "" {
			if _, ok := assistantIDs[candidate]; ok {
				return candidate
			}
			// Cherry assistant IDs are often non-UUID (for example "default").
			// Normalize with the same deterministic seed used by settings mapping.
			normalized := normalizeUUIDOrDeterministic(candidate, "assistant:"+candidate)
			if _, ok := assistantIDs[normalized]; ok {
				return normalized
			}
		}
		return fallback
	}
}

func normalizeUUIDOrDeterministic(candidate, seed string) string {
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

func normalizeRikkaRole(role string) string {
	r := strings.ToLower(strings.TrimSpace(role))
	switch r {
	case "user", "assistant", "system", "tool":
		return r
	default:
		return "assistant"
	}
}

func parseTimeMillis(v string) int64 {
	if v == "" {
		return time.Now().UnixMilli()
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return time.Now().UnixMilli()
	}
	return t.UnixMilli()
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

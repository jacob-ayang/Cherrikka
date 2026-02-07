package app

import (
	"archive/zip"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"cherrikka/internal/backup"
	"cherrikka/internal/cherry"
	"cherrikka/internal/ir"
	"cherrikka/internal/rikka"
	"cherrikka/internal/util"

	_ "modernc.org/sqlite"
)

func TestConvertCherryToRikkaAndBack(t *testing.T) {
	srcCherryZip := buildSampleCherryBackup(t)

	outRikka := filepath.Join(t.TempDir(), "to_rikka.zip")
	manifest1, err := Convert(ConvertOptions{
		InputPath:  srcCherryZip,
		OutputPath: outRikka,
		From:       "auto",
		To:         "rikka",
	})
	if err != nil {
		t.Fatalf("convert cherry->rikka failed: %v", err)
	}

	val1, err := Validate(outRikka)
	if err != nil {
		t.Fatalf("validate rikka failed: %v", err)
	}
	if !val1.Valid {
		t.Fatalf("expected valid rikka backup, issues=%v", val1.Issues)
	}
	if val1.ConfigSummary == nil || val1.FileSummary == nil {
		t.Fatalf("expected validate summaries for rikka output")
	}
	if manifest1.SourceFormat != "cherry" || manifest1.TargetFormat != "rikka" {
		t.Fatalf("unexpected manifest: %+v", manifest1)
	}
	assertZipHasEntries(t, outRikka, "rikka_hub-wal", "rikka_hub-shm")
	assertSidecarMatchesSource(t, outRikka, srcCherryZip)

	outCherry := filepath.Join(t.TempDir(), "to_cherry.zip")
	manifest2, err := Convert(ConvertOptions{
		InputPath:  outRikka,
		OutputPath: outCherry,
		From:       "auto",
		To:         "cherry",
	})
	if err != nil {
		t.Fatalf("convert rikka->cherry failed: %v", err)
	}
	val2, err := Validate(outCherry)
	if err != nil {
		t.Fatalf("validate cherry failed: %v", err)
	}
	if !val2.Valid {
		t.Fatalf("expected valid cherry backup, issues=%v", val2.Issues)
	}
	if val2.ConfigSummary == nil || val2.FileSummary == nil {
		t.Fatalf("expected validate summaries for cherry output")
	}
	if manifest2.SourceFormat != "rikka" || manifest2.TargetFormat != "cherry" {
		t.Fatalf("unexpected second manifest: %+v", manifest2)
	}
	assertSidecarMatchesSource(t, outCherry, outRikka)

	ins, err := Inspect(outCherry)
	if err != nil {
		t.Fatalf("inspect failed: %v", err)
	}
	if ins.Conversations == 0 {
		t.Fatalf("expected conversations in converted cherry")
	}
	if ins.ConfigSummary == nil || ins.FileSummary == nil {
		t.Fatalf("expected inspect summaries")
	}
}

func TestConvertWithRedaction(t *testing.T) {
	srcRikka := buildSampleRikkaBackup(t)
	outRikka := filepath.Join(t.TempDir(), "redacted_rikka.zip")
	_, err := Convert(ConvertOptions{
		InputPath:     srcRikka,
		OutputPath:    outRikka,
		From:          "auto",
		To:            "rikka",
		RedactSecrets: true,
	})
	if err != nil {
		t.Fatalf("convert with redaction failed: %v", err)
	}

	dir := unzipTemp(t, outRikka)
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !containsString(string(b), "***REDACTED***") {
		t.Fatalf("expected redacted marker in output")
	}
}

func TestConvertCherryToRikka_DerivesTitleWhenTopicNameMissing(t *testing.T) {
	srcCherryZip := buildSampleCherryBackupWithoutTopicName(t)
	outRikka := filepath.Join(t.TempDir(), "to_rikka_no_topic_name.zip")
	if _, err := Convert(ConvertOptions{
		InputPath:  srcCherryZip,
		OutputPath: outRikka,
		From:       "auto",
		To:         "rikka",
	}); err != nil {
		t.Fatalf("convert cherry->rikka failed: %v", err)
	}

	val, err := Validate(outRikka)
	if err != nil {
		t.Fatalf("validate rikka failed: %v", err)
	}
	if !val.Valid {
		t.Fatalf("expected valid rikka output, got issues=%v", val.Issues)
	}

	dir := unzipTemp(t, outRikka)
	db, err := sql.Open("sqlite", filepath.Join(dir, "rikka_hub.db"))
	if err != nil {
		t.Fatalf("open output db failed: %v", err)
	}
	defer db.Close()

	var title string
	if err := db.QueryRow(`SELECT title FROM ConversationEntity LIMIT 1`).Scan(&title); err != nil {
		t.Fatalf("query title failed: %v", err)
	}
	if title == "" || title == "Imported Conversation" {
		t.Fatalf("expected derived title, got=%q", title)
	}
}

func buildSampleIR() *ir.BackupIR {
	now := time.Now().UTC().Format(time.RFC3339)
	fileID := "file-1"
	assistantID := "assistant-1"
	convID := "conv-1"
	msg1 := ir.IRMessage{
		ID:        "msg-1",
		Role:      "user",
		CreatedAt: now,
		Parts: []ir.IRPart{{
			Type:    "text",
			Content: "Hello from sample",
		}},
	}
	msg2 := ir.IRMessage{
		ID:        "msg-2",
		Role:      "assistant",
		CreatedAt: now,
		Parts: []ir.IRPart{
			{Type: "reasoning", Content: "thinking"},
			{Type: "text", Content: "answer"},
			{Type: "document", FileID: fileID, Name: "sample.txt", MimeType: "text/plain"},
		},
	}
	return &ir.BackupIR{
		SourceApp:    "test",
		SourceFormat: "test",
		CreatedAt:    time.Now().UTC(),
		Assistants: []ir.IRAssistant{{
			ID:       assistantID,
			Name:     "Sample Assistant",
			Prompt:   "You are helpful",
			Settings: map[string]any{},
		}},
		Conversations: []ir.IRConversation{{
			ID:          convID,
			AssistantID: assistantID,
			Title:       "Sample Conversation",
			CreatedAt:   now,
			UpdatedAt:   now,
			Messages:    []ir.IRMessage{msg1, msg2},
		}},
		Files: []ir.IRFile{{
			ID:       fileID,
			Name:     "sample.txt",
			MimeType: "text/plain",
			Ext:      ".txt",
		}},
		Config: map[string]any{
			"rikka.settings": map[string]any{
				"providers":  []any{map[string]any{"name": "OpenAI", "apiKey": "secret-key"}},
				"assistants": []any{map[string]any{"id": assistantID, "name": "Sample Assistant"}},
			},
		},
	}
}

func buildSampleCherryBackup(t *testing.T) string {
	t.Helper()
	irData := buildSampleIR()
	dataDir := t.TempDir()
	idMap := map[string]string{}

	filePath := filepath.Join(t.TempDir(), "sample.txt")
	if err := os.WriteFile(filePath, []byte("sample file content"), 0o644); err != nil {
		t.Fatal(err)
	}
	irData.Files[0].SourcePath = filePath
	irData.Config["cherry.settings"] = map[string]any{"apiKey": "secret-key"}

	if _, err := cherry.BuildFromIR(irData, dataDir, "", false, idMap); err != nil {
		t.Fatalf("build cherry from IR failed: %v", err)
	}
	zipPath := filepath.Join(t.TempDir(), "sample_cherry.zip")
	zipDir(t, dataDir, zipPath)
	return zipPath
}

func buildSampleRikkaBackup(t *testing.T) string {
	t.Helper()
	irData := buildSampleIR()
	dataDir := t.TempDir()
	idMap := map[string]string{}

	filePath := filepath.Join(t.TempDir(), "sample.txt")
	if err := os.WriteFile(filePath, []byte("sample file content"), 0o644); err != nil {
		t.Fatal(err)
	}
	irData.Files[0].SourcePath = filePath

	if _, err := rikka.BuildFromIR(irData, dataDir, "", false, idMap); err != nil {
		t.Fatalf("build rikka from IR failed: %v", err)
	}
	zipPath := filepath.Join(t.TempDir(), "sample_rikka.zip")
	zipDir(t, dataDir, zipPath)
	return zipPath
}

func buildSampleCherryBackupWithoutTopicName(t *testing.T) string {
	t.Helper()
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "Data", "Files"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "Data", "Files", ".keep"), []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}

	data := map[string]any{
		"time":    time.Now().UnixMilli(),
		"version": 5,
		"localStorage": map[string]any{
			"persist:cherry-studio": "{}",
		},
		"indexedDB": map[string]any{
			"topics": []any{
				map[string]any{
					"id": "topic-1",
					"messages": []any{
						map[string]any{
							"id":        "msg-1",
							"role":      "user",
							"createdAt": time.Now().UTC().Format(time.RFC3339),
							"blocks":    []any{"block-1"},
						},
					},
				},
			},
			"message_blocks": []any{
				map[string]any{
					"id":        "block-1",
					"messageId": "msg-1",
					"type":      "main_text",
					"content":   "Hello from title fallback",
				},
			},
			"files": []any{},
		},
	}
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "data.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}

	zipPath := filepath.Join(t.TempDir(), "sample_cherry_no_topic_name.zip")
	zipDir(t, dataDir, zipPath)
	return zipPath
}

func zipDir(t *testing.T, dir, outZip string) {
	t.Helper()
	paths, err := util.ListFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	entries := make([]backup.ZipEntry, 0, len(paths))
	for _, rel := range paths {
		entries = append(entries, backup.ZipEntry{Path: rel, SourcePath: filepath.Join(dir, filepath.FromSlash(rel))})
	}
	if err := backup.WriteZip(outZip, entries); err != nil {
		t.Fatal(err)
	}
}

func unzipTemp(t *testing.T, zipPath string) string {
	t.Helper()
	dir := t.TempDir()
	if err := backup.ExtractZip(zipPath, dir); err != nil {
		t.Fatal(err)
	}
	return dir
}

func assertSidecarMatchesSource(t *testing.T, convertedZip, sourceZip string) {
	t.Helper()
	dir := unzipTemp(t, convertedZip)
	manifestPath := filepath.Join(dir, "cherrikka", "manifest.json")
	sourcePath := filepath.Join(dir, "cherrikka", "raw", "source.zip")

	mb, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("read manifest failed: %v", err)
	}
	var m ir.Manifest
	if err := json.Unmarshal(mb, &m); err != nil {
		t.Fatalf("parse manifest failed: %v", err)
	}

	srcBytes, err := os.ReadFile(sourceZip)
	if err != nil {
		t.Fatal(err)
	}
	if got := util.SHA256Hex(srcBytes); got != m.SourceSHA256 {
		t.Fatalf("manifest source hash mismatch: got=%s want=%s", m.SourceSHA256, got)
	}

	rawBytes, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatalf("read source sidecar failed: %v", err)
	}
	if util.SHA256Hex(rawBytes) != util.SHA256Hex(srcBytes) {
		t.Fatalf("source sidecar content mismatch")
	}

	// spot-check sidecar entries are in the zip central directory too
	zr, err := zip.OpenReader(convertedZip)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	seenManifest := false
	seenSource := false
	for _, f := range zr.File {
		if f.Name == "cherrikka/manifest.json" {
			seenManifest = true
		}
		if f.Name == "cherrikka/raw/source.zip" {
			seenSource = true
		}
	}
	if !seenManifest || !seenSource {
		t.Fatalf("sidecar entries missing in output zip")
	}
}

func assertZipHasEntries(t *testing.T, zipPath string, entries ...string) {
	t.Helper()
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	seen := map[string]bool{}
	for _, target := range entries {
		seen[target] = false
	}
	for _, f := range zr.File {
		if _, ok := seen[f.Name]; ok {
			seen[f.Name] = true
		}
	}
	for _, target := range entries {
		if !seen[target] {
			t.Fatalf("zip entry missing: %s", target)
		}
	}
}

func containsString(s, needle string) bool {
	return len(s) >= len(needle) && (s == needle || (len(s) > 0 && (indexOf(s, needle) >= 0)))
}

func indexOf(s, needle string) int {
	for i := 0; i+len(needle) <= len(s); i++ {
		if s[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

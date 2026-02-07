package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"cherrikka/internal/backup"
	"cherrikka/internal/cherry"
	"cherrikka/internal/ir"
	"cherrikka/internal/mapping"
	"cherrikka/internal/rikka"
	"cherrikka/internal/util"
)

type ConfigSummary struct {
	Providers  int  `json:"providers"`
	Assistants int  `json:"assistants"`
	HasWebDAV  bool `json:"hasWebdav"`
	HasS3      bool `json:"hasS3"`
}

type FileSummary struct {
	Total      int `json:"total"`
	Referenced int `json:"referenced"`
	Orphan     int `json:"orphan"`
	Missing    int `json:"missing"`
}

type InspectResult struct {
	Format        string         `json:"format"`
	Hints         []string       `json:"hints"`
	Conversations int            `json:"conversations"`
	Assistants    int            `json:"assistants"`
	Files         int            `json:"files"`
	SourceApp     string         `json:"sourceApp"`
	ConfigSummary *ConfigSummary `json:"configSummary,omitempty"`
	FileSummary   *FileSummary   `json:"fileSummary,omitempty"`
}

type ValidateResult struct {
	Valid         bool           `json:"valid"`
	Format        string         `json:"format"`
	Issues        []string       `json:"issues"`
	Errors        []string       `json:"errors,omitempty"`
	Warnings      []string       `json:"warnings,omitempty"`
	ConfigSummary *ConfigSummary `json:"configSummary,omitempty"`
	FileSummary   *FileSummary   `json:"fileSummary,omitempty"`
}

type ConvertOptions struct {
	InputPath     string
	OutputPath    string
	From          string // auto|cherry|rikka
	To            string // cherry|rikka
	TemplatePath  string
	RedactSecrets bool
}

func Inspect(path string) (*InspectResult, error) {
	workDir, cleanup, err := extractToTemp(path)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	d := backup.DetectExtractedDir(workDir)
	if d.Format == backup.FormatUnknown {
		return &InspectResult{Format: "unknown", Hints: d.Hints}, nil
	}

	parsed, err := parseByFormat(d.Format, workDir)
	if err != nil {
		return nil, err
	}
	return &InspectResult{
		Format:        string(d.Format),
		Hints:         d.Hints,
		Conversations: len(parsed.Conversations),
		Assistants:    len(parsed.Assistants),
		Files:         len(parsed.Files),
		SourceApp:     parsed.SourceApp,
		ConfigSummary: summarizeConfig(parsed),
		FileSummary:   summarizeFiles(parsed),
	}, nil
}

func Validate(path string) (*ValidateResult, error) {
	workDir, cleanup, err := extractToTemp(path)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	d := backup.DetectExtractedDir(workDir)
	if d.Format == backup.FormatUnknown {
		return &ValidateResult{Valid: false, Format: "unknown", Issues: []string{"unknown backup format"}}, nil
	}

	errorsList := []string{}
	warnings := []string{}
	switch d.Format {
	case backup.FormatCherry:
		if err := cherry.ValidateExtracted(workDir); err != nil {
			errorsList = append(errorsList, err.Error())
		}
	case backup.FormatRikka:
		if err := rikka.ValidateExtracted(workDir); err != nil {
			errorsList = append(errorsList, err.Error())
		}
	}

	irData, err := parseByFormat(d.Format, workDir)
	if err != nil {
		errorsList = append(errorsList, err.Error())
	}
	var cfgSummary *ConfigSummary
	var fileSummary *FileSummary
	if irData != nil {
		warnings = append(warnings, irData.Warnings...)
		if len(irData.Conversations) == 0 {
			errorsList = append(errorsList, "no conversations found")
		}
		cfgSummary = summarizeConfig(irData)
		fileSummary = summarizeFiles(irData)
		if fileSummary != nil && fileSummary.Missing > 0 {
			warnings = append(warnings, fmt.Sprintf("found %d missing file payload(s)", fileSummary.Missing))
		}
	}
	errorsList = dedupeStrings(errorsList)
	warnings = dedupeStrings(warnings)
	issues := append([]string{}, errorsList...)
	issues = append(issues, warnings...)

	return &ValidateResult{
		Valid:         len(errorsList) == 0,
		Format:        string(d.Format),
		Issues:        issues,
		Errors:        errorsList,
		Warnings:      warnings,
		ConfigSummary: cfgSummary,
		FileSummary:   fileSummary,
	}, nil
}

func Convert(opts ConvertOptions) (*ir.Manifest, error) {
	if opts.InputPath == "" || opts.OutputPath == "" {
		return nil, fmt.Errorf("input and output are required")
	}
	to := strings.ToLower(strings.TrimSpace(opts.To))
	if to != "cherry" && to != "rikka" {
		return nil, fmt.Errorf("--to must be cherry or rikka")
	}

	inDir, cleanupIn, err := extractToTemp(opts.InputPath)
	if err != nil {
		return nil, err
	}
	defer cleanupIn()

	d := backup.DetectExtractedDir(inDir)
	if d.Format == backup.FormatUnknown {
		return nil, fmt.Errorf("cannot detect backup format")
	}
	from := strings.ToLower(strings.TrimSpace(opts.From))
	if from == "" {
		from = "auto"
	}
	if from != "auto" && from != string(d.Format) {
		return nil, fmt.Errorf("source format mismatch: detected=%s flag=%s", d.Format, from)
	}

	sourceIR, err := parseByFormat(d.Format, inDir)
	if err != nil {
		return nil, err
	}
	sourceIR.Warnings = append(sourceIR.Warnings, mapping.EnsureNormalizedSettings(sourceIR)...)
	sourceIR.TargetFormat = to
	sourceIR.DetectedHints = d.Hints

	if opts.RedactSecrets {
		sourceIR.Config = util.RedactAny(sourceIR.Config).(map[string]any)
		if len(sourceIR.Settings) > 0 {
			if redacted, ok := util.RedactAny(sourceIR.Settings).(map[string]any); ok {
				sourceIR.Settings = redacted
			}
		}
	}

	templateDir := ""
	cleanupTemplate := func() {}
	if opts.TemplatePath != "" {
		templateDir, cleanupTemplate, err = extractToTemp(opts.TemplatePath)
		if err != nil {
			return nil, err
		}
		defer cleanupTemplate()
	}

	buildDir, err := os.MkdirTemp("", "cherrikka-build-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(buildDir)

	idMap := map[string]string{}
	buildWarnings := []string{}
	if to == "cherry" {
		buildWarnings, err = cherry.BuildFromIR(sourceIR, buildDir, templateDir, opts.RedactSecrets, idMap)
		if err != nil {
			return nil, err
		}
	} else {
		buildWarnings, err = rikka.BuildFromIR(sourceIR, buildDir, templateDir, opts.RedactSecrets, idMap)
		if err != nil {
			return nil, err
		}
	}

	sourceBytes, err := os.ReadFile(opts.InputPath)
	if err != nil {
		return nil, err
	}
	manifest := &ir.Manifest{
		SchemaVersion: 1,
		SourceApp:     sourceIR.SourceApp,
		SourceFormat:  string(d.Format),
		SourceSHA256:  util.SHA256Hex(sourceBytes),
		TargetApp:     targetAppName(to),
		TargetFormat:  to,
		IDMap:         idMap,
		Redaction:     opts.RedactSecrets,
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
		Warnings:      dedupeStrings(append(append([]string{}, sourceIR.Warnings...), buildWarnings...)),
	}

	if err := writeSidecar(buildDir, sourceBytes, manifest); err != nil {
		return nil, err
	}

	entries, err := collectZipEntries(buildDir)
	if err != nil {
		return nil, err
	}
	if err := backup.WriteZip(opts.OutputPath, entries); err != nil {
		return nil, err
	}
	return manifest, nil
}

func parseByFormat(format backup.Format, dir string) (*ir.BackupIR, error) {
	switch format {
	case backup.FormatCherry:
		return cherry.ParseToIR(dir)
	case backup.FormatRikka:
		return rikka.ParseToIR(dir)
	default:
		return nil, fmt.Errorf("unsupported format: %s", format)
	}
}

func extractToTemp(zipPath string) (string, func(), error) {
	tmp, err := os.MkdirTemp("", "cherrikka-zip-*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	if err := backup.ExtractZip(zipPath, tmp); err != nil {
		cleanup()
		return "", nil, err
	}
	return tmp, cleanup, nil
}

func writeSidecar(buildDir string, sourceZip []byte, manifest *ir.Manifest) error {
	sidecarDir := filepath.Join(buildDir, "cherrikka")
	if err := util.EnsureDir(filepath.Join(sidecarDir, "raw")); err != nil {
		return err
	}
	mb, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(sidecarDir, "manifest.json"), mb, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(sidecarDir, "raw", "source.zip"), sourceZip, 0o644); err != nil {
		return err
	}
	return nil
}

func collectZipEntries(root string) ([]backup.ZipEntry, error) {
	paths, err := util.ListFiles(root)
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	entries := make([]backup.ZipEntry, 0, len(paths))
	for _, rel := range paths {
		entries = append(entries, backup.ZipEntry{Path: rel, SourcePath: filepath.Join(root, filepath.FromSlash(rel))})
	}
	return entries, nil
}

func targetAppName(to string) string {
	if to == "cherry" {
		return "cherry-studio"
	}
	return "rikkahub"
}

func summarizeConfig(parsed *ir.BackupIR) *ConfigSummary {
	if parsed == nil {
		return nil
	}
	if len(parsed.Settings) == 0 {
		_ = mapping.EnsureNormalizedSettings(parsed)
	}
	s := &ConfigSummary{
		Providers:  len(asSlice(parsed.Settings["core.providers"])),
		Assistants: len(asSlice(parsed.Settings["core.assistants"])),
		HasWebDAV:  len(asMap(parsed.Settings["sync.webdav"])) > 0,
		HasS3:      len(asMap(parsed.Settings["sync.s3"])) > 0,
	}
	return s
}

func summarizeFiles(parsed *ir.BackupIR) *FileSummary {
	if parsed == nil {
		return nil
	}
	ref := referencedFileIDs(parsed)
	out := &FileSummary{
		Total:      len(parsed.Files),
		Referenced: len(ref),
	}
	for _, f := range parsed.Files {
		if f.Orphan {
			out.Orphan++
		}
		if f.Missing || strings.TrimSpace(f.SourcePath) == "" {
			out.Missing++
		}
	}
	return out
}

func referencedFileIDs(parsed *ir.BackupIR) map[string]struct{} {
	out := map[string]struct{}{}
	for _, conv := range parsed.Conversations {
		for _, msg := range conv.Messages {
			for _, p := range msg.Parts {
				if strings.TrimSpace(p.FileID) == "" {
					continue
				}
				out[p.FileID] = struct{}{}
			}
		}
	}
	return out
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

func dedupeStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, item := range in {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

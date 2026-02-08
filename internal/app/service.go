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
	Providers           int  `json:"providers"`
	Assistants          int  `json:"assistants"`
	HasWebDAV           bool `json:"hasWebdav"`
	HasS3               bool `json:"hasS3"`
	IsolatedConfigItems int  `json:"isolatedConfigItems,omitempty"`
	RehydrationAvail    bool `json:"rehydrationAvailable,omitempty"`
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
	InputPath         string
	InputPaths        []string
	OutputPath        string
	From              string // auto|cherry|rikka
	To                string // cherry|rikka
	TemplatePath      string
	RedactSecrets     bool
	ConfigPrecedence  string // latest|first|target|source
	ConfigSourceIndex int    // 1-based, used when ConfigPrecedence=source
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
	inputPaths := normalizeInputPaths(opts.InputPath, opts.InputPaths)
	if len(inputPaths) == 0 || strings.TrimSpace(opts.OutputPath) == "" {
		return nil, fmt.Errorf("input and output are required")
	}
	to := strings.ToLower(strings.TrimSpace(opts.To))
	if to != "cherry" && to != "rikka" {
		return nil, fmt.Errorf("--to must be cherry or rikka")
	}
	from := strings.ToLower(strings.TrimSpace(opts.From))
	if from == "" {
		from = "auto"
	}
	if len(inputPaths) > 1 && from != "auto" {
		return nil, fmt.Errorf("multi-input convert only supports --from auto")
	}

	parsedSources := make([]parsedSource, 0, len(inputPaths))
	cleanupInputs := make([]func(), 0, len(inputPaths))
	defer func() {
		for _, cleanup := range cleanupInputs {
			cleanup()
		}
	}()
	for i, inputPath := range inputPaths {
		inDir, cleanupIn, err := extractToTemp(inputPath)
		if err != nil {
			return nil, err
		}
		cleanupInputs = append(cleanupInputs, cleanupIn)

		d := backup.DetectExtractedDir(inDir)
		if d.Format == backup.FormatUnknown {
			return nil, fmt.Errorf("cannot detect backup format: %s", filepath.Base(inputPath))
		}
		if from != "auto" && from != string(d.Format) {
			return nil, fmt.Errorf("source format mismatch: detected=%s flag=%s (%s)", d.Format, from, filepath.Base(inputPath))
		}

		sourceIR, parseErr := parseByFormat(d.Format, inDir)
		if parseErr != nil {
			return nil, parseErr
		}
		rehydrateWarnings, rehydrateErr := tryRehydrateFromSidecar(inDir, to, sourceIR)
		if rehydrateErr != nil {
			return nil, rehydrateErr
		}
		sourceIR.Warnings = append(sourceIR.Warnings, rehydrateWarnings...)
		sourceIR.Warnings = append(sourceIR.Warnings, mapping.EnsureNormalizedSettings(sourceIR)...)
		sourceIR.TargetFormat = to
		sourceIR.DetectedHints = d.Hints

		sourceBytes, readErr := os.ReadFile(inputPath)
		if readErr != nil {
			return nil, readErr
		}
		parsedSources = append(parsedSources, parsedSource{
			Index:       i + 1,
			Tag:         fmt.Sprintf("S%d", i+1),
			Path:        inputPath,
			Name:        filepath.Base(inputPath),
			Format:      string(d.Format),
			Hints:       d.Hints,
			SHA256:      util.SHA256Hex(sourceBytes),
			LatestUnix:  inferLatestUnixMillis(inputPath, sourceIR),
			SourceBytes: sourceBytes,
			IR:          sourceIR,
		})
	}

	mergedIR, mergeReport, err := mergeSources(parsedSources, MergeOptions{
		TargetFormat:      to,
		ConfigPrecedence:  opts.ConfigPrecedence,
		ConfigSourceIndex: opts.ConfigSourceIndex,
	})
	if err != nil {
		return nil, err
	}

	if opts.RedactSecrets {
		mergedIR.Config = util.RedactAny(mergedIR.Config).(map[string]any)
		if len(mergedIR.Settings) > 0 {
			if redacted, ok := util.RedactAny(mergedIR.Settings).(map[string]any); ok {
				mergedIR.Settings = redacted
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
		buildWarnings, err = cherry.BuildFromIR(mergedIR, buildDir, templateDir, opts.RedactSecrets, idMap)
		if err != nil {
			return nil, err
		}
	} else {
		buildWarnings, err = rikka.BuildFromIR(mergedIR, buildDir, templateDir, opts.RedactSecrets, idMap)
		if err != nil {
			return nil, err
		}
	}

	primaryIdx := 0
	if mergeReport != nil && mergeReport.PrimarySourceIndex > 0 {
		primaryIdx = mergeReport.PrimarySourceIndex - 1
	}
	if primaryIdx < 0 || primaryIdx >= len(parsedSources) {
		primaryIdx = 0
	}
	primarySource := parsedSources[primaryIdx]

	manifestSources := make([]ir.ManifestSource, 0, len(parsedSources))
	for _, src := range parsedSources {
		manifestSources = append(manifestSources, ir.ManifestSource{
			Index:        src.Index,
			Name:         src.Name,
			SourceApp:    src.IR.SourceApp,
			SourceFormat: src.Format,
			SourceSHA256: src.SHA256,
			Hints:        cloneStringSlice(src.Hints),
		})
	}
	allWarnings := append([]string{}, mergedIR.Warnings...)
	if mergeReport != nil {
		allWarnings = append(allWarnings, mergeReport.Warnings...)
	}
	allWarnings = append(allWarnings, buildWarnings...)
	manifest := &ir.Manifest{
		SchemaVersion: 1,
		SourceApp:     primarySource.IR.SourceApp,
		SourceFormat:  primarySource.Format,
		SourceSHA256:  primarySource.SHA256,
		TargetApp:     targetAppName(to),
		TargetFormat:  to,
		IDMap:         idMap,
		Redaction:     opts.RedactSecrets,
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
		Sources:       manifestSources,
		Warnings:      dedupeStrings(allWarnings),
	}

	if err := writeSidecar(buildDir, parsedSources, primaryIdx, manifest); err != nil {
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

func normalizeInputPaths(single string, multi []string) []string {
	out := []string{}
	push := func(v string) {
		v = strings.TrimSpace(v)
		if v == "" {
			return
		}
		out = append(out, v)
	}
	if len(multi) > 0 {
		for _, item := range multi {
			push(item)
		}
	}
	if len(out) == 0 {
		push(single)
	}
	return out
}

func tryRehydrateFromSidecar(inputDir, targetFormat string, sourceIR *ir.BackupIR) ([]string, error) {
	manifestPath := filepath.Join(inputDir, "cherrikka", "manifest.json")
	if _, err := os.Stat(manifestPath); err != nil {
		return nil, nil
	}

	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}
	var manifest ir.Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return []string{"sidecar-rehydrate:invalid-manifest"}, nil
	}
	targetFormat = strings.ToLower(strings.TrimSpace(targetFormat))
	type candidate struct {
		path   string
		format string
		index  int
	}
	candidates := []candidate{}
	if strings.EqualFold(strings.TrimSpace(manifest.SourceFormat), targetFormat) {
		sourceZipPath := filepath.Join(inputDir, "cherrikka", "raw", "source.zip")
		if _, err := os.Stat(sourceZipPath); err == nil {
			candidates = append(candidates, candidate{
				path:   sourceZipPath,
				format: strings.ToLower(strings.TrimSpace(manifest.SourceFormat)),
				index:  0,
			})
		}
	}
	for _, src := range manifest.Sources {
		if !strings.EqualFold(strings.TrimSpace(src.SourceFormat), targetFormat) {
			continue
		}
		p := filepath.Join(inputDir, "cherrikka", "raw", fmt.Sprintf("source-%d.zip", src.Index))
		if _, err := os.Stat(p); err != nil {
			continue
		}
		candidates = append(candidates, candidate{
			path:   p,
			format: strings.ToLower(strings.TrimSpace(src.SourceFormat)),
			index:  src.Index,
		})
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].index < candidates[j].index })
	chosen := candidates[0]
	outWarnings := []string{}
	if len(candidates) > 1 {
		outWarnings = append(outWarnings, "sidecar-rehydrate:multiple-source-candidates")
	}

	sidecarDir, cleanup, err := extractToTemp(chosen.path)
	if err != nil {
		return append(outWarnings, "sidecar-rehydrate:extract-source-failed"), nil
	}
	defer cleanup()

	d := backup.DetectExtractedDir(sidecarDir)
	if d.Format == backup.FormatUnknown {
		return append(outWarnings, "sidecar-rehydrate:source-format-unknown"), nil
	}
	if !strings.EqualFold(string(d.Format), targetFormat) {
		return append(outWarnings, "sidecar-rehydrate:source-format-mismatch"), nil
	}

	rawIR, err := parseByFormat(d.Format, sidecarDir)
	if err != nil {
		return append(outWarnings, "sidecar-rehydrate:parse-source-failed"), nil
	}

	switch strings.ToLower(strings.TrimSpace(targetFormat)) {
	case "cherry":
		if raw := mapAny(rawIR.Config["cherry.settings"]); len(raw) > 0 {
			sourceIR.Config["rehydrate.cherry.settings"] = raw
		}
		if raw := mapAny(rawIR.Config["cherry.llm"]); len(raw) > 0 {
			sourceIR.Config["rehydrate.cherry.llm"] = raw
		}
		if raw := mapAny(rawIR.Config["cherry.persistSlices"]); len(raw) > 0 {
			sourceIR.Config["rehydrate.cherry.persistSlices"] = raw
		}
		if raw := mapAny(rawIR.Opaque["interop.cherry.unsupported"]); len(raw) > 0 {
			sourceIR.Opaque["interop.cherry.unsupported"] = raw
		}
	case "rikka":
		if raw := mapAny(rawIR.Config["rikka.settings"]); len(raw) > 0 {
			sourceIR.Config["rehydrate.rikka.settings"] = raw
		}
		if raw := mapAny(rawIR.Opaque["interop.rikka.unsupported"]); len(raw) > 0 {
			sourceIR.Opaque["interop.rikka.unsupported"] = raw
		}
	}

	if sourceIR.Opaque == nil {
		sourceIR.Opaque = map[string]any{}
	}
	sourceIR.Opaque["interop.sidecar"] = map[string]any{
		"rehydrated":   true,
		"sourceFormat": chosen.format,
		"targetFormat": strings.ToLower(strings.TrimSpace(targetFormat)),
		"depth":        1,
	}
	outWarnings = append(outWarnings, "sidecar-rehydrate:applied")
	return outWarnings, nil
}

func mapAny(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
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

func writeSidecar(buildDir string, sources []parsedSource, primaryIdx int, manifest *ir.Manifest) error {
	if len(sources) == 0 {
		return fmt.Errorf("write sidecar: empty source list")
	}
	if primaryIdx < 0 || primaryIdx >= len(sources) {
		primaryIdx = 0
	}
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
	if err := os.WriteFile(filepath.Join(sidecarDir, "raw", "source.zip"), sources[primaryIdx].SourceBytes, 0o644); err != nil {
		return err
	}
	for _, src := range sources {
		path := filepath.Join(sidecarDir, "raw", fmt.Sprintf("source-%d.zip", src.Index))
		if err := os.WriteFile(path, src.SourceBytes, 0o644); err != nil {
			return err
		}
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
		IsolatedConfigItems: countIsolatedConfig(
			asMap(parsed.Opaque["interop.rikka.unsupported"]),
			asMap(parsed.Opaque["interop.cherry.unsupported"]),
		),
		RehydrationAvail: asBool(parsed.Opaque["interop.sidecar.available"]),
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

func countIsolatedConfig(values ...map[string]any) int {
	total := 0
	for _, item := range values {
		total += countMapLeaves(item)
	}
	return total
}

func countMapLeaves(m map[string]any) int {
	if len(m) == 0 {
		return 0
	}
	total := 0
	for _, v := range m {
		switch t := v.(type) {
		case map[string]any:
			total += countMapLeaves(t)
		case []any:
			total += len(t)
		default:
			total++
		}
	}
	return total
}

func asBool(v any) bool {
	b, _ := v.(bool)
	return b
}

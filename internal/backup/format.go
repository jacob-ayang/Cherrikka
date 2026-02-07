package backup

import (
	"os"
	"path/filepath"
)

type Format string

const (
	FormatUnknown Format = "unknown"
	FormatCherry  Format = "cherry"
	FormatRikka   Format = "rikka"
)

type DetectResult struct {
	Format Format
	Hints  []string
}

func DetectExtractedDir(dir string) DetectResult {
	hints := make([]string, 0, 8)
	hasDataJSON := fileExists(filepath.Join(dir, "data.json"))
	hasDataDir := dirExists(filepath.Join(dir, "Data"))
	hasSettingsJSON := fileExists(filepath.Join(dir, "settings.json"))
	hasRikkaDB := fileExists(filepath.Join(dir, "rikka_hub.db"))
	hasUploadDir := dirExists(filepath.Join(dir, "upload"))

	if hasDataJSON {
		hints = append(hints, "data.json")
	}
	if hasDataDir {
		hints = append(hints, "Data/")
	}
	if hasSettingsJSON {
		hints = append(hints, "settings.json")
	}
	if hasRikkaDB {
		hints = append(hints, "rikka_hub.db")
	}
	if hasUploadDir {
		hints = append(hints, "upload/")
	}

	if hasDataJSON && hasDataDir {
		return DetectResult{Format: FormatCherry, Hints: hints}
	}
	if hasSettingsJSON && (hasRikkaDB || hasUploadDir) {
		return DetectResult{Format: FormatRikka, Hints: hints}
	}
	return DetectResult{Format: FormatUnknown, Hints: hints}
}

func fileExists(path string) bool {
	st, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !st.IsDir()
}

func dirExists(path string) bool {
	st, err := os.Stat(path)
	if err != nil {
		return false
	}
	return st.IsDir()
}

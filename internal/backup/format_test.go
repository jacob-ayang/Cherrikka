package backup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectExtractedDir(t *testing.T) {
	t.Run("cherry", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "data.json"), []byte(`{}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(dir, "Data"), 0o755); err != nil {
			t.Fatal(err)
		}
		res := DetectExtractedDir(dir)
		if res.Format != FormatCherry {
			t.Fatalf("want cherry, got %s", res.Format)
		}
	})

	t.Run("rikka", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "rikka_hub.db"), []byte("db"), 0o644); err != nil {
			t.Fatal(err)
		}
		res := DetectExtractedDir(dir)
		if res.Format != FormatRikka {
			t.Fatalf("want rikka, got %s", res.Format)
		}
	})

	t.Run("unknown", func(t *testing.T) {
		dir := t.TempDir()
		res := DetectExtractedDir(dir)
		if res.Format != FormatUnknown {
			t.Fatalf("want unknown, got %s", res.Format)
		}
	})
}

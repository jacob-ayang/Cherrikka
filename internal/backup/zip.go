package backup

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"cherrikka/internal/util"
)

type ZipEntry struct {
	Path       string
	Data       []byte
	SourcePath string
}

func ExtractZip(srcZip, dstDir string) error {
	r, err := zip.OpenReader(srcZip)
	if err != nil {
		return err
	}
	defer r.Close()

	for _, f := range r.File {
		target := filepath.Join(dstDir, filepath.FromSlash(f.Name))
		cleanTarget := filepath.Clean(target)
		cleanRoot := filepath.Clean(dstDir)
		if !strings.HasPrefix(cleanTarget, cleanRoot+string(os.PathSeparator)) && cleanTarget != cleanRoot {
			return fmt.Errorf("zip entry path traversal: %s", f.Name)
		}

		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(cleanTarget, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(cleanTarget), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(cleanTarget)
		if err != nil {
			rc.Close()
			return err
		}
		_, cpErr := io.Copy(out, rc)
		closeErr := out.Close()
		rcErr := rc.Close()
		if cpErr != nil {
			return cpErr
		}
		if closeErr != nil {
			return closeErr
		}
		if rcErr != nil {
			return rcErr
		}
	}
	return nil
}

func WriteZip(output string, entries []ZipEntry) error {
	if err := util.EnsureDir(filepath.Dir(output)); err != nil {
		return err
	}
	f, err := os.Create(output)
	if err != nil {
		return err
	}
	defer f.Close()

	zw := zip.NewWriter(f)
	defer zw.Close()

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Path < entries[j].Path
	})

	for _, e := range entries {
		name := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		if name == "" {
			continue
		}
		h := &zip.FileHeader{
			Name:     name,
			Method:   zip.Deflate,
			Modified: time.Now(),
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		if e.SourcePath != "" {
			src, err := os.Open(e.SourcePath)
			if err != nil {
				return err
			}
			if _, err := io.Copy(w, src); err != nil {
				src.Close()
				return err
			}
			if err := src.Close(); err != nil {
				return err
			}
			continue
		}
		if _, err := io.Copy(w, bytes.NewReader(e.Data)); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return f.Sync()
}

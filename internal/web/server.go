package web

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"cherrikka/internal/app"
	"cherrikka/internal/util"
)

func Serve(listen string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", serveIndex)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/inspect", handleInspect)
	mux.HandleFunc("/api/validate", handleValidate)
	mux.HandleFunc("/api/convert", handleConvert)

	s := &http.Server{
		Addr:    listen,
		Handler: withCORS(mux),
	}
	return s.ListenAndServe()
}

func handleInspect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	inputPath, cleanup, err := saveUploadToTemp(r, "file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	defer cleanup()

	res, err := app.Inspect(inputPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func handleValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	inputPath, cleanup, err := saveUploadToTemp(r, "file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	defer cleanup()

	res, err := app.Validate(inputPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func handleConvert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(200 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	inputPath, cleanup, err := saveUploadField(r, "file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	defer cleanup()

	templatePath := ""
	tmplCleanup := func() {}
	if hasFile(r, "template") {
		templatePath, tmplCleanup, err = saveUploadField(r, "template")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		defer tmplCleanup()
	}

	outputTmpDir, err := os.MkdirTemp("", "cherrikka-web-out-*")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	defer os.RemoveAll(outputTmpDir)

	outputZip := filepath.Join(outputTmpDir, "converted.zip")
	redact, _ := strconv.ParseBool(r.FormValue("redact"))
	opts := app.ConvertOptions{
		InputPath:     inputPath,
		OutputPath:    outputZip,
		From:          fallback(r.FormValue("from"), "auto"),
		To:            fallback(r.FormValue("to"), "cherry"),
		TemplatePath:  templatePath,
		RedactSecrets: redact,
	}
	manifest, err := app.Convert(opts)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	b, err := os.ReadFile(outputZip)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	mb, _ := json.Marshal(manifest)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=converted.zip")
	w.Header().Set("X-Cherrikka-Manifest", string(mb))
	_, _ = w.Write(b)
}

func saveUploadToTemp(r *http.Request, field string) (string, func(), error) {
	if err := r.ParseMultipartForm(200 << 20); err != nil {
		return "", nil, err
	}
	return saveUploadField(r, field)
}

func saveUploadField(r *http.Request, field string) (string, func(), error) {
	f, hdr, err := r.FormFile(field)
	if err != nil {
		return "", nil, err
	}
	defer f.Close()

	tmpDir, err := os.MkdirTemp("", "cherrikka-upload-*")
	if err != nil {
		return "", nil, err
	}
	ext := filepath.Ext(hdr.Filename)
	if ext == "" {
		ext = ".zip"
	}
	path := filepath.Join(tmpDir, "input"+ext)
	out, err := os.Create(path)
	if err != nil {
		_ = os.RemoveAll(tmpDir)
		return "", nil, err
	}
	if _, err := io.Copy(out, f); err != nil {
		out.Close()
		_ = os.RemoveAll(tmpDir)
		return "", nil, err
	}
	out.Close()
	return path, func() { _ = os.RemoveAll(tmpDir) }, nil
}

func hasFile(r *http.Request, field string) bool {
	_, h, err := r.FormFile(field)
	if err != nil {
		return false
	}
	if h != nil {
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(util.PrettyJSON(data)))
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, indexHTML)
}

func fallback(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return strings.TrimSpace(v)
}

var indexHTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Cherrikka</title>
  <style>
    :root { --bg: #f7efe2; --ink:#1c1a17; --card:#fff8ea; --line:#d9c7a9; --accent:#1f6f5e; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif; background: radial-gradient(circle at 15% 10%, #fff6df 0, #f7efe2 45%, #efe4d2 100%); color: var(--ink); }
    .wrap { max-width: 980px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 2rem; }
    .subtitle { margin: 0 0 20px; opacity: .8; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px,1fr)); gap:14px; }
    .card { border:1px solid var(--line); background: var(--card); border-radius: 14px; padding: 14px; box-shadow: 0 6px 20px rgba(0,0,0,.05); }
    label { display:block; margin:8px 0 4px; font-size:.92rem; }
    input, select, button { width:100%; padding:10px; border-radius:10px; border:1px solid var(--line); background:white; font: inherit; }
    button { cursor:pointer; background: var(--accent); color:white; border:none; font-weight: 600; }
    pre { background:#0f1720; color:#e5f2f0; padding:12px; border-radius:10px; overflow:auto; min-height:120px; }
    .row { display:flex; gap:8px; align-items:center; }
    .row input[type=checkbox] { width:auto; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Cherrikka</h1>
    <p class="subtitle">Cherry Studio ↔ RikkaHub 备份互转（V1）</p>

    <div class="grid">
      <div class="card">
        <h3>Inspect / Validate</h3>
        <label>Backup Zip</label>
        <input id="inspectFile" type="file" accept=".zip" />
        <div style="height:8px"></div>
        <button onclick="inspect()">Inspect</button>
        <div style="height:8px"></div>
        <button onclick="validate()">Validate</button>
      </div>

      <div class="card">
        <h3>Convert</h3>
        <label>Source Zip</label>
        <input id="srcFile" type="file" accept=".zip" />
        <label>Template Zip (optional)</label>
        <input id="tmplFile" type="file" accept=".zip" />
        <label>From</label>
        <select id="from"><option value="auto">auto</option><option value="cherry">cherry</option><option value="rikka">rikka</option></select>
        <label>To</label>
        <select id="to"><option value="cherry">cherry</option><option value="rikka">rikka</option></select>
        <div class="row"><input id="redact" type="checkbox" /><span>redact secrets</span></div>
        <div style="height:8px"></div>
        <button onclick="convert()">Convert & Download</button>
      </div>
    </div>

    <h3>Output</h3>
    <pre id="out"></pre>
  </div>

<script>
const out = document.getElementById('out');
function print(v){ out.textContent = typeof v === 'string' ? v : JSON.stringify(v,null,2); }

async function inspect(){
  const f = document.getElementById('inspectFile').files[0];
  if(!f) return print('请选择 zip 文件');
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch('/api/inspect',{method:'POST',body:fd});
  print(await r.json());
}

async function validate(){
  const f = document.getElementById('inspectFile').files[0];
  if(!f) return print('请选择 zip 文件');
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch('/api/validate',{method:'POST',body:fd});
  print(await r.json());
}

async function convert(){
  const src = document.getElementById('srcFile').files[0];
  if(!src) return print('请选择 source zip');
  const tmpl = document.getElementById('tmplFile').files[0];
  const fd = new FormData();
  fd.append('file', src);
  if(tmpl) fd.append('template', tmpl);
  fd.append('from', document.getElementById('from').value);
  fd.append('to', document.getElementById('to').value);
  fd.append('redact', document.getElementById('redact').checked ? 'true' : 'false');

  const r = await fetch('/api/convert',{method:'POST',body:fd});
  if(!r.ok){
    const e = await r.json();
    return print(e);
  }
  const manifest = r.headers.get('X-Cherrikka-Manifest');
  if(manifest){
    try { print(JSON.parse(manifest)); } catch { print(manifest); }
  }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'converted.zip';
  a.click();
  URL.revokeObjectURL(a.href);
}
</script>
</body>
</html>`

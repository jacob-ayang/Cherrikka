# Cherrikka

Cherrikka is a Go-based backup converter for Cherry Studio and RikkaHub.

## Frontend (Pure Local)

The repository now includes a pure frontend local converter at `frontend/`.

1. `cd frontend`
2. `npm install`
3. `npm run dev`
4. Open the local Vite URL (usually `http://localhost:5173`)

This frontend runs `inspect / validate / convert` inside a Web Worker in the browser and does not call `/api/*`.

## Commands

- `cherrikka inspect --input <backup.zip>`
- `cherrikka validate --input <backup.zip>`
- `cherrikka convert --input <src.zip> --output <dst.zip> --from auto|cherry|rikka --to cherry|rikka [--template <target-template.zip>] [--redact-secrets]`
- `cherrikka serve --listen 127.0.0.1:7788`

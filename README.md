# Cherrikka

Cherrikka is a Go-based backup converter for Cherry Studio and RikkaHub.

## Frontend (Pure Local)

The repository now includes a pure frontend local converter at `frontend/`.

1. `cd frontend`
2. `npm install`
3. `npm run dev`
4. Open the local Vite URL (usually `http://localhost:5173`)

This frontend runs `inspect / validate / convert` inside a Web Worker in the browser and does not call `/api/*`.

## Vercel Deploy

This repo includes a root-level `vercel.json` that builds from `frontend/`, so deploying directly from the repo root works.

If your existing Vercel project still shows 404 after deploy:

1. Open project settings in Vercel.
2. Set `Root Directory` to repo root (empty) to use root `vercel.json`, or set it to `frontend` and keep frontend config.
3. Trigger a redeploy.

## GitHub Pages Deploy

This repo includes `.github/workflows/deploy-pages.yml` and will auto-deploy `frontend/dist` to GitHub Pages on every push to `main`.

1. Open GitHub repo settings: `Settings -> Pages`.
2. Set `Source` to `GitHub Actions`.
3. Push to `main` (or manually run the workflow from `Actions`).

After deployment, the site URL is:
- `https://<your-github-username>.github.io/Cherrikka/`

## Commands

- `cherrikka inspect --input <backup.zip>`
- `cherrikka validate --input <backup.zip>`
- `cherrikka convert --input <src.zip> --output <dst.zip> --from auto|cherry|rikka --to cherry|rikka [--template <target-template.zip>] [--redact-secrets]`
- `cherrikka serve --listen 127.0.0.1:7788`

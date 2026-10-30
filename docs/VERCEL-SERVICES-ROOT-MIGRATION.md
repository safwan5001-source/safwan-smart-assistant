# Vercel Services root migration gate

Current Vercel UI configuration (verified from screenshot):
- Framework preset: Next.js
- Root Directory: `apps/web`
- Repo-root `vercel.json` declares services `web` and `backend`.
- Preview deployment of the branch returned HTTP 404 on `/backend/health`.

## Diagnosis
The repo-root Vercel Services configuration is unlikely to be applied when the project is configured to build from `apps/web`. This is a working hypothesis, not proof of the deployed routing table.

## Prerequisites before any settings update
1. Keep production untouched and the PR as a draft.
2. Confirm Vercel Services Beta is available to this project.
3. Confirm repo-root `vercel.json` is supported when project root is repository root; validate Next.js workspace install, Python entrypoint `app.main:app`, and backend routing.
4. Inspect the preview deployment's build logs and ensure both services are actually built.
5. Change Project Settings > Build and Deployment > Root Directory from `apps/web` to repository root (clear the field) only after validation; do not blindly change the Framework Preset.
6. Publish only Preview from the feature branch and check both `/` and `/backend/health`. A READY state alone is insufficient.
7. If either fails, revert the Root Directory to `apps/web`; preserve production and existing browser data.

## Successful acceptance
- Preview home and existing local-only features continue to work on iPhone.
- `GET /backend/health` returns FastAPI `{"status":"ok","service":"orchestrator-foundation"}`, not Next.js 404.
- No public path to unfinished POST /tasks or authentication.
- Database/Blob integration remains Preview-only until verified.

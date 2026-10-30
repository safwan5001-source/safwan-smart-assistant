# Phase 5 hosting decision — approved

Target Vercel project: `safwan-smart-assistant` (`prj_btPYVVmiHmBoXVh1GLkiTbrpi9JC`).

## Approved layout
- Next.js frontend on existing Vercel project.
- Backend API via Vercel Functions / reviewed Vercel Services integration with existing FastAPI backend; do not assume the current FastAPI code is already deployed.
- Neon managed PostgreSQL via Vercel Marketplace; independent from AWJ.
- Vercel Blob **private** store for attachments, owner-authorized reads.
- Run preview/staging verification before production promotion.

## Current provisioning blocker
The available Vercel connector returns HTTP 403 when creating a private Blob store and when listing integration configurations. **Neither Neon nor Blob has been provisioned.**

## Owner-admin setup
1. Open the existing Vercel project, Storage / Marketplace and connect a fresh Neon Postgres database (preview/staging, not AWJ).
2. Create or connect a **Private** Vercel Blob store, ideally in a nearby supported region.
3. Grant the connected integration adequate Storage/Marketplace permissions or complete provisioning in the Dashboard.
4. Verify environment variable **names and scopes** only; never place connection strings or tokens in GitHub/PR/chat.
5. Wire the FastAPI application to Vercel functions, install the PostgreSQL driver, apply reviewed migrations, and test RLS with a restricted DB role.
6. Implement login / verified email / session rotation, CSRF and rate-limiting; never expose incomplete authentication.
7. Implement owner-scoped private file reads and opt-in idempotent local import, then multi-device conflict and offline tests.
8. Require CI, end-to-end iPhone staging checks, and explicit approval before merging.

No AI integration. No silent local data migration.

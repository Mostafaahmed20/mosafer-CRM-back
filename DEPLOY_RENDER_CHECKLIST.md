# Render Production Env/Deploy Checklist

Use this checklist to deploy `crm-server` to Render safely and keep it easy to change later.

## 1. Pre-Deploy Security

- [ ] Rotate any exposed secrets before deploy (`MONGODB_URI`, `JWT_SECRET`, `RESEND_API_KEY`).
- [ ] Confirm `.env` is not committed (`.gitignore` already excludes it).
- [ ] Generate a strong JWT secret (at least 32 random chars).

## 2. Render Service Setup

- [ ] Create a **Web Service** on Render connected to this repo.
- [ ] Runtime: `Node`.
- [ ] Root Directory: repo root (`crm-server`).
- [ ] Build Command:

```bash
pnpm install --frozen-lockfile && pnpm build
```

- [ ] Start Command:

```bash
pnpm start
```

- [ ] Health Check Path: `/api/health`.
- [ ] Auto-Deploy: enabled for your active branch.

## 3. Required Environment Variables (Render)

Set these in Render dashboard for the Web Service:

- [ ] `NODE_ENV=production`
- [ ] `PORT=10000`
- [ ] `MONGODB_URI=<your-atlas-uri>`
- [ ] `JWT_SECRET=<strong-random-secret>`
- [ ] `APP_BASE_URL=https://<your-frontend-domain>`
- [ ] `CORS_ORIGINS=https://<your-frontend-domain>`

Email/auth related:

- [ ] `RESEND_API_KEY=<resend-api-key>` (leave empty only if you want email disabled)
- [ ] `RESEND_FROM=<verified-sender@your-domain>`
- [ ] `GOOGLE_CLIENT_ID=<google-oauth-client-id>` (if Google login is enabled)

Jobs/Redis mode:

- [ ] `USE_BULLMQ_JOBS=false` for simplest deploy (recommended first deploy)
- [ ] `REDIS_URL=redis://...` only needed when `USE_BULLMQ_JOBS=true`

## 4. MongoDB Atlas Production Setup

- [ ] In Atlas Network Access, allow Render outbound IPs or temporarily `0.0.0.0/0` for testing.
- [ ] Create a database user with least privileges.
- [ ] Use the database name you want in `MONGODB_URI` (for example `/trello`).
- [ ] Confirm TLS connection works from deployed service logs.

## 5. Frontend + CORS Alignment

- [ ] Frontend calls backend base URL on Render (`https://<your-render-service>.onrender.com` or custom domain).
- [ ] `CORS_ORIGINS` includes only allowed frontend origins, comma-separated.
- [ ] `APP_BASE_URL` points to frontend URL used in emails (verify/reset/invite links).

## 6. Files/Uploads Warning

- [ ] Current `uploads/` is local filesystem storage.
- [ ] Render disks are ephemeral unless persistent disk is configured.
- [ ] For production, migrate attachments to object storage (S3/R2/Cloudinary) to avoid data loss on redeploy/restart.

## 7. First Deploy Verification

- [ ] Open `/api/health` and confirm `ok: true`.
- [ ] Test signup/login.
- [ ] Test email flow (verification or reset).
- [ ] Test websocket features (board updates/messages).
- [ ] Verify logs do not show:
  - `MongoDB connection error`
  - CORS blocked requests from your real frontend domain
  - missing env warnings

## 8. Optional Next Step: BullMQ/Redis

After stable deploy with timer jobs:

- [ ] Provision Redis (for example Upstash/Render Redis).
- [ ] Set `USE_BULLMQ_JOBS=true`.
- [ ] Set valid `REDIS_URL`.
- [ ] Redeploy and confirm `/api/health` reports BullMQ mode healthy.

## 9. Go-Live Hardening

- [ ] Add request rate limits appropriate for production traffic.
- [ ] Add backup/restore plan for MongoDB.
- [ ] Add uptime monitoring and alerts.
- [ ] Add CI checks (`pnpm check`) before auto deploy.
- [ ] Add basic integration tests for auth, boards, cards, and health endpoints.

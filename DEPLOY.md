# Deploying NMR Predict (split: Cloudflare Pages + self-hosted backend)

This is the production setup where the **static frontend** is served by
**Cloudflare Pages** at `https://nmr.chembases.com`, and the **FastAPI backend**
runs on your own Windows machine, published to `https://api.nmr.chembases.com`
through a **Cloudflare Tunnel**.

It's still **one git repo** — Cloudflare Pages builds only the `frontend/`
subdirectory and ignores `backend/`. No repo split needed.

```
 Browser ──HTTPS──> nmr.chembases.com        (Cloudflare Pages: static SPA)
    │
    └────HTTPS(CORS)──> api.nmr.chembases.com (Cloudflare edge)
                              │
                         Cloudflare Tunnel  (cloudflared on your PC)
                              │
                         127.0.0.1:7999      (run-backend.bat → uvicorn)
```

---

## 1. Backend on your Windows machine

Start it with the dedicated launcher:

```
run-backend.bat
```

This runs **only** the backend, bound to `127.0.0.1:7999`, with
`NMR_ENV=production`, which:

- disables the interactive API docs (`/docs`, `/redoc`, `/openapi.json`);
- **disables the ORCA engine** — it's still listed by `/engines` but reported
  `ready: false`, so the UI shows its toggle **greyed out** with a tooltip, and
  `/predict` refuses to run it. The public instance therefore only *runs* CDK
  and CASCADE (fast, seconds). ORCA's multi-minute DFT jobs stay local-only; use
  `run-nmr.bat` for ORCA work.

It binds **loopback only** (not `0.0.0.0`), so the API is *not* reachable over
your LAN or the internet directly — the only way in is through the
authenticated tunnel.

CORS: the launcher sets `NMR_ALLOWED_ORIGINS=https://nmr.chembases.com`. To
allow a different/extra origin, edit that line in `run-backend.bat`.

## 2. Cloudflare Tunnel (`cloudflared`)

Install cloudflared on the Windows box (<https://pkg.cloudflare.com>), then:

```
cloudflared tunnel login                    # authorize the chembases.com zone
cloudflared tunnel create nmr-backend       # prints a TUNNEL UUID + creds JSON
cloudflared tunnel route dns nmr-backend api.nmr.chembases.com
```

Copy `deploy/cloudflared/config.yml` to `%USERPROFILE%\.cloudflared\config.yml`
and fill in the `REPLACE_*` placeholders (the UUID and the credentials path).
Then run it:

```
cloudflared tunnel run nmr-backend
```

To keep it running across reboots/logout, install it as a service:

```
cloudflared service install
```

The `tunnel route dns` command creates the `api.nmr.chembases.com` DNS record
(a proxied CNAME to the tunnel) automatically — you don't add it by hand.

## 3. Frontend on Cloudflare Pages

Create a Pages project connected to this git repo (**Workers & Pages → Create →
Pages → Connect to Git**), with these build settings:

| Setting                  | Value                          |
| ------------------------ | ------------------------------ |
| Production branch        | `main`                         |
| **Root directory**       | `frontend`                     |
| Framework preset         | None / Vite                    |
| Build command            | `npm run build`                |
| Build output directory   | `dist`                         |

Environment variables (Pages → Settings → Environment variables → Production):

| Variable             | Value                            | Why |
| -------------------- | -------------------------------- | --- |
| `VITE_NMR_API_URL`   | `https://api.nmr.chembases.com`  | Points the SPA's axios client at the tunnel. |
| `NPM_FLAGS`          | `--legacy-peer-deps`             | vite 8 vs `@vitejs/plugin-react-swc` peer range (same flag the .bat uses). |
| `NODE_VERSION`       | `20`                             | Match a current LTS. |

Because **Root directory = `frontend`**, Pages runs the build inside that folder
and publishes `frontend/dist`; `backend/` is cloned to the build machine but
never built or served.

SPA routing is already handled: `frontend/public/_redirects` rewrites all
unmatched paths to `index.html` so deep links like `/maldi` survive a refresh.

Custom domain: Pages → **Custom domains** → add `nmr.chembases.com` (Cloudflare
provisions the cert and DNS).

## 4. Make the backend public-safe (rate limiting)

The backend has **no built-in auth**, and it's public, so put a Cloudflare
rate-limit rule in front of the compute endpoint.

**Security → WAF → Rate limiting rules → Create**, scoped to
`api.nmr.chembases.com`:

- **Match:** `URI Path` contains `/predict` (and optionally `/validate`)
- **Method:** `POST`
- **Rate:** e.g. **10 requests / 1 minute** per client IP (tune to taste)
- **Action:** Block (or Managed Challenge) for, e.g., 60s

Optionally add a second, looser rule on the whole hostname (e.g. 60 req/min) as
a blanket abuse cap. Cloudflare's free tier includes a basic rate-limiting rule;
the WAF/Bot tools can be layered on later if abuse shows up.

## 5. Verify

```
# Backend reachable through the tunnel:
curl https://api.nmr.chembases.com/health           # -> {"status":"ok"}

# ORCA is disabled in production: still listed by /engines but with
# "ready": false (so the UI greys out its toggle); /predict refuses to run it.
curl https://api.nmr.chembases.com/engines          # orca present, ready:false

# Frontend loads and talks to the API:
#   open https://nmr.chembases.com, run a CDK/CASCADE prediction,
#   confirm the browser Network tab shows calls to api.nmr.chembases.com
#   with no CORS errors.
```

If the browser reports a CORS error, the SPA's origin isn't in
`NMR_ALLOWED_ORIGINS` — fix the value in `run-backend.bat` and restart it.

---

## Notes / gotchas

- **One repo, no split.** The backend living in the repo is harmless; Pages only
  builds the `frontend` root directory.
- **ORCA over the tunnel.** Disabled in production on purpose. Cloudflare's edge
  caps a proxied response at ~100s (524) on non-Enterprise plans, and ORCA jobs
  run for minutes. If you ever need ORCA publicly, the fix is to make `/predict`
  asynchronous (return a job id + poll) rather than holding one request open.
- **Secrets.** `.env` is git-ignored; production values for the backend live in
  `.env` on the server (or are set by `run-backend.bat`). Frontend build vars
  live in the Cloudflare Pages dashboard, not in the repo.

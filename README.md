# Share

[![check](https://github.com/acoyfellow/share/actions/workflows/check.yml/badge.svg)](https://github.com/acoyfellow/share/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](./LICENSE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/share)

**Temporary, resumable file transfers on your own Cloudflare account.**

Share creates an upload link and a separate download link immediately, then transfers the file in resumable parts through a private R2 bucket. It is an OSS starter for teams that want a small transfer lane, not another collaboration suite.

## Try it

- Demo: https://share.coey.dev
- Source: https://github.com/acoyfellow/share
- Deploy: https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/share

## Tutorial: try Share locally

### What you will run

A single Worker backed by two Durable Objects and one local R2 bucket:

- `ShareSession` owns one temporary share, capability checks, multipart upload, download budget, and expiration.
- `DemoQuota` reserves bytes and limits anonymous share creation.
- R2 stores completed bytes privately; the browser never receives a public storage URL.
- Turnstile gates anonymous creation using Cloudflare's official automated-test keys in local development.

### Start the app

Requirements: Bun and a Cloudflare-compatible browser.

```sh
bun install
bun run check
bunx wrangler dev --local --port 8796 \
  --var TURNSTILE_SITE_KEY:1x00000000000000000000AA \
  --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA
```

Open `http://localhost:8796`.

For an automated browser pass while that server is running:

```sh
bun run browser:e2e
```

1. Choose a temporary file.
2. Complete the visible test Turnstile challenge.
3. Select **Create secure links and upload**.
4. Copy the **Share link** into another tab. It contains only a read capability in the URL fragment.
5. Observe upload readiness and download the finished file.
6. Use the **Manage link** to resume an interrupted upload or remove the share.

You have now exercised the same capability boundary and R2 multipart path intended for a public demo deployment.

## How-to guides

### Validate before publishing

```sh
bun run typecheck
bun run test
bun run dry-run
bun run browser:e2e # with the local Worker running as in the tutorial
```

The test suite runs real Worker/Durable Object/R2 behavior under Cloudflare's Workers Vitest pool. It covers capabilities, quota reservation, multipart finalization, range downloads, aborts, and metadata non-disclosure.

### Deploy your own instance

The **Deploy to Cloudflare** button above creates your Worker, Durable Objects, and private R2 bucket from `wrangler.jsonc`.

During setup:

1. Choose your Worker name and R2 bucket name.
2. Create a Turnstile widget for your assigned Worker hostname (or your custom domain).
3. Set `TURNSTILE_SITE_KEY` and the secret `TURNSTILE_SECRET_KEY` from that widget.
4. Optionally set `PUBLIC_URL` when you will use a custom hostname.

A fresh button deploy is reachable on its `workers.dev` hostname with Preview URLs disabled. If you attach a custom domain, switch to a single public surface in your generated repository:

```jsonc
"workers_dev": false,
"preview_urls": false,
"routes": [{ "pattern": "share.example.com", "custom_domain": true }]
```

Manual deployment is also supported:

```sh
bun install
bunx wrangler r2 bucket create share-files
bunx wrangler secret put TURNSTILE_SECRET_KEY
# Set TURNSTILE_SITE_KEY in wrangler.jsonc
bunx wrangler deploy
```

Before operating a public hosted instance, read `SECURITY.md` and tune its limits for your cost and abuse posture.

### Adjust public-demo limits

All public limits are explicit Worker variables in `wrangler.jsonc`:

| Variable | Default | Meaning |
|---|---:|---|
| `MAX_SHARE_SIZE_BYTES` | `67108864` | Maximum file size, 64 MiB |
| `MAX_ACTIVE_BYTES` | `1073741824` | Total currently retained or reserved bytes, 1 GiB |
| `MAX_CREATES_PER_HOUR` | `5` | Creation limit per coarse client key |
| `PENDING_TTL_SECONDS` | `3600` | Time allowed for incomplete uploads |
| `READY_TTL_SECONDS` | `86400` | Time completed downloads remain available |
| `DOWNLOAD_MULTIPLIER` | `4` | Download byte budget as a multiple of file size |

## Explanation

### Why links are immediately available

The uploader should not need to wait for a large transfer to finish before sharing intent. Share first creates a temporary record and two capabilities, then uploads chunks into R2. The read link can display pending progress and becomes downloadable after completion.

### Why there are two links

Public demo mode has no user accounts. It therefore uses capability security:

- The **share link** grants status and download access.
- The **manage link** additionally grants upload resume, cancellation, and deletion.

Capabilities live in URL fragments (`#read=…`, `#manage=…`), which are not sent to the server during navigation. Browser API calls move the selected capability into an `Authorization: ShareCapability …` header. The server stores only capability hashes.

### Why the hosted demo is tightly limited

An anonymous file-transfer site can otherwise become unbounded storage or distribution infrastructure. Share's defaults demonstrate the architecture while constraining cost and abuse:

- one temporary file per share;
- no public index or recipient email claims;
- private object storage and attachment-only downloads;
- Turnstile before storage reservation;
- exact retained-byte reservation in a Durable Object;
- request-time expiry enforcement plus cleanup alarms;
- bounded upload retry bytes and pre-debited download byte budgets.

For confidential or regulated file sharing, add identity-backed authorization, scanning, audit, retention, and operator processes rather than increasing public-demo limits.

## Reference

### Routes

| Method | Route | Required capability | Purpose |
|---|---|---|---|
| `GET` | `/` | None | Create-share interface |
| `POST` | `/api/shares` | Valid Turnstile response | Reserve and create a pending share |
| `GET` | `/share/:id#read=…` | Browser-held read capability | Viewer shell; fragment is not sent to the Worker |
| `GET` | `/api/shares/:id/state` | Read or manage | Status and progress |
| `PUT` | `/api/shares/:id/parts/:number` | Manage | Upload or retry one R2 multipart part |
| `POST` | `/api/shares/:id/complete` | Manage | Finalize the object |
| `POST` | `/api/shares/:id/abort` | Manage | Cancel pending transfer |
| `POST` | `/api/shares/:id/delete` | Manage | Delete transfer/object |
| `GET` | `/api/shares/:id/download` | Read or manage | Attachment download, including single byte ranges |

### File map

| File | Responsibility |
|---|---|
| `src/index.ts` | Worker pages and capability API routing |
| `src/share-session.ts` | Per-share Durable Object, multipart upload, expiry and downloads |
| `src/quota.ts` | Deployment-wide retained-byte and creation limits |
| `src/core.ts` | Capabilities, names, multipart and Range primitives |
| `src/turnstile.ts` | Turnstile server validation |
| `src/ui.ts` | Browser upload, viewer and download interface |
| `tests/` | Core and Workers-runtime integration suite |
| `wrangler.jsonc` | Cloudflare bindings and configurable demo limits |

### Cloudflare resources

| Primitive | Role |
|---|---|
| Worker | Public UI and scoped HTTP API |
| Durable Objects | Share authority, cleanup alarms, exact quota authority |
| R2 | Private multipart object storage |
| Turnstile | Anonymous share-creation challenge |

## License

MIT

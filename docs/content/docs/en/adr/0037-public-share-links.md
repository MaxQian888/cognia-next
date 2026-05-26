---
title: ADR 0037 — Public share links (zero-knowledge)
description: Turn chat exports, workflow images, A2UI apps, and backup packages into short public URLs via a self-hosted Cloudflare worker (R2 + KV). Content is end-to-end encrypted client-side; the key rides in the URL #fragment and never reaches the server.
---

# ADR 0037 — Public share links (zero-knowledge)

> **Status**: Accepted on 2026-05-26. Phases 0–3 shipped: crypto core +
> Dexie mirror, the Cloudflare worker (`share-server/worker/`), the standalone
> viewer SPA (`share-server/viewer/`), and the create-side UI for all four
> artifacts. A2UI shares render as a "download + import into Cognia" card;
> true in-browser A2UI rendering is deferred (see Consequences).

## Context

Cognia had ~16 "share / export" surfaces, but almost all produced a local file
the user had to hand over manually. The only link mechanism — A2UI's
`/share/app?code=` — base64-encoded the entire app into the URL, which breaks
for large apps and only works if the recipient already runs Cognia. There was
**no way to generate a URL an arbitrary person can open in a browser to view
shared content.**

The repo already self-hosts a Cloudflare worker (workers-rs + Durable Objects)
for WebRTC signaling (ADR-0021), with `wrangler deploy`, a custom domain, and a
**single-tenant "deploy your own worker"** model. Adding object storage (R2) +
key/value metadata (KV) + an HTTP worker is a natural extension of infra the
operator already runs.

## Decision

Add a **"Share via link"** capability that publishes an artifact to a short
public URL backed by a **new, standalone TypeScript Cloudflare worker**. The
content is **zero-knowledge end-to-end encrypted**: a random 256-bit key is
generated in the browser, placed in the URL `#fragment`, and **never
uploaded**. The worker stores only opaque ciphertext; **decryption happens
client-side in the viewer page** (the `#fragment` is never transmitted to any
server). Reads are public via a short code; **creating and revoking links
requires a bearer secret only the operator holds** — matching the
single-tenant posture of the signaling server.

Four artifacts are supported on the create side: chat exports (HTML / animated
/ Markdown / JSON / text), workflow images (PNG), A2UI apps, and backup
packages.

## Architecture

```
App (Tauri / Capacitor / browser)            share.<domain> (TS worker)
  createShareLink()                            POST   /v1/share        (bearer; ciphertext → R2, meta → KV)
   ├─ render artifact → SharePayload           GET    /v1/share/:code  (public; TTL / max-views / burn)
   ├─ encryptSharePayload(payload, randomKey)  GET    /v1/share/:code/stats (bearer)
   ├─ PUT envelope → worker → R2               DELETE /v1/share/:code  (bearer; revoke)
   └─ url = https://…/v/<code>#k=<key>         /*  →  viewer SPA (static assets)

Recipient browser → viewer → GET envelope → decrypt with #fragment key → render by kind
```

- **Crypto** (`lib/share/`) — `encryptSharePayload` / `decryptShareEnvelope`
  use AES-GCM with a raw random key (base case) or, when an extra passphrase is
  set, a key derived from PBKDF2 over `rawKey ‖ passphrase` (so neither the URL
  key nor the passphrase alone decrypts). `kind` and `mime` live **inside** the
  ciphertext, so the server is blind to content type. The module is a clean
  leaf (its own `sha256` in `lib/share/hash.ts`, no dependency on
  `lib/data/crypto`) so the standalone viewer can import it without dragging in
  app-wide types.
- **Worker** (`share-server/worker/`) — a standalone TS project (own
  `package.json` + lockfile, installed with `--ignore-workspace`, like
  `sidecar/`). R2 holds the envelope body; KV holds lifecycle counters with a
  TTL backstop and lazy GC of orphans. Tested with `@cloudflare/vitest-pool-workers`
  (miniflare).
- **Viewer** (`share-server/viewer/`) — a Vite React SPA served as the worker's
  static assets. It imports the real `lib/share/crypto` via a `@` → repo-root
  alias and renders by kind: chat HTML/animated in a **sandboxed iframe**,
  Markdown/JSON/text as preformatted text, workflow PNG as an `<img>`, and
  backup / A2UI as a download.
- **App glue** — one reusable `<ShareLinkDialog>` (lifecycle controls + URL +
  QR + copy + revoke), a `<MySharesPanel>` (reactive `useLiveQuery` over the
  Dexie `sharedLinks` mirror, schema v54), and a `<ShareSettingsCard>` (worker
  URL → AppSettings, upload secret → OS keyring). Wired into the chat export
  dialog, the workflow editor's overflow menu, the A2UI workspace toolbar, and
  the backup export card.

## Lifecycle controls

Per-link: **expiry** (TTL, enforced by the worker + KV TTL), **view limit /
burn-after-reading** (self-destruct after N reads), **manual revoke**, and an
optional **extra passphrase**. Because shares are zero-knowledge, there is no
server-side search or preview.

## Consequences

- The worker is **untrusted by design**; losing the link loses the content.
- **A2UI true rendering is deferred.** The A2UI catalog statically imports 64
  components plus `next/image`, `next/link`, recharts/three/d3/tone/framer-motion
  and the full Radix surface — which a standalone Vite viewer cannot import
  cleanly. A2UI shares therefore render as a download-and-import-into-Cognia
  card. If true public A2UI rendering is wanted later, the right architecture is
  to deploy the **app's own static-export `/share/view` route to Cloudflare
  Pages** (which already carries the renderer, Tailwind, and the Next runtime),
  not the standalone viewer.
- Configuration mirrors signaling: `NEXT_PUBLIC_SHARE_URL` build default,
  `AppSettings.shareUrl` per-install override, upload secret in the keyring.
- Out of scope: real-time collaborative shares (Durable Objects), a browsable
  registry/marketplace, server-side search.

See `companion/share-links-setup` for the operator deploy guide.

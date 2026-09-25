---
title: ADR 0037 — Public share links (zero-knowledge)
description: Turn chat exports, workflow images, A2UI apps, and backup packages into short public URLs via a self-hosted Cloudflare worker (R2 + KV). Content is end-to-end encrypted client-side; the key rides in the URL #fragment and never reaches the server.
---

# ADR 0037 — Public share links (zero-knowledge)

> **Status**: Accepted on 2026-05-26. Phases 0–3 shipped: crypto core +
> Dexie mirror, the Cloudflare worker (`services/share-server/worker/`), the standalone
> viewer SPA, and the create-side UI for all four artifacts.
>
> **Phase 4 (2026-05-29)** superseded the standalone Vite viewer: the app's own
> `/share/view` route is now the single viewer for every kind, A2UI apps render
> for real (read-only), and the worker became a pure `/v1` API. See the
> [Phase 4 addendum](#phase-4--unified-viewer--a2ui-true-rendering-2026-05-29).
>
> **The anonymous visitor (2026-09-25)**: reading a share needs no local
> account. With none open, the gates render `/share/view` in a guest shell
> instead of the first-run form. See the
> [addendum](#the-anonymous-visitor-2026-09-25).

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
- **Worker** (`services/share-server/worker/`) — a standalone TS project (own
  `package.json` + lockfile, installed with `--ignore-workspace`, like
  `sidecar/`). R2 holds the envelope body; KV holds lifecycle counters with a
  TTL backstop and lazy GC of orphans. Tested with `@cloudflare/vitest-pool-workers`
  (miniflare).
- **Viewer** (`services/share-server/viewer/`) — a Vite React SPA served as the worker's
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

## Phase 4 — unified viewer + A2UI true rendering (2026-05-29)

The standalone Vite viewer (`services/share-server/viewer/`) is **removed**. It could not
render A2UI apps because the A2UI catalog statically imports 61 components plus
`next/image`, recharts/three/d3/tone/framer-motion and the full Radix/HeroUI
surface — so A2UI shares were download-only. The deferred-rendering note in
Consequences is now resolved by the architecture it predicted.

**What changed:**

- **Single viewer, in the app.** The app's own `app/share/view/page.tsx`
  (`"use client"`) is the one viewer for every kind. It ships in the normal
  static export (`out/`), so it renders both on the public **Cloudflare Pages**
  deployment and inside the **Tauri desktop shell** — an owner can open their
  own shares in-app. Render-by-kind lives in `components/share/payload-view.tsx`
  (the sandboxed-iframe levels for chat HTML/animated are preserved verbatim);
  load/decrypt orchestration is `lib/share/load.ts`.
- **A2UI renders for real, read-only.** `PayloadView` loads the decrypted
  export JSON into the A2UI store (via `createA2UISurface` — the same path
  `importApp` uses) and mounts the real `<A2UISurface readOnly>`. A new
  `readOnly` flag on `A2UIProvider`/`A2UISurface` makes `emitAction` /
  `setDataValue` inert, so a public viewer cannot be driven to mutate or
  navigate.
- **Unified URL.** Links now mint `${base}/share/view?c=<code>#k=<key>` for
  **every** kind (was `/v/<code>#k=`). The `code` is a public lookup id (query
  param); the key still rides only in the `#fragment`. The viewer must be
  reached by a normal navigation or direct open — never an HTTP redirect, which
  would drop the fragment.
- **Worker is a pure API.** It no longer serves static assets; non-`/v1` paths
  return 404. `wrangler.toml` drops `[assets]` and scopes the Worker route to
  `share.cognia.cn/v1/*` so a Cloudflare Pages project (serving `out/`) owns the
  rest of the host. Deploy guide: `services/share-server/pages/README.md`.

**New consequence:** because `out/` is a monolithic export, deploying it to
Pages publishes the whole (secret-free) app shell at the share host. Acceptable
— no credentials live in the export — but operators wanting only the viewer
exposed can add a Pages `_redirects` rule pointing non-`/share/view` paths at
`/share/view`.

## Phase 5 — self-hosted Rust server (Cloudflare-free option)

The Worker ties the share API to Cloudflare R2 + KV. Operators who already run
the signaling server's self-hosted Rust binary (ADR-0021) — or who simply don't
want Cloudflare — now have a parallel option for shares: a standalone axum
server at `services/share-server/` that speaks the **exact same `/v1` contract**.

**What it is:** `services/share-server/` is now a Cargo workspace (`Cargo.toml`, `src/`,
`core/`, `tests/`, `Dockerfile`, `fly.toml`) alongside the existing TypeScript
`worker/` and `pages/`. It is the share-service twin of `services/signaling-server/`:
one static binary, the same `docker` / `fly` story, the same security and
observability posture. No app change is needed — the operator sets
`AppSettings.shareUrl` (and the upload secret in the keyring) to point at it,
exactly as for the hosted Worker.

**Storage.** Unlike signaling (stateless, in-memory), shares are persistent, so
the server keeps a single-file **SQLite** database (WAL): the opaque envelope and
its lifecycle metadata live in **one row**. A read runs inside one
`BEGIN IMMEDIATE` transaction that both increments the view counter and, when
exhausted/expired, deletes the row — closing the cross-store atomicity gap the
Worker's split R2 (body) + KV (metadata) design has (it relies on lazy
orphan-reaping and cannot strictly serialize concurrent max-views reads). A
background reaper plus lazy-on-read deletion replace KV's TTL auto-expiry.

**Security parity + additions.** Bearer auth with a length-independent
constant-time compare (an unset secret rejects every write); body-size cap
(`413`); every gated read returns `404` with no existence leak. Added over the
Worker — which leans on Cloudflare's edge — is **per-IP token-bucket rate
limiting** (`429`) to blunt code enumeration, plus an optional `Origin`
allowlist. Client IP is resolved from `Fly-Client-IP` / the first
`X-Forwarded-For` hop. TLS is terminated by the platform, as with signaling.

**Shared logic.** A `services/share-server/core/` crate holds the side-effect-free parts
— envelope validation, the read-lifecycle decision, code generation, the
constant-time compare, and the rate-limit token bucket — unit-tested in
isolation, mirroring `services/signaling-server/core/`. (The split is structural only:
the share Worker is TypeScript, so the shared contract is the HTTP API, not code.)

**Observability.** `GET /healthz` (JSON) and `GET /metrics` (Prometheus:
`share_created_total`, `share_read_total`, `share_deleted_total`,
`share_rejected_total{reason=…}`, `share_active`, `share_uptime_seconds`).

Config is env-driven (`SHARE_DB_PATH`, `SHARE_UPLOAD_SECRET`,
`SHARE_MAX_BODY_BYTES`, `SHARE_ALLOWED_ORIGINS`, `SHARE_RATE_PER_SEC` /
`SHARE_RATE_BURST`, `SHARE_REAPER_INTERVAL_SECS`, `PORT` / `BIND_ADDR`). See
`services/share-server/README.md` for the build/run/deploy guide.

## The anonymous visitor (2026-09-25)

**Problem.** Phase 4 put the viewer into the app's static export so that one
`/share/view` route serves both the owner in the app and an anonymous visitor on
the share host. The second case never worked in a shipped build. The route sat
under the whole authenticated runtime in `app/layout.tsx`, so `AccountGate`
showed a fresh browser the "Create local account" form instead of the share.
Creating an account then handed off to `OnboardingGate`, which replaced the
route with `/onboarding` and dropped `?c=…#k=…`. Reproduced against a production
export (`NODE_ENV=production`, no `NEXT_PUBLIC_E2E`) in a fresh browser context.
The link made no envelope read and showed the first-run form. After an account
was created, the page was on `/onboarding` with the link gone, and nine IndexedDB
databases existed in the visitor's browser. Two things hid it. The E2E spec's
`prepareViewer` seeds an account first, and the dev server provisions a
throwaway account in every fresh profile.

**Options weighed.**

1. _Add `/share/view` to `LIGHTWEIGHT_ROUTE_PREFIXES`._ Rejected. That list is
   keyed on the route so that the static HTML and hydration agree, but it is all
   or nothing. The owner's in-app copy would lose the account it needs for the
   import actions (`template-definition`, `chat-template`), and the app chrome
   with it.
2. _Key a lightweight branch on the origin_ (served from the share host means
   lightweight). Rejected, for three reasons. The static HTML cannot know the
   origin, so it would switch after hydration anyway. The share origin is itself
   account-scoped config (`AppSettings.shareUrl`), which cannot be read before an
   account is open. And the branch could not be exercised on `localhost`.
3. _Pass through at the gates, keyed on the settled account state._ Chosen.

**Decision.** Reading a share needs no local account.

- `isShareViewerRoute(pathname)` (`lib/share/viewer-context.ts`) names the route
  in every spelling a static host serves it under (`/share/view`,
  `/share/view/`, `/share/view.html`). It matches that route only, nothing under
  or beside it.
- `AccountGate` takes a `guestView`. The root layout fills it with the page
  inside `ShareGuestShell`. On the share route, once the registry has settled
  (`loaded && !loading`), the gate renders:

  | Account state                                            | Renders                                                                                   |
  | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
  | An account is open                                       | The full runtime, unchanged: chrome, library, import                                      |
  | No account on this origin                                | The guest view directly, never the first-run form                                         |
  | Accounts exist, none open                                | The unlock screen as before, plus "Read without unlocking", which switches to the guest view |
  | Native mobile, the one-time recovery key, pet overlays   | Unchanged, and checked first                                                              |

  The static HTML and the first client render are both the boot screen, because
  the store has loaded on neither, so they agree. The gate chooses between the
  app and the guest view after that.

- **Why wait for `loaded`, and why unlock first when accounts exist.** Every
  read of a share counts a view (`maxViews`, burn-after-read). The choice has to
  be final before the page mounts. A gate that switched shells afterwards would
  remount the page and fetch the envelope again. By the time `loaded` is set,
  every automatic unlock has run (the desktop workspace, a remembered profile,
  tab-session resume), so an owner is never shown the guest view first. For the
  same reason, a locked owner is asked to unlock _before_ the page mounts. The
  other order, a guest view with an unlock button inside it, would already have
  spent a read.
- `CloudSignInGate` and `OnboardingGate` let the route through, as they already
  do for `/lark/workbench`. A web sign-in round-trips through the identity
  provider, and a first-run redirect leaves the page. Both lose the `#k=` key.
  Entering the app from the viewer still meets both gates.
- `ShareGuestShell` holds only the providers the viewer reads. next-intl and the
  theme come from above the gate. The shell adds `TooltipProvider` and
  `Toaster`, and nothing else: no `SettingsHydrator`, no plugin runtime, no
  Dexie. Under it the viewer reads from `defaultShareBaseUrl()`, the build-time
  `NEXT_PUBLIC_SHARE_URL`, instead of `resolveShareEndpoint()`. It offers no
  import and does not call `resolveShareViewerRunsInApp()`. This matters because
  `getDb()` falls back to the legacy database when no account is selected, so
  reading the settings row or the keyring would create an app database in a
  stranger's browser.

**Consequences.**

- The public deployment must be built with `NEXT_PUBLIC_SHARE_URL` naming its
  own host, as the Pages README already says. A guest has no `shareUrl` setting
  to override it.
- A guest sees the default locale, because settings never load and
  `LocaleGate` falls back to it. Picking up the browser's language on the public
  host is open follow-up work.
- On `/share/view`, the guest view takes the place of every screen the gate
  would show with no account, including the desktop's "workspace could not
  start" error, which leaves the registry empty. That error still shows on
  every other route, and reading a share does not need the workspace.
- A lock (idle auto-lock) unmounts the page, as it always has. Reading the link
  again afterwards, by unlocking or as a guest, fetches the envelope again, so
  it spends another view. That is the reader's choice, not a shell swap the
  gate makes by itself.
- The header and footer links to `/` still boot the full app. That is where a
  visitor creates an account ("Make your own with Cognia").
- Tests: `tests/e2e/share/public-share-view.spec.ts` gains an "anonymous
  visitor" block. It seeds nothing and opens the link as the browser's first
  navigation. It asserts the payload, the untouched URL, one envelope read, no
  account or legacy database, and no import offer for a `chat-template`. The
  guest-only assertions run against the static export, which is what CI runs,
  because the dev server provisions an account in every fresh profile. Unit
  tests pin each gate's pass-through and the page's guest mode.

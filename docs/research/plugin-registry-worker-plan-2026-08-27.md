# Plugin Registry on Cloudflare Workers — implementation plan

**Date:** 2026-08-27
**Status:** plan, not yet implemented
**Scope:** a new `services/plugin-registry/` Cloudflare Worker that serves the plugin
marketplace API the desktop app already speaks, plus the R2-backed bundle storage
behind it.

This document is self-contained. An agent picking it up needs no other context.

---

## 1. Why this exists

The app already ships a marketplace client (`lib/plugin/package/marketplace.ts`,
class `PluginMarketplace`) that fetches from `registryUrl`, defaulting to
`https://plugins.cognia.app/api/v1`. **That service does not exist.** Two
consequences are visible in the tree today:

- `lib/plugin/package/recommended-marketplace-sources.ts` exports an empty array
  on purpose, with the comment that it "ships EMPTY … until repositories that
  actually exist are published".
- The install call the client makes is broken and cannot work:
  `lib/plugin/core/manager.ts:2567` invokes `plugin_install` with
  `{ source, installType, pluginDir }`, while the Rust command
  (`crates/cognia-plugin-runtime/src/lifecycle.rs:1258`, registered at
  `src-tauri/src/lib.rs:1375`) has the signature
  `plugin_install(state, plugin_id: String, source: String, payload: InstallPayload)`.
  Neither `pluginId` nor `payload` is sent. The return shapes also disagree: Rust
  returns `PluginRuntimeSnapshot { pluginId, version, status, installPath }` while
  the TS destructures `{ manifest, path, source, installRootKind }`. Both call
  sites (`manager.ts:2567` and `marketplace.ts:987`) are only covered by tests
  that mock `invoke`, so the mismatch never goes red.

**Do not fix or revive `plugin_install`.** A separate, already-working install
path exists and is the one this registry must target — see §4.

The GitHub-repo marketplace path (`lib/plugin/package/github-marketplace.ts` →
`manager.installPluginFromGithub` → Rust `plugin_install_from_github`) _is_ wired
end-to-end today and stays as-is. This Worker adds a first-party registry
alongside it; it does not replace it.

---

## 2. Prior art to copy — `services/share-server/worker/`

Do not invent a deployment shape. `services/share-server/worker/` is an existing,
working Cloudflare Worker in this repo and the new service should mirror it
closely.

What it establishes (`services/share-server/worker/wrangler.toml`):

- **Worker + R2 + KV**, explicitly chosen to stay on free tiers
  (R2 10 GB, KV free tier, Workers).
- `compatibility_flags = ["nodejs_compat"]`.
- **Public reads, secret-gated writes** — writes/deletes require a bearer secret
  set via `wrangler secret put SHARE_UPLOAD_SECRET`.
- **Path-scoped route** rather than a custom domain, so a Pages project can own
  the rest of the host: `routes = [{ pattern = "share.cognia.cn/v1/*", zone_name = "cognia.cn" }]`.
- A **`[env.staging]`** block that repeats every var and binding (named envs do
  not inherit), deploying to `*.workers.dev` with no route.
- The deploy workflow `sed`s `REPLACE_WITH_KV_NAMESPACE_ID` from an
  environment-scoped CI variable, so staging and production inject their own.
- `[observability] enabled = true`.
- Tests run under **miniflare via vitest** (`vitest.config.ts`), no real
  Cloudflare account needed: `services/share-server/worker/src/index.test.ts`.
- The whole Worker is **584 lines** (`src/index.ts`). This one should be smaller.

`services/signaling-server/` additionally shows the pattern of shipping _both_ a
`worker/` and a Fly deployment for the same service. The plugin registry does not
need Fly — it is stateless request/response over R2 + KV.

---

## 3. The API contract the client already speaks

`PluginMarketplace` issues exactly four read requests, all via `proxyFetch`
(`lib/network/proxy-fetch.ts`), all `GET`, all under `${registryUrl}`:

| Endpoint                    | Source line          |
| --------------------------- | -------------------- |
| `GET /plugins?<query>`      | `marketplace.ts:574` |
| `GET /plugins/:id`          | `marketplace.ts:626` |
| `GET /plugins/:id/versions` | `marketplace.ts:672` |
| `GET /categories`           | `marketplace.ts:728` |

There are no other registry endpoints. **Publishing is not part of the client**
— it is an operator action (§6).

### 3.1 Entry shape (`/plugins` and `/plugins/:id`)

Read the normalizer at `marketplace.ts:~231-265` and match it exactly. It accepts
both camelCase and snake_case for several fields; **emit camelCase only**.

```jsonc
{
  "id": "string",                 // required
  "name": "string",
  "description": "string",
  "author": "string",
  "version": "0.0.0",
  "latestVersion": "0.0.0",       // falls back to `version`
  "repository": "https://…",      // optional
  "homepage": "https://…",        // optional
  "downloads": 0,                 // number
  "rating": 0,                    // number
  "ratingCount": 0,
  "tags": ["string"],
  "categories": ["string"],
  "manifest": { /* the plugin.json, verbatim */ },
  "publishedAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "verified": false,
  "featured": false,
  "downloadUrl": "https://…/bundle.zip",
  "checksum": "sha256-hex",       // optional
  "icon": …,                      // optional; see resolvePluginIcon
  "source": "marketplace",        // default when absent
  "descriptor": { /* ExtensionDescriptor */ }  // optional
}
```

`manifest` is the plugin's `plugin.json`. The install consent chain
(`lib/plugin/marketplace/install-flow.ts`) reads permissions, dependencies, and
`requires.binaries` out of it **before** any download, so it must be complete and
must match the manifest inside the bundle.

### 3.2 Version shape (`/plugins/:id/versions`)

Current normalizer (`marketplace.ts:~425-438`) reads only:

```jsonc
{
  "version": "0.0.0",
  "changelog": "string", // optional
  "publishedAt": "ISO-8601",
  "minAppVersion": "0.0.0", // optional
  "downloadUrl": "https://…",
  "checksum": "sha256-hex", // optional
}
```

**This shape must be extended — it is missing the signature fields.** See §4.

### 3.3 Categories (`/categories`)

A list of category identifiers. Read `marketplace.ts:~728` for the exact parse
before fixing the shape.

### 3.4 Error semantics

`categoryFromStatus` (`marketplace.ts:~440`) maps HTTP status to a client error
category, so use the statuses it expects:

| Status        | Client category    |
| ------------- | ------------------ |
| 401, 403      | `auth`             |
| 429           | `rate_limit`       |
| 400, 404, 422 | `validation`       |
| 409           | `install_conflict` |
| ≥ 500         | `network`          |

---

## 4. Install path — the decisive constraint

The registry must serve bundles in the form the **already-working** installer
accepts, and the client must be switched to that installer.

**Target:** `installFromUrl` in `lib/plugin/package/http-installer.ts` →
Tauri command `plugin_wasm_install_from_url`. Its argument shape
(`http-installer.ts:~29-46, 129-142`):

- `url` — the bundle `.zip`
- `signatureUrl?` — **a URL to a detached Ed25519 signature (base64 in the body)**
- `expectedPublicKeyBase64?` — required whenever `signatureUrl` is provided
- `requireSignature?` — throws if true and no `signatureUrl` is given

On success it records the publisher in the trust ledger (Dexie table
`trustedPublishers`, `lib/db/trusted-publishers.ts`) when
`authorPublicKey && authorFingerprint && signatureVerified`.

**Why this and not the inline-hex signature currently modelled in
`marketplace.ts`:** `cognia plugin sign`
(`crates/cognia-cli/src/engine/signing.rs`) produces a **detached
`<bundle>.sig` file**. That is exactly what `signatureUrl` wants. The inline hex
`signature` field sketched around `marketplace.ts:89-94` matches neither the CLI's
output nor any working installer, and its only consumer is the broken
`plugin_install` path. Serve detached signatures.

**Contract change required** — add to the version shape in §3.2 and to the
normalizer:

```jsonc
{
  "signatureUrl": "https://…/bundle.zip.sig", // optional but expected
  "publicKey": "base64", // base64, NOT hex; required when signatureUrl is set
}
```

Then change `marketplace.ts`'s install to call `installFromUrl({ url, signatureUrl,
expectedPublicKeyBase64, requireSignature })` and **delete the `plugin_install`
invocation** at `marketplace.ts:987` and `manager.ts:2567`.

Keep the existing pre-install consent chain in front of it: every install path in
this app funnels through `lib/plugin/marketplace/install-flow.ts`
(`conflict → dependencies → permission → binary-requirements → config → install`),
and **no Dexie row is written before the user approves every step**. Do not
bypass it.

---

## 5. Storage model

Mirror share-server's split.

**R2** (`PLUGIN_BUCKET`) — immutable blobs, keyed by id + version:

```
plugins/<id>/<version>/bundle.zip
plugins/<id>/<version>/bundle.zip.sig
plugins/<id>/<version>/plugin.json      # convenience; the zip is authoritative
plugins/<id>/icon.<ext>                 # optional
```

Bundles are immutable: a published `<id>/<version>` is never overwritten. Yanking
sets a flag in the index, it does not delete the blob (installed clients may
re-verify).

**KV** (`PLUGIN_KV`) — the index, small and read-hot:

```
plugin:<id>            → the entry JSON of §3.1
versions:<id>          → the version array of §3.2
categories             → the category list
index                  → the searchable list backing GET /plugins
```

`GET /plugins` filtering/sorting/pagination happens in the Worker over `index`.
Keep it simple — substring match over `name`/`description`/`tags` plus category
filter is enough; do not add a search engine.

Serve `downloadUrl` / `signatureUrl` as URLs the Worker itself handles
(`/blobs/<id>/<version>/bundle.zip`) rather than raw R2 public URLs, so the
Worker can enforce yank status and count downloads.

---

## 6. Publish path (operator-only)

Not part of the app client. Bearer-secret gated, exactly like share-server's
`SHARE_UPLOAD_SECRET`:

```
POST /admin/plugins/<id>/<version>     # multipart: bundle.zip, bundle.zip.sig, plugin.json
DELETE /admin/plugins/<id>/<version>   # yank (flag, not delete)
```

The Worker must, before writing:

1. Reject if `<id>/<version>` already exists (immutability).
2. Parse `plugin.json` out of the uploaded zip and verify it matches the
   submitted `plugin.json` and the `<id>`/`<version>` in the path.
3. Verify the detached signature against the declared `author.publicKey` if the
   manifest carries one.
4. Compute and store the sha256 checksum.

Archive-bomb and size limits: reuse the constants in
`crates/cognia-plugin-runtime/src/archive_limits.rs` (`MAX_DOWNLOAD_BYTES`,
`MAX_SIGNATURE_BYTES`) as the Worker's own caps so the two ends agree. Set
`MAX_BODY_BYTES` in `[vars]` the way share-server does.

---

## 7. Acceptance criteria

1. `wrangler dev` serves all four read endpoints with shapes that
   `PluginMarketplace`'s normalizers parse without falling back to defaults.
2. A miniflare/vitest suite (mirroring
   `services/share-server/worker/src/index.test.ts`) covers: the four reads,
   pagination, the six error statuses of §3.4, publish rejection on duplicate
   version, publish rejection on manifest mismatch, and yank behaviour.
3. **End-to-end, on a real desktop build:** `cognia plugin build` → `cognia plugin
sign` → publish to a staging Worker → the plugin appears in the in-app
   marketplace → install completes through the consent chain → the plugin loads
   and its contributions appear. Signature verification must actually pass, and
   the publisher must land in `trustedPublishers`.
4. `plugin_install` invocations are gone from `marketplace.ts` and `manager.ts`,
   and `registryUrl` no longer defaults to the non-existent
   `plugins.cognia.app`.
5. A staging deploy exists and is separate from production, per share-server's
   `[env.staging]` pattern.

---

## 8. Repo rules that apply (from `CLAUDE.md`)

- **The working tree is shared with other agent sessions.** Only ever
  `git commit --only <your paths>`. Never `git add .`/`-A`/`-u`, never
  `git stash`, `git reset --hard`, `git checkout -- .`, `git clean`, `git rebase`,
  `git merge`, or a branch switch — those destroy other sessions' uncommitted work.
- **Every new source file needs a co-located `*.test.ts`** (`pnpm audit:colocated-tests`).
- **No hard-coded user-facing strings in `.tsx`** — `useTranslations()`, keys in
  both `i18n/messages/en.json` and `zh-CN.json`, then `pnpm lint:i18n`.
  (Mostly N/A for the Worker; applies if you touch the marketplace UI.)
- **Run `pnpm changeset`** (package `cognia-next`) for the user-facing half —
  the marketplace becoming functional is user-facing.
- `services/` is outside the main workspace globs except
  `services/workspace-runtime`; check `pnpm-workspace.yaml` and follow
  share-server's arrangement rather than adding a new workspace entry blindly.
- `pnpm` only, install from repo root.

## 9. Out of scope

- Ratings/reviews write paths (`rating`, `ratingCount` are read-only fields
  served from the index; the Dexie table `pluginReviews` is local).
- Any change to the GitHub-repo marketplace path.
- Any change to the WASM/git/Open VSX/local-directory install paths.
- Reviving `plugin_install`.

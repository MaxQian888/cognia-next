---
title: "0084 — Cognia Sites"
description: "Defines Cognia-owned site authoring, immutable versions, recoverable deployment, provider resources, and visitor access without duplicating project, editor, browser, Git, terminal, or credential systems."
---

# ADR 0084 — Cognia Sites

**Status:** Accepted  
**Date:** 2026-07-18

## Context

Codex Sites combines an existing source workspace with local preview, immutable saved versions, production deployment, environment configuration, storage, visitor access, domains, logs, analytics, takedown, and deletion. Cognia needs the complete lifecycle under its own product control. OpenAI's proprietary Sites connector and hosting control plane are evidence for product semantics, not reusable dependencies.

A thin metadata row plus a deploy button is unsafe. Imported build scripts are untrusted; Git commits do not preserve build artifacts; remote-host routing makes credential locality ambiguous; provider operations can succeed after a client timeout; and D1, R2, domains, Access applications, or policies may be shared or adopted rather than owned by Cognia.

## Decision

### Composition and scope

A Site is a deployment aggregate linked to an existing Cognia `Project`. It records one explicit workspace root, a normalized source subpath, and an execution target. It does not duplicate project files, chat, editor, Git, terminal, artifact, browser, credential, or settings ownership.

The first complete provider is Cloudflare Workers. Provider behavior stays behind a Sites-specific hosting boundary; messaging connectors and the WASM plugin runtime are not hosting control planes. The main Next.js app remains a static export. Privileged build, artifact, credential, and provider operations run on the explicitly selected native host.

### Durable lifecycle

Persistence uses separate cardinalities and invariants:

- `siteProjects` stores the Site identity, source link, provider link, authoring policy, and current lifecycle state.
- `siteVersions` is append-only after completion. A version captures source provenance, lockfile and toolchain fingerprints, build configuration, compatibility settings, routes, bindings, non-secret variables, secret-reference revisions, artifact digest, and artifact location.
- `siteDeployments` records which immutable version and environment revision serves traffic. Rollback is a new deployment of a historical version; it never mutates that version.
- `siteOperations` is a durable, idempotent state machine for build, provision, upload, deploy, access, environment, domain, takedown, reconcile, and purge operations. It leases work per target, records attempts and provider request/resource IDs, and can resume after crashes or timeouts.
- `siteResources` records every provider object and whether it is `managed`, `adopted`, or `shared`. Destructive cleanup is allowed only for unreferenced managed resources.

Saved artifact bytes are content-addressed and immutable. A source commit alone is insufficient. Artifact retention and garbage collection must preserve every version referenced by a deployment or unfinished operation. D1 data, R2 objects, and secret values are mutable external state and are explicitly not represented as code rollback.

### Execution and credentials

Imported dependency installation and builds are untrusted. They always run in a fail-closed Sites confinement profile with explicit read/write mounts, bounded CPU/memory/time/output, and denied network by default. Network access, when a build genuinely requires it, is a separate user-approved allowlist capability. Provider credentials are never injected into a build process.

Credential calls use an explicit execution target. Local credentials use a non-routable local keyring path and cannot be silently forwarded by the process-wide remote-host transport. Provider upload/deploy starts only after a build has finished and receives credentials through the provider operation boundary, not source scripts or command text.

### Authorization and visitor access

Authoring authorization and deployed-site visitor access are separate:

1. Cognia authoring policy controls who may edit configuration, save versions, deploy, change access, or purge a Site.
2. A provider-neutral visitor policy describes `private`, selected identities/domains, organization, or `public` access.
3. The provider adapter compiles and verifies that visitor policy. Cloudflare Access is an enforcement adapter, not Cognia's authoring authority. Drift is detected and surfaced; an unverifiable or bypassed policy fails closed for restricted Sites.
4. Application-level authorization remains the deployed application's responsibility.

### Preview and destructive actions

Local preview reuses the project editor, terminal session, and Browser UI, but the native embedded-browser singleton must be arbitrated. A Sites preview acquires an explicit owner lease and cannot navigate or destroy another Browser surface.

Takedown and deletion are distinct. Takedown removes production traffic while preserving versions and provider data. Deleting the Cognia Site removes local metadata only after an explicit confirmation and reconciliation. Purge is a separate, typed destructive operation that deletes only eligible managed resources in dependency order and reports adopted/shared resources left intact.

## Consequences

This design adds several small Sites tables and an operation reconciler instead of one mutable metadata object. It also requires native confinement and target-local credential seams before production deployment is enabled. The extra state is necessary for immutable versions, crash recovery, multi-window safety, auditable destructive behavior, and honest ownership boundaries.

Desktop is the authoring and deployment host. Mobile may receive a deliberate read-only projection only after its sync table, delta reader, tombstones, and handler are added; plain web does not claim access to *another host's* local Sites metadata.

The Sites console itself renders in every shell, over whichever local database that shell owns — in a browser that is the browser profile's own IndexedDB, which is a different database from the desktop's and involves no cross-host projection. What is gated is the set of privileged **actions**, per control, with a stated reason: builds need the OS sandbox, previews need a PTY, provider calls need the OS keyring and a non-CORS-blocked fetch, and the hosting manifest needs filesystem access. Gating the surface instead of the actions was worse than useless — the panel blanked itself and read as having no functionality at all — and it also hid three failure modes that produce wrong answers rather than errors off-desktop: the keyring silently falls back to an in-memory store, the provider fetch is blocked by CORS, and `readTextFile` resolves to the dev server's 404 body.

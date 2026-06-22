---
title: ADR-0054 — Local multi-account isolation
description: "Introduce genuine independent local accounts by moving the existing single-user Dexie database into per-account physical databases, keeping the project/workspace layer inside each account, namespacing credentials and companion sync by active account, and auto-wrapping legacy installs into the first local account without deleting source data until migration success is recorded."
---

# ADR-0054 — Local multi-account isolation

**Status**: Accepted (2026-06-21)
**Authors**: Max Qian + Codex
**Builds on**: the v86 project/workspace isolation model, AppSettings singleton, local subscription keyring vaults, companion sync, and ADR-0037 public share links.

## Context

Cognia's local app is currently single-user by design. The Dexie database is physically named `cognia-claude`, `AppSettings` is a singleton row with id `singleton`, and the active workspace/project id lives inside that singleton. The v86 project layer already provides isolation between workspaces inside one local user by ensuring scoped data resolves to a non-null `projectId`.

The new requirement is different: multiple people must be able to use the same device with independent local accounts, and one account's data must be invisible to another. There is no cloud backend and the main app remains a Next.js static export (`output: "export"`), shelled by Tauri on desktop and Capacitor on mobile. Any privileged local work, such as password verification helpers, remains in Tauri Rust rather than Next.js route handlers.

We evaluated three options:

- **A. Separate Dexie database per local account**. Each account owns a physical database such as `cognia-account-<accountId>`. Existing project/workspace isolation remains unchanged inside that database. The app keeps a user-independent account registry that stores account metadata, the active account pointer, and legacy migration status.
- **B. Single Dexie database with `userId` on every table**. This would require adding `userId` to every persisted table and every scoped query, including future tables. It also leaves all users in one physical browser database.
- **C. A or B plus at-rest encryption**. This would derive a per-user key from the local password through Rust KDF support and encrypt persisted data on disk. It provides stronger confidentiality but materially expands migration, recovery, and mobile complexity.

The approved phase chooses **A with local-password app-layer lock/unlock and no at-rest encryption**. Encryption remains a possible later ADR; this ADR does not claim disk confidentiality against a local attacker with filesystem access.

## Decision

### Account isolation model

- Add a user-independent local account registry. It is not stored inside per-account `AppSettings`, because `AppSettings` only exists after the account database is known.
- Each account has a stable opaque `accountId`, a display name, password verifier metadata, creation/update timestamps, and lifecycle state.
- Runtime app data lives in one Dexie database per account, named `cognia-account-<accountId>`.
- The active account pointer lives in the account registry, not in `AppSettings`.
- `CogniaDB` resolution becomes account-aware. After account initialization, normal app reads open only the active account database. Switching accounts closes the current Dexie handle and reloads account-local stores.
- The existing project/workspace layer stays one level below the account layer. `AppSettings.activeProjectId`, projects, sessions, messages, connectors, paired devices, sync cursors, and workspace-scoped local data remain account-local because they live inside the selected account database.

### Authentication

- Accounts use a local password to unlock the account gate.
- Password verification runs through a Tauri Rust command so desktop can use native KDF implementations and future at-rest encryption can reuse the same boundary.
- The phase does not encrypt Dexie rows at rest. "Mutually invisible" means app-layer and database-selection isolation, plus account-scoped keyring and sync routing.
- The web/static-export build must not import server-only code or depend on `app/api` route handlers for login.

### Legacy single-user migration

- Existing installs with `cognia-claude` are automatically wrapped into the first local account on upgrade.
- Migration copies all legacy tables into the first account database and records success in the account registry only after the copy is complete and verified.
- The legacy source database is not deleted during migration. It remains a rollback source until a future explicit cleanup flow is designed.
- A migration test must seed representative v86 data and prove settings, projects, sessions, messages, connector rows, companion rows, shared links, and sync cursors land intact in account #1 and are absent from account #2.

### Credential and keyring namespacing

- Existing keyring primitives that accept `(namespace, key)` are reused.
- Subscription/provider vaults and other local secrets gain a local account dimension. Effective identity is `localAccountId × provider × providerAccountId` rather than only provider-level identity.
- Legacy provider secrets are adopted into the first migrated account when possible; otherwise the UI must ask that account to re-authenticate. No other account may see or reuse those secrets.

### Companion sync scoping

- Companion sync is scoped to the active account.
- Pairing/JWT/device identity gains an account binding. A mobile device paired under account A cannot pull account B after a desktop account switch.
- Sync pull events carry or resolve the account id, and the TypeScript bridge rejects requests that do not match the active unlocked account.
- Sync cursors remain per-account because they live inside the per-account Dexie database, but RPC validation still rejects cross-account mismatches before reading data.

### Share-link ownership

- Public share links keep their existing worker-side `ownerToken` isolation.
- Local shared-link mirror rows become account-local through the per-account database.
- If a later feature needs server-visible account grouping for owner tokens, that belongs in a follow-up ADR; it is not required for local isolation.

## Consequences

- Physical Dexie separation avoids retrofitting `userId` through every table and query path.
- The project/workspace isolation model remains intact and composes naturally under the account layer.
- The active account pointer has a clear bootstrap home outside `AppSettings`, avoiding a chicken-and-egg dependency.
- Switching accounts is more disruptive than switching projects because it changes the active database. A deliberate app-level reload or full store rehydration is required.
- App-layer isolation is not the same as encrypted-at-rest confidentiality. Users who require disk confidentiality need a future encryption phase.

## Out of scope

- At-rest encryption of Dexie rows.
- Cloud identity, account sync, or remote login.
- Next.js runtime route handlers for account auth.
- Removing the legacy `cognia-claude` database during the first migration.
- Replacing the existing project/workspace model.

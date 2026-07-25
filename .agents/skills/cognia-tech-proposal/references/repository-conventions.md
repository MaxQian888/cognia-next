# Cognia repository conventions for proposals

Always re-read repository files; this is a routing map, not a permanent snapshot.

## Architecture surfaces

| Surface | Typical paths | Proposal concerns |
|---|---|---|
| Next.js product UI | `app/`, `components/`, `hooks/`, `stores/`, `lib/`, `types/` | App Router/static export, React state, accessibility, i18n, Dexie, browser/mobile behavior |
| Tauri desktop | `src-tauri/`, `crates/cognia-*` | command registration, capabilities/ACL, async safety, serialization, native platform variance |
| CLI and agent hosts | `cli/`, `sidecar/` | protocol/event mapping, terminal/TUI behavior, install/discovery, process lifecycle |
| Mobile | `mobile/`, mobile components/hooks, `tests/e2e/mobile/` | Capacitor plugins, standalone/paired modes, offline/persistence, iOS/Android variance |
| Plugins and SDKs | `plugins/`, `plugin-sdk/`, `packages/*` | manifests, activation/wiring, TS/Rust/WIT contract, compatibility/versioning |
| Services/deployment | `services/`, `deploy/`, Dockerfiles | public/private ingress, auth, tenancy/workspace isolation, health, resource limits |
| Docs | `docs/content/docs/{en,zh}/`, `docs/plans/` | bilingual parity, implementation accuracy, static/server build differences |
| Tests/gates | co-located tests, `tests/e2e/`, `scripts/gates/`, `.github/workflows/` | ≥90% changed-file coverage, E2E governance, platform CI, generated contract checks |

Use `pnpm-workspace.yaml`, `Cargo.toml`, package manifests, and current directories to refine this map.

## Hard repository contracts

- Research existing implementations in `lib/`, `components/`, `hooks/`, `src-tauri/`, relevant crates/services, and ADRs before proposing a new module.
- Edited/new source under governed paths needs a co-located test.
- Frontend user-facing strings use `next-intl`; add both English and Chinese keys.
- Main Next.js app is a static export. Avoid server-only assumptions in product routes.
- Tauri commands require registration plus capability/ACL checks.
- Dexie schema changes require a real migration, monotonic version coordination, and rollback/forward compatibility.
- Outbound LLM/embedding/cloud text requires the PII redaction gate.
- New modules/components/commands/plugins must be wired into runtime reachability.
- Use current package scripts as gates; do not invent commands from memory.

## Proposal metadata

Use:

```text
Status · Author · Date · Scope/layers
Issue/PRD · Related ADR/docs · Branch
Reviewers/roles · Target release/milestone
Evidence state · Security/privacy impact
```

## Depth-escalation signals

Escalate to heavy when any applies:

- Dexie, SQLite, persisted JSON, migration, backup, or sync format;
- public CLI/MCP/plugin/WIT/SDK/protocol contract;
- Tauri capability, filesystem/process/network/secret access;
- multi-account, multi-workspace, tenancy, remote runtime, or external ingress;
- agent event/state translation across providers;
- background process, detached task, retry queue, cancellation, recovery;
- release/deployment topology or compatibility with old clients/plugins;
- PII, credentials, approvals, permissions, or irreversible external actions.

## Verification families

Select exact commands from current manifests:

- TS: focused Jest, `pnpm typecheck`, `pnpm lint`, `pnpm test:coverage`.
- i18n/static export: `pnpm lint:i18n`, `pnpm lint:static-export`, `pnpm build`.
- Rust: focused `cargo test`, workspace tests, clippy/fmt gates.
- E2E: focused Playwright then static-export and platform project.
- Plugins/SDK: manifest/contract/WIT/build/pack/scaffold gates.
- Sidecars/services: owning tests plus smoke/compose/protocol checks.
- Docs: bilingual content checks and `pnpm docs:build`.

A proposal names the minimal target checks and the wider merge gate. Do not claim a check passed unless it was actually run.

## Branch, commit, and rollout

Follow the current `AGENTS.md` and repository branch policy. Proposals should describe rollout and rollback behavior, but should not create branches, commits, PRs, deployments, or external documents unless the user requested those actions.

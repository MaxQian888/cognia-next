---
title: "ADR-0012 — GitHub Delivery"
description: Bring AI-driven PR review, Issue → PR loops, and Release automation into the cognia visual workflow editor.
---

# ADR-0012 — GitHub Delivery

**Status:** Accepted
**Date:** 2026-05-12

## Context

cognia-next has four robust subsystems — the visual workflow editor (38 node kinds, v22 schema), the plugin runtime (13 extension points), the scheduler (8 executor classes), and ConnectorBus (5 platform adapters) — but no first-class way to operate on GitHub. We ship CI files under `.github/workflows/` but the client can't participate in PR review, issue triage, or release automation against the same repo it's developing.

Goal: users compose **PR auto-review + Issue → PR loop + Release automation** as visual workflows that run on top of cognia's existing primitives. Every action is policy-gated, audit-logged, and surfaces in the same Inbox that handles platform messages.

**Out of scope.** CI/CD orchestration (lint / test / build / deploy stays in GitHub Actions), generic GitLab / Gitea adapters, cognia-hosted token-exchange service.

## Decision

GitHub Delivery is implemented as a **thin core layer** (`lib/github/`) + a **plugin shell** (`plugins/github-delivery/`). The plugin contributes workflow nodes, a webhook trigger, a scheduled polling task, an inbox-bound connector adapter, and 5 settings sub-tabs. The Rust side gets one new feature: a `signatureMode: "github"` option on the existing webhook receiver so `x-hub-signature-256` headers verify against the same code path as cognia's internal triggers.

### Architecture

```
plugins/github-delivery/
├── plugin.json            — declares dexie tables (4), permissions
├── src/index.ts           — plugin entry, registers runtime
├── src/github-poll.ts     — ETag-based polling task
└── src/workflow/
    ├── runtime.ts         — singleton GithubRuntime registration
    ├── shared.ts          — guardedExecutor() factory
    └── nodes.ts           — 12 action.github.* executors

lib/github/
├── types.ts               — GhRepoEntry, GhPolicy, GhAction, GhAuditEntry, …
├── octokit-factory.ts     — App + PAT routing, throttling/retry plugins
├── auth-app.ts            — installation-token cache (5-min refresh window)
├── auth-pat.ts            — PAT auth wrapper
├── webhook-verify.ts      — timing-safe HMAC SHA-256
├── event-normalizer.ts    — webhook + polling → NormalizedGhEvent
├── policy-gate.ts         — single guard for 6 action kinds
├── workspace.ts           — simple-git worktree (local + e2b stub)
└── changelog.ts           — Conventional Commits → semver bump + notes

src-tauri/src/workflow/triggers/webhook_router.rs
└── SignatureMode { Cognia | Github } — header convention switch
```

### Plugin Dexie tables (4)

The github-delivery plugin is the first user of the M0 Plugin Dexie Tables platform feature. It declares:

| Logical name | Stored as | Purpose |
|--------------|-----------|---------|
| `repos`      | `github-delivery:repos`      | Per-repo configuration (App/PAT, push target, policy) |
| `workOrders` | `github-delivery:workOrders` | Issue → PR loop state machine |
| `events`     | `github-delivery:events`     | Webhook + polling delivery dedup |
| `audit`      | `github-delivery:audit`      | Every policy decision (allow + deny) |

### Credentials (D5/D6)

Two credential modes, picked per repository:

- **GitHub App** (recommended). 5K calls/hour, installation-scoped, audit trail per installation. User creates the App; cognia never hosts a shared App or its private key.
- **Personal Access Token** (kickstart). Faster setup; tied to the human user. Use for personal repos and trial runs.

Both store secrets through the plugin secrets API (OS keyring in Tauri, encrypted blob in web). App installation tokens are minted via `@octokit/auth-app`, cached per `(appId, installationId)`, and **refreshed 5 minutes before expiry** so callers never see a 401.

### Triggers (D2)

- **Webhook (default).** `trigger.github.webhook` registers a path with the existing Rust axum receiver. Verifier reads `x-hub-signature-256` (signature mode = github). Users paste a public URL; cloudflared one-click setup lands in M4.
- **Polling (fallback).** `github-poll` scheduled task polls `/repos/{owner}/{repo}/events` every 5 minutes with ETag conditional GET. Diffs against the events table to dedupe.

Both transports emit the same `NormalizedGhEvent` so downstream code only handles one shape.

### Policy gate (D8)

Every bot-driven mutation flows through `checkPolicy(action, ctx)`. Defaults (overridable per repo and per workflow node):

- `requireGreenCi: true` — block merges while CI is not `success`
- `requireHumanApproval: true` — humans must approve merges + non-draft releases
- `maxDailyMerges: 5` — hard cap on bot merges per UTC day
- `branchProtection: ["^main$", "^master$", "^release/"]` — no direct pushes
- `allowedAuthors: { kind: "collaborators" }` — bot acts only on repo collaborators' work
- `quietHours?` — `lib/connectors/outbound-runner` quiet-hours helper is reused

Every decision (allow + deny) writes to the namespaced `audit` table with the full `GhAction` discriminant + the `runId`/`stepId` context.

### Workflow node taxonomy (12 + 1)

Each `action.github.*` executor is a thin Octokit call wrapped in `guardedExecutor` (policy + audit boilerplate).

| Node | Octokit endpoint | Policy action |
|------|------------------|---------------|
| `action.github.openPr`             | `POST /pulls`                        | `push` |
| `action.github.closePr`            | `PATCH /pulls/{n}` state=closed      | `close` |
| `action.github.mergePr`            | `PUT /pulls/{n}/merge`               | `merge` |
| `action.github.reviewPr`           | `POST /pulls/{n}/reviews`            | `comment` |
| `action.github.commentPr`          | `POST /issues/{n}/comments`          | `comment` |
| `action.github.commentIssue`       | `POST /issues/{n}/comments`          | `comment` |
| `action.github.labelIssue`         | `POST + DELETE /issues/{n}/labels`   | `label` |
| `action.github.closeIssue`         | `PATCH /issues/{n}` state=closed     | `close` |
| `action.github.createRelease`      | `POST /releases`                     | `release` |
| `action.github.generateChangelog`  | `GET /compare/{base...HEAD}`         | n/a (read-only) |
| `action.github.pushTag`            | `POST /git/refs`                     | `push` |
| `action.github.runIssueLoop`       | clone → AI → push → openPr           | `push` |

`runIssueLoop` is gated behind the M5 Claude Code subprocess integration and throws a friendly "M5 pending" error until that lands.

### Built-in templates (7)

`lib/workflow/definition/seed-github.ts` ships 7 templates that the user can fork:

1. **[GitHub] PR auto-review** — webhook → AI review → submit review
2. **[GitHub] Issue smart triage** — webhook → AI classify → label
3. **[GitHub] Issue → PR loop** — webhook on label → runIssueLoop
4. **[GitHub] Release: Conventional Commits** — cron → changelog → draft release
5. **[GitHub] Release: continuous** — merge → tag → release
6. **[GitHub] Release: manual** — manual click → release
7. **[GitHub] CI failure diagnosis** — check_run failure → AI → PR comment

### UI surfaces

- **Settings → GitHub Delivery** — 5 sub-tabs (Repos / Credentials / Policies / Audit / Usage). URL-driven (`?ghTab=...`).
- **Independent page `/github-delivery`** — 6-column kanban over the `workOrders` table.
- **Inbox** (M4-shell) — events with PR/Issue context (review_requested / assigned) appear as `InboundMessage`s.

### Rust changes (minimal)

`src-tauri/src/workflow/triggers/webhook_router.rs`:

- New `SignatureMode` enum (`Cognia` | `Github`) on every `WebhookEntry`.
- `verify_hmac_signature` reads from `mode.header_name()` (cognia → `x-signature-256`, github → `x-hub-signature-256`).
- `workflow_register_trigger` IPC implicitly picks `Github` when `kind == "trigger.github.webhook"`; an explicit `signatureMode` field on the input still overrides for forward compatibility.

## Consequences

**Positive**

- Users own their GitHub App private keys; cognia ships no shared App and no token-exchange service.
- Every bot action is policy-gated and audit-logged, with regex-protected branches and a daily merge cap as defense-in-depth against AI runaway.
- 7 templates compose from already-registered executors, so the first-run experience is fork-and-go.
- The Rust signature mode change is non-breaking — existing `trigger.webhook` triggers keep using `x-signature-256`.

**Negative**

- Two credential modes means two onboarding flows. The Credentials sub-tab funnels users to App by default but PAT remains available.
- Web mode can't run the webhook receiver (no Rust). The Repos tab badges this and the Settings UI surfaces a "desktop only" hint.
- The `runIssueLoop` happy path requires Claude Code; users with no provider configured see a clear M5-pending error rather than a silent stall.

**Neutral**

- 4 Dexie tables added under the plugin namespace. Per the M0 retention rule, data is preserved on uninstall unless the user opts into "Delete data" in Settings → Plugins.

## Open issues (deferred)

- cloudflared one-click tunnel setup (planned for M4 second pass)
- E2B-backed workspace mode (planned for M5)
- 30-day usage chart in the Usage tab (placeholder ships in M4)
- Real-time GitHub API quota readout (`GET /rate_limit` polling in the plugin)

## References

- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [GitHub Apps overview](https://docs.github.com/en/apps/overview)
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [`@octokit/auth-app` README](https://github.com/octokit/auth-app.js)
- ADR-0011 — Workflows subsystem (visual workflow editor + runtime)
- M0 plan: Plugin Dexie Tables platform feature

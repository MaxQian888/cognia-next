# RUNBOOK — host CLI reference, state, backup, recovery

This is the operator's reference for the host side of the workbench: every
`latexwb` command and flag, the state directory, the host policy, and how to
back up, recover and troubleshoot. For the agent session see
[PI-SESSION.md](PI-SESSION.md); for installation see [INSTALL.md](INSTALL.md).

`latexwb` is `node packages/cli/src/bin.ts` (put it on `PATH` with
`cd packages/cli && npm link`). Both spellings take identical arguments; the
examples below use `latexwb` for brevity.

## Conventions

- **Output.** Every command prints schema-shaped JSON on stdout, except
  `artifact cat`, which streams the raw blob bytes.
- **Errors.** A failure prints `{"error":{"code","message","retryable"}}` on
  stderr. The `code` is one of the contract error codes
  (see [Troubleshooting](#troubleshooting)).
- **Exit codes.**

  | code | meaning |
  |---|---|
  | 0 | success |
  | 1 | usage error: unknown command, unknown flag, missing/stray positional (usage text on stderr) |
  | 2 | `doctor` only: at least one blocking code (`blockingCodes` non-empty) |
  | 3 | the operation failed (`ToolError` JSON on stderr), or `provision-toolchain` smoke compile failed |
  | 4 | `build` only: the job ended in a state other than `succeeded` (the JobResult is still printed) |

- **Closed flag set.** Flags are validated against one allowlist; an unknown
  flag is a usage error, never ignored. `--flag value` and `--flag=value` are
  both accepted; a flag followed by another `--flag` (or nothing) is boolean.
- **Flat and nested spellings.** Every operation has a flat name
  (`release-package`) that expands to the older nested form
  (`release package`). Both work; flat names are preferred.

### Global flags

| Flag | Default | Meaning |
|---|---|---|
| `--state <dir>` | `./.latexwb` | state directory (created on first use) |
| `--workspace <id>` | `local` | workspace scope of every row |
| `--principal <id>` | `$LATEXWB_PRINCIPAL`, then `cli-operator` | host operator identity recorded on grants and audit rows |
| `--session <id>` | `cli-session` | session id recorded in audit |
| `--idempotency-key <k>` | — | replay-safe key for mutating calls |
| `--project <id>` | — | project scope; required by almost every command |

## Command reference

### Environment

| Command | What it does |
|---|---|
| `doctor` | Probes the host and prints a `DoctorReport` (see [INSTALL § Verify](INSTALL.md#verify)). Exit 2 only on blocking codes. |
| `provision-toolchain` | Downloads the pinned Tectonic bundle (~2.9 GB) into `runtime/toolchain/bundle`, verifies a hash sample, runs an offline smoke compile and rewrites `runtime/toolchain-lock.json`. Needs `tectonic` on `PATH`. |
| `provision-renderer` | Compiles `packages/runtime/render-helper/` with `swiftc` and pins binary + manifest sha256 in `runtime/render/manifest.json` (macOS arm64). |

### Projects, builds and artifacts

| Command | Flags | What it does |
|---|---|---|
| `import <hostDir>` | `[--project <id>]` | Scan a directory into a new snapshot and move the head. Without `--project`, the id is the sanitized directory name. The first import registers the directory as the project's **host root** (the only place `materialize`/`/latex sync` may write). |
| `inspect` | `--project [--snapshot]` | Analyse the head (or given) snapshot → `{inspection, derived}`: root candidates, targets, languages, packages, bibliography paths, assets. |
| `build` | `--project [--snapshot] [--target] [--preset] [--clean]` | Compile synchronously and print the `JobResult` (diagnostics, artifact ids). Snapshot defaults to the head; target auto-resolves when omitted. Exit 4 unless the job succeeded. |
| `jobs` | `--project [--watch]` | List the latest 100 jobs with their `resultArtifactIds`. `--watch` re-prints every second until every job is terminal. |
| `cancel <jobId>` | `--project` | Cancel a job; kills the runner process tree. |
| `artifact-cat <artifactId>` | `--project` | Raw bytes to stdout (hash re-verified on read). |
| `artifact-save <artifactId> <dest>` | `--project` | Write the artifact to a host file → `{artifactId, dest, bytes}`. |
| `events` | `--project [--after <seq>]` | Project outbox events after `seq` (default 0), max 500 per call. |
| `assets-inspect <sourceAssetId>` | `--project [--snapshot]` | CSV/TSV column analysis of a snapshot data file → inspection artifact + evidence. |

Artifact ids come from `build` output, `jobs` (`resultArtifactIds`) or the
`JobResult.buildResult` (`pdfArtifactId`, `logArtifactId`, …).

### Patches and approvals

| Command | Flags | What it does |
|---|---|---|
| `patch-propose` | `--project --ops <file.json> [--snapshot <base>]` | Propose a patch from an operations file (format below) against the head or `--snapshot`. Prints the proposal incl. `risk`, `protectedChanges`, `requiredApprovals`, `diffArtifactId`. |
| `patch-apply` | `--project --patch <id>` | Apply a proposal. Protected changes need a usable grant; a stale base is `STALE_BASE`. The CLI always uses **strict** semantics (authoring mode is a Pi-session setting). |
| `patch-show` | `--project --patch <id>` | Stored patch: state, base/result snapshot, digest, reason, operations, protected changes. |
| `patch-revert` | `--project --patch <id> [--reason <text>]` | Propose the inverse of an applied patch (still subject to conflict/approval checks). |
| `approve` | `--project --patch <id> [--action <a>] [--expires-in-seconds <n>]` | Host grant bound to the patch digest and its base snapshot. `--action` defaults to `patch.apply`; expiry defaults to 3600 s. |
| `approve` | `--project --action <a> --digest <64-hex> --snapshot <id> [--expires-in-seconds <n>]` | Action-bound grant, e.g. `release.package` with the `approvalDigest` printed by `release-freeze`/`release-status`. |
| `approvals-list` | `--project` | All grants — past-expiry grants are moved to `expired` before listing: `approvalId, principalId, action, scopeDigest, baseSnapshotId, policyId, expiresAt, state`. |
| `approvals-revoke <approvalId>` | `--project` | Revoke a grant that is still `granted`. |

**Operations file** for `patch-propose --ops`: a JSON object validated
against the `FileOperation` schema (the same operations the agent sends):

```json
{
  "reason": "Fix the unterminated align environment",
  "operations": [
    {"op": "replace", "path": "main.tex",
     "edits": [{"oldText": "a = b\n\\end{document}", "newText": "a = b\n\\end{align}\n\\end{document}"}]}
  ]
}
```

| `op` | Fields | Notes |
|---|---|---|
| `replace` | `path`, `edits: [{oldText, newText, occurrence?}]`, `expectedSha256?` | Exact-text anchors, resolved to byte ranges before analysis and digest. `oldText` must occur exactly once unless `occurrence` (1-based) picks one; zero/ambiguous matches are refused with line numbers. |
| `edit` | `path`, `expectedSha256`, `edits: [{startByte, endByte, replacement}]` | UTF-8 byte ranges (end exclusive), non-overlapping, on character boundaries. |
| `create` | `path`, `content` | New text file. |
| `delete` | `path`, `expectedSha256` | Remove a file. |
| `attach-asset` | `path`, `artifactId`, `expectedSha256` (or `null`) | Place an existing artifact (e.g. a generated figure) into the tree. |

An optional `"citekeyMapping": {"oldKey": "newKey"}` declares an intentional
citation-key rename; without it a removal plus addition of keys is refused as
a silent rename.

**Approval states** (`approvals` table): `granted` → `consumed` (used by
exactly one apply/package), `expired` (past `expiresAt`) or `revoked`. Each
grant's stored record (`record_json`) names how it was issued — `grantedVia`
is `cli-host` (this CLI), `pi-ui` (the in-session dialog or
`/latex approve`) or `host-authoring-mode` (auto-recorded in authoring mode,
consumed in the same apply). A grant binds to `(action, digest,
baseSnapshot)`: any change to the patch needs a new grant, and a patch whose
base is no longer the head fails with `STALE_BASE` regardless.

### Rendering, checks and page review

| Command | Flags | What it does |
|---|---|---|
| `render-pages` | `--project --artifact <pdfId> [--pages 1,3] [--preset screen\|detail]` | Rasterize pages (all when `--pages` is omitted) to page-image artifacts. Needs the render helper. |
| `render-text` | `--project --artifact <pdfId> [--pages 1,3]` | Per-page text extraction. |
| `check-run` | `--project --artifact <id> [--ruleset release\|draft\|data-assets] [--profile draft\|review\|submission] [--baseline <pdfId>]` | Run a ruleset and persist a `check-report` artifact. Default ruleset `release`; `--profile` applies to `release` only. For `data-assets` the artifact is a generated asset. |
| `check-report` | `--project --report <reportArtifactId>` | Read a persisted report. |
| `review-page` | `--project --artifact <pageImageId> --verdict approved\|flagged [--note <text>]` | Record a human verdict bound to the page image's bytes. The reviewer is the host principal. |
| `review-coverage` | `--project --artifact <pdfId>` | Which pages of a PDF have a verdict (latest verdict wins). |

Rulesets:

- **`draft`** — source lint for everyday writing, gates nothing:
  `draft.references`, `draft.duplicate-labels`, `draft.citations`,
  `draft.unused-bib-entries`, `draft.floats`, `draft.placeholders`,
  `draft.typography`, `draft.build-log`. Comment-masked source heuristics
  plus the producing build's diagnostics, each finding with `path:line`.
- **`release`** — `build-current`, `references-resolved`,
  `required-sections`, `assets-present`, `protected-content`,
  `text-extraction`, `page-dimensions`, `font-coverage`,
  `anonymization-scan`, `visual-coverage`, `venue-profile`,
  `baseline-compare`, `answer-isolation`, `asset-provenance`, `score-sum`
  (live) and `answer-mapping` (unsupported). Which ones are *required*
  comes from the target's output profile (`resources/profiles/outputs/`).
- **`data-assets`** — numeric-mapping fidelity/coverage, compile proof,
  `layout.visual-review` (always `needs-review`).

Every check id must be registered in
`resources/profiles/check-registry.json`; anything a machine cannot verify
reports `needs-review`, never `pass`.

### Release

| Command | Flags | What it does |
|---|---|---|
| `release-prepare` | `--project --snapshot --target [--profile]` | Compute and persist a `ReleasePlan` (whitelist, required checks/approvals) without freezing. |
| `release-freeze` | `--project --snapshot --target [--profile]` | Freeze a release row and print it with its `approvalDigest`. |
| `release-package` | `--project --release <id> --artifact <pdfId> [--baseline <pdfId>]` | Gates → digest-bound approval → deterministic source zip → clean-room rebuild → finalize. |
| `release-list` | `--project` | Releases with status. |
| `release-status <releaseId>` | `--project` (or `--release <id>`) | Status, manifest and the `approvalDigest` to grant against. |
| `export prepare` | `--project --snapshot --target [--profile]` | Contract alias of `release-prepare` (prints only the plan). |
| `export package` | `--project --snapshot --target --artifact <pdfId> [--profile] [--baseline]` | Freeze a fresh release and package it in one call. |

`--profile` is `draft`, `review` or `submission` (default `submission`).
Typical run:

```bash
latexwb build --project demo --target default               # note pdfArtifactId
latexwb render-pages --project demo --artifact <pdfId>      # page images
latexwb review-page --project demo --artifact <pageImageId> --verdict approved   # per page
latexwb release-freeze --project demo --snapshot <snap> --target default --profile submission
latexwb approve --project demo --action release.package --digest <approvalDigest> --snapshot <snap>
latexwb release-package --project demo --release <releaseId> --artifact <pdfId>
latexwb release-status <releaseId> --project demo
```

Final statuses: `blocked` (lists every failing gate code), `review-ready`,
`submission-ready`. `submission-ready` requires clean checks, full page-review
coverage (`requireAllReleasePagesReviewed`), a usable digest-bound grant, a
staged package and a clean-room rebuild whose PDF sha256 is identical.

### Host write-back (materialize)

| Command | Flags | What it does |
|---|---|---|
| `materialize` | `--project --dir <path> [--snapshot <id>] [--takeover]` | Write a snapshot (default: head) into a directory inside the project's host root through the journal. |
| `materialize recover` | `--project --dir <path>` | Finish or roll back an interrupted journal; prints `{"state":"nothing-to-recover"}` when there is none. |

Semantics (same code as `/latex sync` in a Pi session):

- `--dir` must resolve inside the host root registered at import; symlinks
  and escapes are refused.
- The baseline for "files we own" is the last **completed** journal. For the
  first sync back into the imported directory itself, it is the latest
  *import* snapshot the head descends from — so files untouched on disk
  since the import update cleanly.
- A file changed on disk since that baseline, or foreign content on a first
  sync, is a `STALE_BASE` conflict: nothing is written and the journal
  records `conflict`. `--takeover` adopts a directory that was never synced
  before (it does not override conflicts after a previous sync).
- Protocol: stage → journal `prepared` → `applying` → per-file atomic rename
  → `completed`. Journal data lives in `<dir>/.latexwb-materialize/` while
  in flight and is removed when finished. Terminal states: `completed`,
  `conflict`, `rolled-back`, `unrestorable`.

### Managed workflows

| Command | Flags | What it does |
|---|---|---|
| `workflow-start <definitionId>` | `--project [--context <file.json>]` | Start a persisted workflow from `resources/workflows/<id>.json`. |
| `workflow-status <workflowId>` | `[--project]` | State, current node, pending request, steps. |
| `workflow-resume <workflowId>` | `[--input <file.json>] [--project]` | Continue from `waiting-input` / `waiting-approval`. |
| `workflow-cancel <workflowId>` | `[--project]` | Cancel; cascades to owned jobs. |
| `workflow-list` | `--project` | Workflows of the project. |

`--project` may be omitted for status/resume/cancel; the owning project is
looked up from the workflow id.

Definitions (`resources/workflows/`):

| id | nodes (operation) |
|---|---|
| `repair` | inspect → build → diagnose (`agent.propose-minimal-repair`) → budget → approve → apply → check (`quality.review-draft`) |
| `revise` | inspect → baseline → propose (`agent.propose-revision`) → approve → apply → build → compare (`quality.compare-baseline`, **unsupported → blocks**) |
| `bibliography` | audit → resolve → proposal → approve → apply → build → report |
| `data-assets` | inspect → generate → proposal (`agent.propose-asset-insertion`) → approve → apply → build → check |
| `new-document` | inspect → initialize (`project.init-approved`) → outline (`agent.plan-document`) → approve → apply → build → review |
| `template-migration` | inspect → verify (`venue.verify-current`) → plan (`agent.propose-migration`) → approve → apply → build → check (`quality.compare-and-venue`, **unsupported → blocks**) |
| `release` | freeze → clean build → checks → page-review gate → whitelist prepare → approval gate → package → rebuild → finalize |

**Context file** (`--context`): a JSON object with string/null values for
these keys only — `snapshotId`, `targetId`, `pdfArtifactId`, `patchId`,
`causeId`, `baselineArtifactId`, `templateId`, `initTargetId`,
`bibReportArtifactId`, `auditReportArtifactId`, `generatedArtifactId`,
`checkReportArtifactId`, `releaseId`, `releaseProfileId`. Unknown keys are
refused.

**Resume input** depends on the step's `pendingRequest.kind`:

- `patch-proposal` (the `agent.*` steps): `{"patchId": "<id>"}` — a real
  patch in the same project whose base is the **current head**, e.g. one
  you created with `patch-propose`. Otherwise `NOT_FOUND`/`STALE_BASE`.
- `host-input` (`agent.plan-document`): any JSON value; it is stored as the
  step result.
- `approval` (`gate.*`): grant the named `action`/`scopeDigest` with
  `approve`, then resume without `--input`.

There is no model runner inside the engine: `agent.*` steps always wait for
the host to supply the answer. Completed steps with unchanged inputs are
reused on re-drive.

## State directory

All operational state lives in one directory — `--state <dir>` (default
`./.latexwb`; Pi sessions use `LATEXWB_STATE`). There is no daemon and no
external service. Outside the state dir the workbench writes only the
provisioned toolchain/renderer under `runtime/` and, on request, the
materialize target inside a project's host root.

```
<state>/
  workbench.db       SQLite (node:sqlite)
  blobs/             CAS — every artifact/blob addressed by sha256; reads re-hash
  jobs/              per-job work dirs (materialized sources, tectonic outputs,
                     logs) — pruned on success, kept on failure for inspection
  exports/<project>/ PDFs saved by `/latex pdf` in a Pi session
                     (<project>-<snapshot8>.pdf)
```

Tables in `workbench.db`: `projects` (incl. host-owned `host_root`),
`snapshots`, `snapshot_files`, `targets`, `patches`, `jobs`, `job_events`,
`artifacts`, `checks`, `reviews`, `approvals`, `workflows`,
`workflow_steps`, `evidence`, `releases`, `idempotency_records`,
`audit_events`, `materialization_journals`, `project_events` (outbox) and
`schema_migrations`. Every row is scoped `(workspace_id, project_id)`.
Artifact bytes live in `blobs/`; the `artifacts` table maps
`artifact_id → blob_hash + metadata`. Patch diffs are addressed as
`diff-<blobHash>` and resolve straight from CAS.

## Host policy (`runtime/host-policy.json`)

Host-owned; read fresh on every call, never influenced by project files.

| Field | Current value | Effect |
|---|---|---|
| `mode` | `isolated-sdk` | reported by doctor |
| `approvedImages` | `[]` | container images the docker runner may use; empty = docker runner unavailable |
| `network.compiler` | `deny` | builds run offline (`--only-cached`) |
| `network.metadataProviders` | `["crossref"]` | providers `latex_bib lookup` may query; remove to degrade lookups to recorded policy-denied evidence |
| `network.venueVerification` | `true` | allows `venue.verify-current` to re-fetch venue sources |
| `network.allowPrivateAddresses` | `false` (schema `const`) | private/loopback/link-local answers are always refused |
| `network.fakeIpCidrs` | `["198.18.0.0/15"]` | admits fake-IP proxy DNS answers; only sub-ranges of 198.18.0.0/15 are accepted |
| `limits.buildTimeoutSeconds` | 180 | wall-clock limit per build (enforced) |
| `limits.cpu/memoryMiB/pids/tempSpaceMiB` | 2 / 2048 / 128 / 512 | enforced only by container runners; the local runner reports them unenforced |
| `limits.logMiB` | 20 | log capture cap |
| `limits.unpackedInputMiB`, `limits.inputFiles` | 256 / 10000 | import limits |
| `projectConfigCanElevatePermissions`, `allowProjectRc`, `allowArbitraryRecipes` | `false` | project content cannot widen permissions |
| `requireAllReleasePagesReviewed` | `true` | unreviewed pages block a release |
| `protection.mode` | `strict` | default protection mode for Pi sessions (`strict`\|`authoring`); `LATEXWB_PROTECTION` and `/latex mode` override it per session |

Imports skip `.git`, `.hg`, `.svn`, `node_modules`, `.pi`, `.cache`,
`.latexwb`, `__pycache__`, `.env*` and `.DS_Store` (reported as
`excluded`); symlink/hardlink escapes, special files, path violations and
limit overruns are `rejected` with a reason — nothing is dropped silently.

## Backup

The state dir is self-contained; stop writers, then copy:

```bash
latexwb jobs --project X            # make sure nothing is queued/running
sqlite3 <state>/workbench.db ".backup '<state>/workbench.db.bak'"
cp -a <state>/blobs <state>/blobs.bak   # CAS is append-only
```

Simplest: `cp -a <state> <state>.snapshot` while nothing runs. After a
restore run `pragma integrity_check` on the db; every `artifact-cat` re-hashes
its blob (a corrupted blob throws `DIGEST_MISMATCH` instead of serving bad
bytes).

## Migrations and upgrades

`migrations/*.sql` run in order at every open; `schema_migrations` records
what was applied, so `migrate()` is idempotent and a changed migration file is
`MIGRATION_CHECKSUM_MISMATCH`. Current set:

| file | change |
|---|---|
| `0001_init.sql` | base schema |
| `0002_journal_terminal_states.sql` | journal states `rolled-back`, `unrestorable` |
| `0003_projects_host_root.sql` | host root moved out of `ProjectConfig` into `projects.host_root` |
| `0004_workflow_step_ops.sql` | operation ids/versions on workflow steps |

Upgrading = `git pull && npm install`; the next CLI/Pi invocation migrates the
db in place. Never hand-edit `workbench.db` — snapshots, files and jobs
reference CAS content and each other, and write paths enforce digests.

## Recovery

- **Crashed or lost job** — rows survive; a job whose lease expired is
  `lost` (retryable). Re-run `build` (identical inputs hit the build cache) or
  `cancel` it.
- **Interrupted apply** — `patch-apply` is one transaction: the patch stays
  `proposed`/`waiting-approval` and the head does not move; re-applying is
  idempotent.
- **Interrupted materialize/sync** — `latexwb materialize recover --project X
  --dir <dir>` finishes from verified staging or rolls back from backups.
  `unrestorable` lists the affected paths in the journal detail; do not treat
  that directory as a baseline until you have reconciled it by hand.
- **Corrupt blob** — `DIGEST_MISMATCH`; restore the blob from backup (the db
  row names the expected sha256).
- **Grant not accepted** — `approvals-list` shows its state; a grant is
  single-use and bound to `(action, digest, baseSnapshot)`, so re-proposing a
  patch or moving the head needs a fresh grant.
- **Re-importing** — `import` into an existing project creates a new
  snapshot from disk and moves the head. Edits made in a session that were
  not written back are still in earlier snapshots but are no longer the head:
  run `/latex sync` (or `materialize`) *before* editing on disk and
  re-importing.

## Cancellation

```bash
latexwb jobs --project X              # find the jobId
latexwb cancel <jobId> --project X
latexwb workflow-cancel <workflowId>  # cascades to the workflow's jobs
```

Build cancellation kills the runner process tree. The local tectonic runner
enforces wall-clock and output caps only (see UNSUPPORTED: cpu/memory/pids).
Workflows in `waiting-*` states simply stop; `workflow-resume` re-drives.

## Artifacts, logs, audit

- **Build log** — `artifact-cat <logArtifactId> --project X` (id in the job's
  `resultArtifactIds` / `buildResult`).
- **Diagnostics** — inside the job `resultJson` (`buildResult.diagnostics`)
  and the `diagnostics` job event: code, severity, `source.path`/`line`,
  page estimate, `rawLogRange`, confidence, and a hint for common errors.
- **Check reports** — `check-report --project X --report <reportArtifactId>`.
- **Release bundles** — `release-status <id> --project X` shows the manifest;
  the staged source zip and rebuilt PDF are CAS artifacts.
- **Events** — `events --project X --after <seq>` streams the append-only,
  seq-ordered outbox: head changes, job lifecycle, `review.required`,
  approval decisions, release transitions.

## Troubleshooting

| Code | Where | Usual cause → fix |
|---|---|---|
| `POLICY_DENIED` | apply, tools | protected change without a grant → `approve --patch <id>` (or approve in the Pi session); also cross-project calls and a broken session boundary |
| `STALE_BASE` | apply, resume, materialize | head moved since the proposal → re-read and re-propose; for materialize, a file changed on disk → reconcile it first |
| `TARGET_AMBIGUOUS` | build | several root candidates → pass `--target`, or register a target |
| `ENGINE_MISMATCH` | build | pdflatex/lualatex/biber requested; the local runner is XeTeX-only with bibtex → use a xelatex-compatible preset |
| `RUNTIME_UNAVAILABLE` | build, render | tectonic missing/unprovisioned, docker down, render helper absent or tampered → `doctor`, then provision |
| `INVALID_REQUEST` | everywhere | bad arguments; for `replace`, the anchor matched 0 or >1 times (the message lists line numbers) |
| `SCHEMA_VALIDATION_FAILED` | ops/context files | operation JSON does not match `FileOperation` |
| `NOT_FOUND` | everywhere | wrong id or project scope (ids are per project and workspace) |
| `DIGEST_MISMATCH` | reads | CAS blob corrupted → restore from backup |
| `NOT_IMPLEMENTED` | `serve`, `edit`, unsupported workflow ops | tracked in [UNSUPPORTED.md](UNSUPPORTED.md) |

Build diagnostics use their own codes (`UNDEFINED_CONTROL_SEQUENCE`,
`MISSING_PACKAGE`, `MISMATCHED_ENVIRONMENT`, `UNDEFINED_REFERENCE`,
`UNDEFINED_CITATION`, `DUPLICATE_LABEL`, `OVERFULL_BOX`, `MISSING_GLYPH`,
`FONT_SUBSTITUTION`, `BUILD_TIMEOUT`, `SECURITY_BOUNDARY`, …); the
`latex-build-debug` skill guide maps them to fixes.

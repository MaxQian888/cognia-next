# PI-SESSION — running the controlled agent session

The workbench is driven inside Pi by the extension
`packages/adapter-pi/extensions/workbench.ts`. The session is **controlled**:
the model can only reach the eight `latex_*` tools — no bash, no file tools,
no project extensions, and approvals are host-only.

## Launch

```bash
# 1. import the project the session will be bound to
node packages/cli/src/bin.ts import fixtures/domains/mathematics/broken \
  --project pi-demo --state .latexwb

# 2. start pi with the workbench extension, bound by env vars (host-owned)
LATEXWB_STATE=.latexwb LATEXWB_PROJECT=pi-demo LATEXWB_WORKSPACE=local \
  pi -p --no-session -ne \
    -e packages/adapter-pi/extensions/workbench.ts \
    "inspect the project and build it"
```

Session binding comes from environment variables, never from tool arguments
(the model cannot rebind the session or cross projects — a `projectId`
mismatch returns `POLICY_DENIED`, verified in the canary transcript):

| Env var | Default | Meaning |
|---|---|---|
| `LATEXWB_STATE` | `./.latexwb` | state dir (db + CAS) |
| `LATEXWB_PROJECT` | — | bound project id (REQUIRED for tool calls) |
| `LATEXWB_WORKSPACE` | `local` | workspace scope |
| `LATEXWB_PRINCIPAL` | `pi-operator` | principal recorded on tool actions |
| `LATEXWB_SESSION` | `pi-<pid>` | session id in audit |
| `LATEXWB_POLICY` | `default` | policy id for approval lookup |
| `LATEXWB_PROTECTION` | host policy (`strict`) | `strict` or `authoring` — see [Protected content](#protected-content-approvals-and-modes) |
| `LATEXWB_REPO_ROOT` | derived | repo root (resources/, runtime/) |

## The eight tools

All calls return a schema-validated `ToolEnvelope` (`execution`, `data`,
`error`, `diagnostics`, `artifacts`, `requestId`); each action runs under a
per-action capability context (for example only `latex_bib lookup` carries
`metadata.lookup`). Every call names the bound `projectId`; parameters are
re-validated against the frozen JSON schemas in `@latexwb/contracts` before
any service runs, and every string in the result is sanitized (ANSI/OSC
escapes stripped, control characters → U+FFFD).

| Tool | Actions | Notes |
|---|---|---|
| `latex_project` | `inspect`, `snapshot`, `read`, `search`, `artifact-read`, `doctor`, `init`, `resource` | `read`/`artifact-read` return up to 1000 lines (default 200) with `lineByteOffsets`; `search` matches carry `byteOffset` (max 100 results). `init {templateId, targetId}` copies only digest-verified approved templates into an empty project. `resource {resourceId}` loads `skill:<name>` or `skill:<name>:guide`. `snapshot {expectedHeadSnapshotId}` **re-imports** the host folder — not a save |
| `latex_patch` | `propose`, `apply`, `revert` | ops: `replace` (exact-text `oldText`→`newText`, optional 1-based `occurrence`; preferred), `edit` (UTF-8 byte ranges + `expectedSha256`), `create`, `delete`, `attach-asset`; ≤ 50 ops, ≤ 200 edits each. `propose` reports `risk`, protected changes (`added`/`modified`/`removed`) and a `diffArtifactId` readable via `artifact-read`. `revert {patchId, baseSnapshotId, reason}` proposes the inverse (`baseSnapshotId` = the snapshot that patch produced, else `STALE_BASE`). **No `approve` action** — grants come from the operator (dialog, `/latex approve`, `latexwb approve`) or host authoring mode |
| `latex_build` | `run`, `status`, `cancel` | `run {snapshotId, targetId, clean?}`; `targetId: "default"` auto-resolves the root of an imported project (ambiguity → diagnostic, never a guess). Check `data.buildResult.status` — `completed` execution does not mean the document compiled |
| `latex_bib` | `lookup`, `audit`, `propose-import` | `lookup {query}` or `{identifier}` searches the project `.bib` corpus plus Crossref when `host-policy.json → network.metadataProviders` admits it (every lookup persists evidence); `audit {snapshotId, bibPaths}`; `propose-import {baseSnapshotId, bibPath, candidateIds}` — no admissible candidate → `data: null` + `NO_CANDIDATES` |
| `latex_figure` | `table`, `plot`, `diagram` | from a snapshot data asset via the trusted recipe registry (booktabs / PGFPlots / TikZ), compiled with the real toolchain; returns artifact ids plus a numeric-mapping artifact |
| `latex_check` | `run`, `report` | `run {artifactId, rulesetId, baselineArtifactId?}` with ruleset `draft` (source lint: references, duplicate labels, citations vs bib, unused entries, floats, placeholders, typography, build log — gates nothing), `release` or `data-assets`; unverifiable → `needs-review` |
| `latex_render` | `pages`, `text` | `pages {artifactId, pages, renderPresetId: screen\|detail}` returns real PNG image blocks (8 MiB cap, `imagesTruncated` lists omissions) — a text-only model receives them stripped by the Pi host ("model does not support images"), which is honest, not a workbench failure; `text` extracts per-page text. Needs the provisioned PDFKit helper |
| `latex_export` | `prepare`, `package` | full release pipeline incl. the digest-bound approval gate; `releaseProfileId: draft\|review\|submission`; `package` accepts an optional `releaseId` to act on an already-frozen release (the digest a host grant binds to) — omitting it freezes a fresh release |

## /latex commands

Normal writing uses Pi's agent loop and the approved tools directly. Each turn
receives the current project binding, head, target IDs and a short skill catalog.
The operating contract is injected automatically; no manual `/base-system` is
needed. Skills load on demand via `latex_project resource`, so they remain usable
when Pi's native `read` and `bash` tools are disabled.

Use plain language or these native prompt shortcuts:

```text
/latex-write Extend the introduction using the attached outline
/latex-revise Shorten sections/intro.tex; preserve equations and citation keys
/latex-tune Fix the overflowing table on page 3 without changing its values
/latex-check Check cross-references and report findings without editing
/latex-help
```

The input hook expands the approved template (the digest-verified
`prompt:latex-<task>` resource) while preserving raw TeX, quotes, multiline
replacements and Unicode. Pi awaits the resulting agent turn, including in
`pi -p` and JSON mode, and retains its normal steering/follow-up behavior
during an active run. These shortcuts are not extension commands that dispatch
a fire-and-forget message. Empty shortcuts show usage; in an unbound session
they report `POLICY_DENIED` instead of reaching the model. `/latex` offers
host-command completion and help; `/latex revise` directs you to
`/latex-revise`. Command reports are Pi custom messages (`latex-workbench`),
including in RPC/JSON modes; they are not arbitrary JSON written into the
protocol's stdout stream.

Two further task prompts are discovered from `resources/prompts/` as ordinary
Pi prompt templates: `/repair` (diagnose and fix a build or layout problem
through the agent loop, loading `skill:latex-build-debug`) and `/release`
(prepare a formal release with host review and approval gates, loading
`skill:latex-release`). `base-system.md` is never a slash template — it is
injected every turn.

Host commands remain available as `/latex <operation>` and `/latex-<operation>`
(both spellings are registered for every operation below):

```
/latex doctor                                           doctor report
/latex init --template <id> --target <id>               approved-template init (empty project)
/latex build [--snapshot <id>] [--target <id>] [--preset <id>] [--clean]
                                                        build via the service (default: head, auto target)
/latex repair                                           repair workflow (diagnose→propose→approval gate→apply→check)
/latex review [--snapshot <id>]                         managed revise workflow (not read-only review)
/latex bib [--snapshot <id>]                            bibliography workflow
/latex figure [--snapshot <id>]                         data-assets workflow
/latex migrate [--snapshot <id>]                        managed template-migration workflow
/latex release [--snapshot <id>] [--target <id>] [--profile draft|review|submission] [--baseline <pdfId>]
                                                        release workflow (freeze→clean build→checks→page-review gate→
                                                        whitelist→approval gate→package→rebuild→finalize)
/latex status [jobId|workflowId]                        project/job/workflow status (no id: head, last 20 jobs, workflows)
/latex cancel <jobId> | --workflow <id>                 cancellation
/latex pending                                          patches waiting for your approval (+ protection mode)
/latex approve [patchId]                                grant one (default: the newest waiting patch)
/latex mode [strict|authoring]                          show/set the session protection mode
/latex pdf [pdfArtifactId] [--open]                     save a PDF under <state>/exports/<project>/ (builds the head if needed)
/latex sync [--snapshot <id>] [--takeover]              write sources back into the imported folder
/latex help                                             command catalog
```

These host commands accept structured flags, not prose. Parsing is closed:
missing flag values, duplicate flags, unknown flags and stray positionals fail
before any work starts, ids must match the workbench id grammar, and any
argument that looks like a host path, drive letter or URL is refused with
`POLICY_DENIED` — `/latex` never takes a filesystem location from the
keyboard. Use `/latex-check` for a read-only review and `/latex-revise` for
ordinary edits; the legacy `/latex-review` deliberately retains its
managed-workflow meaning.

`/latex pdf` without an id reuses the newest PDF of the head snapshot, or
builds the head first (a failed build returns `BUILD_FAILED` with the job
result); the file is named `<project>-<snapshot8>.pdf`, and `--open` hands it
to `open`/`xdg-open`/`explorer`. `/latex sync` needs a project imported from a
host folder (template-initialized projects have none — use `/latex pdf` or
`latexwb materialize --dir`).

In interactive sessions the footer shows a status line refreshed after every
turn, e.g. `LaTeX demo · head 4f5f2ebc · strict · compiled · 1 awaiting
approval (/latex pending)`.

Managed workflows persist operation/gate state and may stop at `waiting-input`
or `waiting-approval`. They are explicit host orchestration, not an automatic Pi
subagent dispatcher. Continue them through the host CLI's workflow commands
in [RUNBOOK](RUNBOOK.md). Everyday revision does not start one or consume its
single-run patch budget.

## Protected content, approvals and modes

Every proposal is analysed for protected content — math regions, citation
keys, labels, `\num/\SI` values, quotations/verbatim, commands that are
neither defined by the pinned toolchain nor used/defined in the project, and
template files. Each protected change is classified `added`, `modified` or
`removed`; the proposal's `PROTECTED_CHANGES` diagnostic states what `apply`
will do. Comments are not protected content, and re-emitting an unchanged
equation inside a rewritten sentence is not a math change (ADR-0007).

- **strict** (default): any protected change needs a host approval bound to
  the patch digest.
- **authoring**: a patch whose protected changes are *all additions* (new
  equations, labels, citations, numbers) applies directly with an
  auto-recorded grant attributed to the host principal; modifying or removing
  existing protected content still needs an approval. Enable it with
  `LATEXWB_PROTECTION=authoring` for a headless worker, `/latex mode
  authoring` in a session, or host-policy `protection.mode`.

The effective mode resolves as: operator override (`/latex mode`, the
dialog's authoring choice) → `LATEXWB_PROTECTION` → host-policy
`protection.mode` → `strict`. An unrecognized `LATEXWB_PROTECTION` value is
ignored with a warning and treated as `strict` — it can never widen
permissions. The mode and the list of waiting patches are part of the
binding the model sees each turn.

Files that are still byte-identical to an approved template (e.g. the
sample equations of a fresh `zh-article`) count as scaffolding: replacing
them is new content, not a modification.

Where approvals come from — never from the model:

1. **Interactive sessions (TUI / RPC with dialogs):** when the agent calls
   `apply` on a gated patch you are asked directly. The dialog shows the
   patch id, reason, files, a count of new vs modified/removed protected
   content per category and up to six examples (modifications first), then
   offers: approve this patch, approve and switch this session to authoring
   mode, show the diff (read-only), or deny. On approval the apply is retried
   in the same tool call. Dialog grants expire after 10 minutes.
2. **`/latex pending` + `/latex approve [patchId]`** inside the session
   (grant valid for 1 hour); then ask the agent to apply the patch.
3. **`latexwb approve --patch <id> --project <id>`** on the host (default
   1 hour, `--expires-in-seconds` to change) — the only channel in `pi -p`
   print mode besides authoring mode.

Every grant is an ordinary approval row bound to the patch digest and its
base snapshot, attributed to the host principal (`LATEXWB_PRINCIPAL`), and
consumed by exactly one apply. `grantedVia` records the channel: `pi-ui`,
`cli-host` or `host-authoring-mode`. `/latex mode` and the dialog's authoring
choice last for the session only; they never change host policy. Workflows
and the host CLI always apply strict semantics.

## Editing, follow-ups and delivery

1. Inspect the current head and choose the existing target. Read only the
   relevant included files, macros and nearby content. Reuse the project's class,
   language, bibliography backend and layout conventions.
2. Propose a minimal diff and apply it through `latex_patch`. Protected changes
   still require host grants; routine prose does not acquire a new approval gate.
3. Build the resulting snapshot. For layout edits, render the affected pages and
   adjacent flow. For suggestions/source-only requests, report omitted checks.
4. A follow-up starts from the latest head, not the original import. On a stale
   base, reread and re-propose the remaining change. Undo is an inverse proposal,
   subject to the same conflict/approval checks.
5. Return the draft PDF artifact, snapshot/target, changes and actual evidence.
   Formal packaging is a separate requested operation using the release skill.

**Source persistence:** edits live in immutable Workbench snapshots. They do not
write back into the directory originally imported. `latex_project snapshot`
re-imports that directory; use it only after an explicit external-source refresh
and reconciliation. It is not a save command. Pi `/tree`, fork and resume change
conversation history, not the project head. Concurrent agents sharing the same
project share this head; stale patches must be re-proposed.

For a local draft PDF use `/latex pdf --open` in the session (saved under
`<state>/exports/<project>/`), or on the host
`latexwb artifact save <pdfArtifactId> out.pdf --project <id> --state <state>`.
To write the edited sources back into the imported folder use `/latex sync`
(or `latexwb materialize --project <id> --dir <importDir>`): it is journaled,
and a file you edited on disk since the import is reported as a conflict,
never overwritten.
Source packaging remains the existing host-gated release operation. A draft
build does not claim submission readiness or human page review.

## Choosing a model

Any Pi provider works. With `-ne` (no extension discovery) provider
extensions are not auto-loaded, so load them explicitly next to the
workbench, e.g. the Command Code provider:

```bash
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo LATEXWB_PROTECTION=authoring \
  pi -p --no-session -ne \
  -e ~/.pi/agent/npm/node_modules/pi-commandcode-provider/index.ts \
  -e /absolute/path/to/pi-latex-workbench/packages/adapter-pi/extensions/workbench.ts \
  --model commandcode/deepseek/deepseek-v4-flash "…"
```

Text-only models receive rendered pages stripped by the Pi host; they fall
back to `latex_render text` and say the pages were not visually inspected.
Use a vision-capable model (e.g. `deepseek/deepseek-v4.1-flash`) for layout
review.

## Install and invoke as an agent

After the workspace install and toolchain provisioning, install the repository
root as one Pi package:

```bash
pi install /absolute/path/to/pi-latex-workbench
```

The root manifest loads only the workbench extension. Do not also install the
adapter subdirectory or load the same extension with `-e` in that session.
Without `LATEXWB_PROJECT`, installation leaves ordinary Pi tools, trust and
prompt behavior alone; LaTeX tools/intent commands explain the missing binding.
Do not set this variable globally for unrelated Pi sessions.

A parent agent can invoke a dedicated worker using the explicit extension path
instead of a permanent install:

```bash
LATEXWB_STATE=/absolute/path/to/state LATEXWB_PROJECT=paper \
  pi -p --no-session -ne \
  -e /absolute/path/to/pi-latex-workbench/packages/adapter-pi/extensions/workbench.ts \
  "Revise only the introduction. Preserve formulas and citations. Build a draft PDF."
```

Import once on the host before this call, or bind a new project ID and request
creation from an approved template. Use absolute state/extension paths when the
parent changes working directories. Repeated workers can use the same project
state for later revisions; prefer serial mutation of one project. Persistent Pi
sessions are optional for the conversation; the Workbench state stores source,
patches, jobs and approvals. An imported arbitrary document can be edited, but
only engines/backends supported by the provisioned runner can be compiled.

## Trust boundary

Enforced at `session_start` (verified live on pi 0.85.1 — the read-back in
`docs/ENVIRONMENT.md` and the canary transcript show exactly the eight
names — and on pi 0.87.0 alongside ~20 other installed Pi packages, run G in
[AGENT-WRITING-2026-09-24](acceptance/AGENT-WRITING-2026-09-24.md)). The
read-back line is printed to stderr on every bound start:
`latexwb: session_start active tools read-back: [...] (enforced)`.

- `setActiveTools([latex_*…])` removes bash/read/edit/write/grep/find/ls/
  powershell from the model-facing set; the handler **reads back**
  `getActiveTools()` and sets `boundaryBroken` → every tool call fails
  `POLICY_DENIED` if a future Pi version leaves host tools active.
- `tool_call` is defense in depth: anything outside the allowlist →
  `{block:true}`.
- `project_trust` answers `{trusted:"no"}` — the project cannot load local
  config/extensions.
- `resources_discover` advertises repository-owned skills and task prompts;
  `base-system.md` is excluded from slash templates and injected each turn from
  the digest-verified resource registry.
- `user_bash` returns a refusal `BashResult` (exitCode 126) — see caveat.
- For bound sessions the base prompt's coding-assistant identity is replaced
  with a LaTeX-workbench identity and Pi's documentation pointers are
  dropped (the model cannot read those files here); the static contract comes
  first and the per-turn binding (head, head build, protection mode, pending
  approvals) last, so provider prompt caches keep the prefix.
- **Unbound sessions** (no `LATEXWB_PROJECT`) register none of the handlers
  above: Pi keeps its normal tools, trust flow and prompts, and the eight
  tools answer `POLICY_DENIED` individually. A one-line notice goes to stderr.

## Honest limits of the boundary

- **The tool boundary is not a code sandbox.** `setActiveTools` shapes the
  *model-facing* tool set; extension code itself runs in the pi process. The
  `tool_call` gate closes the model-facing gap; a hostile extension on the
  same host is out of scope (Pi loads only the extensions the host
  registers).
- **`user_bash` is interactive-only.** The `!`-prefix hook cannot fire in
  `pi -p` print mode; its denial is unit-tested (exit 126) but has no
  print-mode transcript. Registered in the capability registry as
  `design-unverified`.
- **Approvals are local-operator auth, not real authentication.** `latexwb
  approve` resolves the principal from `--principal`/`$LATEXWB_PRINCIPAL`/
  `cli-operator`; whoever can invoke the CLI is the operator. The same holds
  for the in-session dialog and `/latex approve`: whoever sits at the TUI or
  drives the RPC client is the operator, and grants are attributed to
  `LATEXWB_PRINCIPAL`. A multi-user host must supply its own authenticated
  principal.
- **No project extensions / no bash** mean the model cannot run latexmk,
  edit files directly, or install packages — builds go exclusively through
  the provisioned tectonic preset.

Integration follows Pi 0.85.1's
[extension lifecycle and message APIs](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md)
and [on-demand skills](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/skills.md).

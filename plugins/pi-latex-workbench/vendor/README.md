# Pi LaTeX Workbench

**English** · [简体中文](README.zh-CN.md)

A controlled agent workbench for LaTeX projects. A model inside a Pi session
writes, revises, compiles and releases papers through eight governed
`latex_*` tools — every edit lands on a content-addressed snapshot,
sensitive changes stop at host-only approval gates, and a release ships only
after a digest-bound grant and a clean-room rebuild whose sha256 must match.

## Highlights

- **Write in plain language** — or via the prompt shortcuts `/latex-write`,
  `/latex-revise`, `/latex-tune`, `/latex-check`. Domain skills load on
  demand; a follow-up continues from the latest head snapshot, and a draft
  PDF never requires the formal release pipeline.
- **Controlled session** — the model can only reach the `latex_*` tools: no
  bash, no file tools, no project rebinding. Approvals come from the host —
  you in the session or the host CLI — never from the model.
- **Governed edits** — exact-text `replace` anchors (no byte counting),
  minimal-diff proposals, protected-content analysis that tells *new*
  equations/labels/citations apart from changes to existing ones, stale-head
  conflict detection, and an audit event for every action.
- **Approvals where you work** — an interactive session asks *you* before a
  protected edit applies (approve once, or switch the session to authoring
  mode so new content flows while edits to existing formulas still ask);
  `/latex pending` / `/latex approve` / `/latex mode`, or `latexwb approve`
  on the host. The model can never approve its own work.
- **Templates for real documents** — Chinese article/thesis (ctex, GB/T 7714),
  English article/report, beamer decks (English/Chinese), cover letter and
  exam; every template is digest-pinned and compiles offline.
- **Real builds** — a pinned, offline Tectonic toolchain; per-page PNG
  rendering for visual review; structured diagnostics tied to artifacts.
- **Managed workflows** — repair, revise, bibliography, data-assets,
  template-migration, and a gated release pipeline that ends in a
  deterministic package plus a clean-room rebuild verification.
- **Draft lint for everyday writing** — `latex_check` ruleset `draft`
  (the idea of chktex/Overleaf checks, run on the compiled draft): undefined
  references, duplicate labels, citations missing from the bibliography,
  floats without captions/labels, TODO/placeholder text, typography and
  build-log warnings, each with file:line. `/latex-check` starts from it.
- **Honest checks** — anything a machine cannot verify reports
  `needs-review`, never `pass`.

## Usage

The workbench has two surfaces: a **controlled Pi session** where the model
does the writing, and a **host CLI** — `node packages/cli/src/bin.ts`, or
`latexwb` when on your `PATH` — where you import projects, grant approvals,
and run checks and the release pipeline.

### 1. Install & provision the host (once)

Prerequisites: Node ≥ 24 (`node:sqlite` + TS type stripping), npm ≥ 10,
the `tectonic` binary on `PATH` (verified with 0.17.0, e.g.
`brew install tectonic` — provisioning downloads its bundle, not the
binary), macOS arm64 + Xcode CLT (`swiftc`) for the render helper, Pi ≥ 0.85
for the agent session (verified on 0.85.1 and 0.87.0), ~3 GB disk for the
tectonic bundle. No latexmk, Docker, or other TeX backends needed — tectonic
is the only engine.

```bash
git clone <repo> && cd pi-latex-workbench
npm install                                     # workspaces install; no compile step

node packages/cli/src/bin.ts provision-toolchain # pinned offline tectonic bundle (~2.9 GB)
node packages/cli/src/bin.ts provision-renderer  # Swift/PDFKit render helper, macOS arm64
node packages/cli/src/bin.ts doctor              # probe the host → DoctorReport JSON
```

A ready host reports `BUILD_READY` and exits 0; missing latexmk/Docker are
`info`, an unprovisioned renderer is a `warning`. Details and every doctor
code: [docs/INSTALL.md](docs/INSTALL.md).

Optionally put the CLI on your `PATH` — `cd packages/cli && npm link`
exposes `latexwb`; it is identical to `node packages/cli/src/bin.ts`.

### 2. Import a project

```bash
node packages/cli/src/bin.ts import path/to/my-paper --project demo
node packages/cli/src/bin.ts inspect --project demo
```

State defaults to `./.latexwb` (SQLite `workbench.db` + CAS `blobs/` + job
workdirs `jobs/`); pass `--state <dir>` to use another location. You can
also create a project inside the session later with
`/latex init --template <id> --target <id>` (approved templates only).

### 3. Install into Pi

**Permanent install** — register the repo as a Pi package once:

```bash
pi install /absolute/path/to/pi-latex-workbench
```

The root manifest loads only the workbench extension. **Unbound, it is
inert** — ordinary Pi sessions keep their normal tools and prompts; the
`latex_*` tools just explain that no project is bound. To make a session a
LaTeX worker, export the binding for that session (do not set it globally):

```bash
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo pi
```

**Per-session / worker invocation** — load the extension explicitly without
installing (this is also how a parent agent spawns a dedicated worker):

```bash
# interactive
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo \
  pi -e /absolute/path/to/pi-latex-workbench/packages/adapter-pi/extensions/workbench.ts

# one-shot / scripted
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo \
  pi -p --no-session -ne \
  -e /absolute/path/to/pi-latex-workbench/packages/adapter-pi/extensions/workbench.ts \
  "shorten the introduction and rebuild"
```

Binding is host-owned via environment variables — the model cannot rebind:

| Env var | Default | Meaning |
|---|---|---|
| `LATEXWB_STATE` | `./.latexwb` | workbench state dir (db + CAS + jobs) |
| `LATEXWB_PROJECT` | — | bound project id (**required** for tool calls) |
| `LATEXWB_WORKSPACE` | `local` | workspace scope |
| `LATEXWB_PRINCIPAL` | `pi-operator` | principal recorded on tool actions |
| `LATEXWB_SESSION` | `pi-<pid>` | session id in audit |
| `LATEXWB_POLICY` | `default` | policy id for approval lookup |
| `LATEXWB_PROTECTION` | host policy (`strict`) | `authoring` lets new protected content apply without a per-patch grant (headless workers); unknown values fall back to `strict` |
| `LATEXWB_REPO_ROOT` | derived from the extension path | repository root holding `resources/`, `runtime/`, `migrations/` |

**Choosing a model.** With `-ne`, provider extensions are not auto-loaded —
add them with `-e`, e.g. the Command Code provider for
`commandcode/deepseek/deepseek-v4-flash`:

```bash
LATEXWB_STATE=$PWD/.latexwb LATEXWB_PROJECT=demo LATEXWB_PROTECTION=authoring \
  pi -p --no-session -ne \
  -e ~/.pi/agent/npm/node_modules/pi-commandcode-provider/index.ts \
  -e /absolute/path/to/pi-latex-workbench/packages/adapter-pi/extensions/workbench.ts \
  --model commandcode/deepseek/deepseek-v4-flash "写一篇中文短论文并编译成 PDF"
```

### 4. Write with the agent

Inside the session, plain language works; prompt shortcuts expand an
approved task template:

| Shortcut | What it does |
|---|---|
| `/latex-write <brief>` | Draft or extend a document from a writing brief |
| `/latex-revise <request>` | Revise selected text, preserving unrelated content |
| `/latex-tune <request>` | Adjust typography, floats, spacing or a specific page |
| `/latex-check <request>` | Review source, compilation or layout without editing |
| `/latex-help` | Show the command catalog |

`/repair` and `/release` are also available as Pi prompt templates for the
build-debug and formal-release protocols. Each turn receives the current
binding, head snapshot, target ids and a skill catalog; skills load on demand
via `latex_project resource`. Edits go
through `latex_patch` as minimal diffs on immutable snapshots — a follow-up
continues from the latest head, never re-imports.

**New projects** start from an approved template (`latex_project init`); the
agent picks one by language and document type — `zh-article`, `zh-thesis`,
`article-basic`, `report-basic`, `beamer-basic`, `zh-beamer`, `letter-basic`,
`exam-basic`. Replacing a pristine template's sample content counts as
writing new content.

**Protected edits:** every proposal reports its protected changes (math,
labels, citations, reported numbers, quotations, unfamiliar commands) as
*new* or *modified/removed*. In the default **strict** mode any of them needs
a grant; in **authoring** mode new content applies directly and only changes
to existing protected content need one. Grants come from you:

- interactive session: a dialog appears when the agent applies a gated patch
  (approve once / approve + authoring mode / show diff / deny);
- in the session: `/latex pending`, `/latex approve [patchId]`,
  `/latex mode strict|authoring`;
- on the host: `node packages/cli/src/bin.ts approve --patch <patchId> --project demo`.

The model can never approve its own work; `/latex status` shows jobs and
workflows.

**Getting results out:** `/latex pdf --open` saves (and opens) the latest PDF
under `<state>/exports/<project>/`; `/latex sync` writes the edited sources
back into the imported folder through a journaled sync that refuses to
overwrite files you changed on disk since the import.

### 5. Build, render, check (host CLI)

```bash
node packages/cli/src/bin.ts build --project demo --target default
node packages/cli/src/bin.ts jobs --project demo

# lint the draft (references, labels, citations, floats, placeholders, typography, log)
node packages/cli/src/bin.ts check-run --project demo --artifact <pdfArtifactId> --ruleset draft

node packages/cli/src/bin.ts render-pages --project demo --artifact <pdfArtifactId> [--pages 1,3]
node packages/cli/src/bin.ts review-page --project demo --artifact <pageImageId> --verdict approved
node packages/cli/src/bin.ts check-run --project demo --artifact <pdfArtifactId> --ruleset release

# save a draft PDF locally
node packages/cli/src/bin.ts artifact-save <pdfArtifactId> out.pdf --project demo

# write the head back into the imported folder (journaled, conflict-safe)
node packages/cli/src/bin.ts materialize --project demo --dir path/to/my-paper
```

`build` exits 4 when the document does not compile (the JobResult with its
diagnostics is still printed); errors print a JSON `ToolError` on stderr with
exit 3.

### 6. Release a formal package

```bash
node packages/cli/src/bin.ts release-freeze --project demo --snapshot <snap> --target default --profile submission
# prints an approvalDigest; bind the host grant to it:
node packages/cli/src/bin.ts approve --project demo --action release.package \
    --digest <approvalDigest> --snapshot <snap>
node packages/cli/src/bin.ts release-package --project demo --release <releaseId> --artifact <pdfArtifactId>
node packages/cli/src/bin.ts release-status <releaseId> --project demo
```

`release-package` needs a page-review verdict for every rendered page
(`requireAllReleasePagesReviewed`) and the digest-bound grant; otherwise it
finalizes `blocked` and names each failing gate. `submission-ready` means the
checks are clean, the pages are reviewed, and the staged PDF was rebuilt in a
clean room with an identical sha256.

### 7. Managed workflows

`/latex repair|review|bib|figure|migrate|release` inside a session — or
`workflow-start <definitionId>` on the host — start persisted workflows that
may pause at `waiting-input` (an `agent.*` step waits for you to supply a
`{"patchId": …}` based on the current head) or `waiting-approval` (grant, then
resume). `revise` and `template-migration` end in a comparison step that is
not implemented yet, so they finish `blocked` honestly:

```bash
node packages/cli/src/bin.ts workflow-list --project demo
node packages/cli/src/bin.ts workflow-status <workflowId>
node packages/cli/src/bin.ts workflow-resume <workflowId> --input answer.json --project demo
node packages/cli/src/bin.ts workflow-cancel <workflowId>
```

Flat command spellings are preferred; nested forms (`release freeze`,
`check run`, `workflow start`, …) remain compatible. Full reference:
[docs/RUNBOOK.md](docs/RUNBOOK.md); session binding, env vars and the trust
boundary: [docs/PI-SESSION.md](docs/PI-SESSION.md).

## Documentation

| Document | Read it for |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | prerequisites, provisioning, reading the doctor report |
| [docs/PI-SESSION.md](docs/PI-SESSION.md) | the agent session: binding, the eight tools, `/latex` commands, protection modes and approvals, trust boundary |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | every host CLI command and flag, patch/context file formats, host policy, state layout, backup, recovery, troubleshooting |
| [docs/UNSUPPORTED.md](docs/UNSUPPORTED.md) | what is not implemented and the limits of what is |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | the 100-item acceptance matrix and how to re-verify it |
| [docs/EVAL.md](docs/EVAL.md) | the real-agent canary and recorded live runs |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | recorded probe outputs of the development host |
| [docs/adr/](docs/adr/) | design decisions ADR-0001…0007 |
| [fixtures/README.md](fixtures/README.md) | sample and acceptance fixtures |

## Recorded agent runs (`results/`)

Real end-to-end sessions, transcripts and deliverables included:

- `results/pi-live-20260923T001330/` — 13-transcript vision-capable run
  (deepseek-v4.1-flash): repair a broken fixture through the approval gate,
  figure/bibliography/boundary/revise flows, to `submission-ready` with a
  sha256-identical clean-room rebuild. The model described the rendered
  page from the actual PNG block.
- `results/pi-papers-20260922T114056/` — three complete papers authored
  from one-line prompts (`prompt-*.txt` are verbatim): a 7 pp analysis
  paper, a 10 pp systems paper with TikZ + algorithm2e + booktabs, and a
  15 pp survey with 37 references. Two released end-to-end; one `blocked`
  honestly at host gates.
- `results/pi-deepseek-20260922T110918/` — repair on the broken mathematics
  fixture (deepseek-v4.1-flash, text-only), `POLICY_DENIED` → host grant →
  apply → compile → `submission-ready`.

Notable honest-behavior evidence across the runs: the model refused to
clobber a concurrently-applied patch, reported a `POLICY_DENIED` verbatim
without bypass attempts, declined to "fix" a table value it could not prove
wrong, and — when text-only — stated that rendered pages were stripped
instead of hallucinating a view.

The ADR-0007 writing round (Chinese paper from an empty project, table fix,
slides, in-session approval dialog) is measured in
[docs/acceptance/AGENT-WRITING-2026-09-24.md](docs/acceptance/AGENT-WRITING-2026-09-24.md);
its JSONL transcripts were kept out of the repository.

To reproduce: seed a directory with a minimal `main.tex`, `import` it (or
`init` from a template in the session), then launch a bound session and ask in
plain language. Protected edits need a grant (or authoring mode for
additions); packaging needs page reviews + the digest-bound `release.package`
grant. The canary procedure is in [docs/EVAL.md](docs/EVAL.md).

## Repository layout

```
packages/contracts/    @latexwb/contracts — schemas, generated types, validators, errors
packages/storage/      @latexwb/storage — SQLite, migrations, outbox, CAS
packages/core/         @latexwb/core — services: import/snapshot/build/patch/approvals/
                       workflows/bibliography/assets/checks/render/review/release/inspect
packages/runtime/      @latexwb/runtime — tectonic + docker runners, toolchain provisioning,
                       Swift/PDFKit render helper, doctor probes
packages/adapter-pi/   @latexwb/adapter-pi — Pi extension: 8 latex_* tools, prompt
                       shortcuts, /latex host commands, operator approval dialog,
                       per-turn agent context, session boundary
packages/cli/          @latexwb/cli — latexwb host CLI (flat + nested commands)
resources/             skills/ (8, digest-pinned), prompts/, workflows/ (7 definitions +
                       operation registry), templates/ (8 approved), recipes/,
                       bibliography/, profiles/{domains,outputs,venues} + capability,
                       check, resource and source registries
runtime/               host-policy.json, toolchain-lock.json, presets/; provisioned
                       toolchain/ and render/ (gitignored)
migrations/            SQLite migrations 0001–0004
fixtures/              seed projects, 30 domain fixtures (index.json), exam-marks
docs/                  INSTALL, RUNBOOK, PI-SESSION, EVAL, UNSUPPORTED, ACCEPTANCE,
                       ENVIRONMENT, adr/ (ADR-0001…0007), acceptance/ (results + live runs)
results/               recorded real-agent sessions (transcripts + deliverables)
scripts/               generate-types.py (schema → types), generate-known-commands.py
                       (bundle → command vocabulary), pi-canary.sh, acceptance-dom.mjs
```

The authoritative design inputs live read-only under
`design/pi-latex-workbench-v2/` (handoff copy — do not edit; change the
in-repo schemas under `packages/contracts/schemas/` via the ADR process).

## Status

M0–M5 implemented and exercised by real tests, plus two agent-usability
rounds: byte offsets and readable diffs (ADR-0006) and the authoring surface
(ADR-0007 — anchored edits, protection modes, operator approvals, templates,
draft lint, diagnostics attribution). The 100-item acceptance matrix
([docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)) stands at **97 pass / 3 partial /
0 fail**. At commit `1ddf4dd` (2026-09-25): `npm test` 333 tests — 332 pass,
1 honest docker skip; `npm run test:contracts` 37 pass; the 13-fixture DOM
sweep 13/13. Live agent runs with `deepseek-v4-flash`:
[docs/acceptance/AGENT-WRITING-2026-09-24.md](docs/acceptance/AGENT-WRITING-2026-09-24.md).

Known limits are load-bearing — see [docs/UNSUPPORTED.md](docs/UNSUPPORTED.md)
and `resources/profiles/capability-registry.json`: no Docker runner on this
host, rendering is macOS-arm64-only, `answer-mapping` is the one unsupported
release check, local-runner cpu/memory limits are unenforced, and no check
claims scientific correctness — conformance is not truth.

## Development

```bash
npm install              # workspaces install; there is no compile step
npm run typecheck        # tsc --noEmit over all packages
npm test                 # node --test across packages
npm run test:contracts   # contracts package tests only
npm run contracts:types  # regenerate types.generated.ts from schema (python3)
npm run doctor           # latexwb doctor → DoctorReport JSON
python3 scripts/generate-known-commands.py   # regenerate the known-command vocabulary
                                             # from the provisioned bundle
```

CI (`.github/workflows/ci.yml`, Node 26 on ubuntu) runs `npm ci`, the
typecheck, a check that `types.generated.ts` is in sync with the schemas, and
`npm test`. Most suites that need the provisioned bundle, the render helper
or Docker skip with a reason when those are absent.

ESM-only, TypeScript strict (`erasableSyntaxOnly`, `verbatimModuleSyntax`),
no build step — packages consume `.ts` source via `exports`; import
specifiers carry explicit `.ts` suffixes (ADR-0002). Every
specified-but-unimplemented surface throws a coded `NotImplementedError`
registered in `docs/UNSUPPORTED.md`. Agent evaluation canary:
[docs/EVAL.md](docs/EVAL.md) + `scripts/pi-canary.sh`.

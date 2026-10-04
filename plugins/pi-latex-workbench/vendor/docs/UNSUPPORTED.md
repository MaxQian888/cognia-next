# UNSUPPORTED — what is not implemented, and the limits of what is

This is the honest ledger of the implementation. A specified surface that is
not implemented throws `NotImplementedError` (code `NOT_IMPLEMENTED`), drives
a workflow to `blocked`, reports `unsupported`/`needs-review`, or is simply
absent — never a stub returning fake data, fixed passes, or empty objects.
Implemented surfaces are listed with the boundaries they do *not* cover.
Section headings name the milestone that introduced each surface; the
machine-readable counterpart is `resources/profiles/capability-registry.json`
(statuses `verified`, `design-unverified`, `environment-blocked`,
`unsupported`).

Currently not implemented at all: the `answer-mapping` release check, the
`quality.compare-baseline` and `quality.compare-and-venue` workflow ops, the
HTTP/SSE adapter and CLI `serve`/`edit`, `job_events` repository methods,
biber and non-XeTeX engines on the local runner, cpu/memory/pids limits on
the local runner, a model runner inside the workflow engine, SyncTeX
exposure, and real (multi-user) authentication.

## Application service / tools (M2–M4)

The eight `latex_*` tools are registered by `extensions/workbench.ts` since
M2-C. Live: `latex_project` (inspect, snapshot, read, search,
artifact-read, doctor, **init** — approved digest-verified templates only,
and **resource** — digest-verified registry entries), `latex_patch`
(propose/apply/revert with `replace` exact-text anchors, byte-range `edit`,
`create`, `delete`, `attach-asset` — **no `approve` action; grants are
host-only**: the operator's in-session dialog or `/latex approve`,
`latexwb approve`, or host authoring mode for additions — ADR-0007),
`latex_build` (run/status/cancel), `latex_bib` (lookup/audit/
propose-import), `latex_figure` (table/plot/diagram via the trusted recipe
registry + real Tectonic compile), `latex_check` (run/report for the
`draft` lint, `data-assets` and `release` rulesets — `draft` findings are
source/log heuristics and gate nothing). Every call returns a schema-validated
`ToolEnvelope`, and each action runs under a per-action capability
context (`requestContextFor`) — e.g. only bib lookup/resolve carries
`metadata.lookup`, only figure/check carry `data.render`.

- `latex_render` (pages/text) is live (M4): rasterization runs the
  provisioned Swift/PDFKit render helper pinned in
  `runtime/render/manifest.json`; `latexwb provision-renderer` (re)builds
  and pins it. `pages` also attaches the rendered PNG bytes as real Pi
  image content blocks (page order = `data.pages`), capped at 8 MiB total;
  pages past the cap are listed in `imagesTruncated` — the model receives
  actual images, not just artifact ids (PI-03). `latex_export`
  (prepare/package) is live through the real
  release service: prepare emits a persisted `ReleasePlan` manifest;
  package runs gates → digest-bound approval → deterministic whitelist zip
  → clean-room rebuild → honest finalize (blocked/review-ready/
  submission-ready — never "released" on compilation alone).
- `latex_bib` `lookup` is policy-gated: the project .bib corpus is always
  searched; crossref runs only because `runtime/host-policy.json` lists
  `"crossref"` under `network.metadataProviders` — remove it and lookups
  degrade to a recorded policy-denied evidence entry, never silent.
  `propose-import` with no admissible candidates returns `data: null` plus
  an explicit `NO_CANDIDATES` diagnostic, not a fabricated patch.
- `latex_figure` compile proof is honest per outcome: `compiled` only when
  the standalone .tex really compiled; `failed`/`skipped-runner-unavailable`
  are reported as diagnostics while the .tex/mapping artifacts still ship.
- `latex_check` machine-unverifiable items (e.g. `layout.visual-review`)
  report `needs-review`, never `pass`. The `release` ruleset (M4) is
  registry-driven: every check id in the ruleset must appear in
  `resources/profiles/check-registry.json` — drift is a hard
  `INVALID_REQUEST`; `live` entries without code (or coded checks marked
  non-live) are hard errors; non-live entries report `unsupported` with
  the registry's reason and block the release when the output profile
  requires them. Currently unsupported release checks: `answer-mapping`
  only (teacher↔student question correspondence is not modeled).
  `answer-isolation` (de-commented source scan for `\printanswers`/
  solution environments/answer keys + extracted-PDF-text scan for
  answer/solution labels), `asset-provenance` (CAS-hash round-trip +
  generated-asset record verification — license attestation is still not
  modeled), and `score-sum` (mark annotations vs declared totals) are
  live. Unknown ruleset ids are `INVALID_REQUEST`, not an empty report.
- Every string leaving a `latex_*` tool is sanitized before
  serialization (SECURITY-11): ANSI OSC/CSI/ESC sequences are stripped
  and residual C0/C1 controls become a visible U+FFFD — diagnostics or
  file payloads cannot inject terminal escapes or OSC-8 hyperlinks into
  the host transcript.
- Semantic validation beyond JSON Schema (API_CONTRACT §8): unique target
  ids, cross-scope reference checks, render page bounds, diagram node/edge
  existence, execution-state/result coherence. (Patch-layer checks —
  UTF-8 boundary + overlap on edits, expectedSha256 vs base, per-patch
  limits — are implemented in `core/patch.ts`.)
- `/latex` subcommands `init` (approved templates via `--template`/
  `--target`), `bib` (→ `bibliography` workflow), `figure` (→ `data-assets`),
  `migrate` (→ `template-migration`), `review` (→ `revise`), `doctor`,
  `build`, `repair`, `status`, `cancel`, and `release` (→ the `release`
  workflow: freeze → clean build → release checks → page-review gate →
  whitelist prepare → digest-bound approval gate → package → clean-room
  rebuild → finalize) route to committed services. `release` pauses at
  `waiting-approval` for human review and the host grant. `review` honestly
  `block`s at its final `compare` node (`quality.compare-baseline`).
  `migrate` first runs the live `venue.verify-current` step (which fails
  the workflow when the target declares no `venueProfileId` — there is
  nothing to verify) and, when that passes, `block`s at its final `check`
  node (`quality.compare-and-venue`). Both reach their unsupported node only
  after the patch has been applied and built, and never fake the
  comparison. Operator
  commands `pending`, `approve`, `mode`, `pdf` and `sync` (ADR-0007) act
  only on host-owned state and are never reachable by the model.
- **Approval host-auth boundary**: `latexwb approve`, the Pi operator
  dialog and `/latex approve` are the local host entry points; the principal
  is resolved from `--principal` / `$LATEXWB_PRINCIPAL` / `cli-operator` (CLI)
  or the session's `LATEXWB_PRINCIPAL` (Pi) — whoever controls that terminal
  or RPC client is the operator. Authoring mode (`LATEXWB_PROTECTION`,
  host-policy `protection.mode`, `/latex mode`) pre-authorizes *additions*
  only and records a patch-bound grant per apply; it never covers changes to
  existing protected content. There is no real authentication layer yet; a multi-user host
  (HTTP adapter, pi sessions) must supply its own authenticated principal
  before this boundary means anything beyond "the local operator".

## Pi controlled session (M2-C)

`session_start` calls `setActiveTools` with exactly the eight `latex_*`
names and **reads back `getActiveTools()`**: on Pi 0.85.1 this verifiably
removes bash/read/edit/write/grep/find/powershell (evidence in
docs/ENVIRONMENT.md — the read-back listed only the eight names). If a
future Pi version leaves host tools active, the handler sets
`boundaryBroken` and every tool call fails closed with `POLICY_DENIED`
rather than running inside a broken sandbox. `tool_call` is defense in
depth (`{block:true}` outside the allowlist), `project_trust` answers
`{trusted:"no"}`, `resources_discover` advertises only repository-owned
`resources/skills/*` and the task prompts in `resources/prompts/` (never
`base-system.md`, which is injected per turn from the digest-verified
registry), and `user_bash` returns a refusal `BashResult` (exitCode 126).
The same enforcement was re-observed on Pi 0.87.0 (2026-09-24) in
installed-package mode next to the user's other Pi packages.

Limits of what Pi 0.85.1 lets an extension enforce:

- `user_bash` is an interactive `!`-prefix hook only — it cannot be
  exercised in `pi -p` print mode; its return value is unit-tested but
  there is no print-mode transcript for it.
- `setActiveTools` shapes the model-facing tool set; it does not sandbox
  extension code itself. The `tool_call` gate closes the model-facing gap;
  a hostile *extension* on the same host is out of scope (Pi loads only
  the extensions the host registers).

## Storage repositories (M2+)

`evidence` now has repository methods (`insertEvidence`/`getEvidence`/
`listEvidence`) used by the M3 services; every row is hash-bound to its
content. M4 added `checks` (persisted per-run check rows),
`reviews` (page-review verdicts, latest-wins by insertion order), and
`releases` (draft → terminal status rows) repositories.
Table still lacking repository methods: `job_events`.
(`approvals`, `workflows`, `workflow_steps` — extended by
`0004_workflow_step_ops.sql` — and `materialization_journals` — extended by
`0002_journal_terminal_states.sql` — are implemented for the M2
patch/approval/materialize/budget/workflow surface.)
Add them with the consuming milestone; all queries must stay
(workspace, project)-scoped.

## Runtime / execution (M1 done; residual)

- **Biber**: tectonic's `--only-cached` bundle path has no biber backend.
  `bibliographyMode: "biber"` is rejected with `ENGINE_MISMATCH` /
  dependency-blocked — never silently substituted. Presets declaring biber
  fail validation until a biber-capable runner (docker-texlive) exists.
- **pdflatex/lualatex via local-tectonic**: tectonic is XeTeX-family only;
  other engines are refused with `ENGINE_MISMATCH` rather than emulated.
- **Container isolation**: docker-texlive-latexmk is implemented but
  unavailable on hosts without a Docker daemon; probe reports the real
  reason. Its integration test records `not-run` + reason instead of
  passing.
- **Build clock**: `SOURCE_DATE_EPOCH` is the creation time of the earliest
  snapshot with the same tree hash, not 0 — `\today` shows when that
  content first existed, and identical content still rebuilds
  byte-identically (the release clean-room rebuild uses the staged PDF's
  snapshot clock). A document that needs "the real current date" must write
  it out.
- **Resource limits on local runner**: `enforces` reports `cpu/memory/pids/
  diskQuota: false` honestly — only wallClock (timeout + process-tree kill)
  and output caps are real on the unisolated path.
- **PDF page count / rasterization**: live since M4 via the provisioned
  Swift/PDFKit render helper (`runtime/render/manifest.json` pins the
  helper sha256); `renderPages`/`renderText` produce real page-image and
  text artifacts through durable service jobs. Poppler/mutool are not
  used; the helper is macOS-only (darwin/arm64) today.
- **`.fls` recorder manifests**: tectonic emits `deps.mk` (makefile rules
  with real input dependencies), which is parsed into the dependency
  manifest — kpsewhich `.fls` specifically is not produced by this runner.
- **Host-file reads by TeX**: `--untrusted`/`--only-cached` do NOT stop
  absolute-path `\input` (verified: tectonic 0.17 opened `/etc/passwd`).
  Enforcement is therefore *detective*: the deps ledger is audited after
  every run, and any recorded read outside the job dirs + runner-declared
  roots (`dependencyReadRoots`) quarantines the pdf — the blob stays in
  CAS as evidence but no artifact row is published and the build is
  `compile-failed` with `SECURITY_BOUNDARY`. A pdf without a ledger fails
  closed the same way. Container-isolated runners return `null` (the
  kernel boundary applies instead). Residual gap: a host file whose bytes
  surface inside the *log* before the pdf gate could still leak a line of
  context — the audit removes the artifact channel, not log echo.

## Workflow controller (M2 engine live; most operations M3+)

The engine exists (`core/workflow-defs.ts` + `core/operations.ts` +
`core/workflow.ts`): definitions load only from `resources/workflows/*.json`,
are schema- and semantically validated, hash-pinned into CAS at start;
steps persist with inputDigests and completed runs are reused on re-drive;
waiting-* states stop without a worker lease; `workflow start|status|
resume|cancel|list` are wired in the CLI.

**Live operations** (in `resources/workflows/operation-registry.json`):

- `project.inspect`, `project.init-approved` (approved template registry,
  digest-verified copies only), `build.run-await`, `build.clean-await`,
  `patch.apply-current` (incl. the verified no-change path),
  `gate.patch-approval`, `guard.repair-budget`, `baseline.capture`,
  `quality.review-draft` (machine-check portion only — it reports open
  diagnostics/protected changes and always lists `visual-page-review` as
  not performed; it never claims a document is clean).
- `bibliography.audit`, `bibliography.resolve-approved`,
  `bibliography.propose-import`, `bibliography.report` — real BibTeX
  parsing, policy-gated provider lookups with persisted evidence, and a
  verified no-change path when nothing is admissible to import.
- `assets.inspect-source` (real CSV/TSV column analysis + evidence),
  `assets.generate-approved` (trusted recipe registry + real Tectonic
  compile + numeric-mapping artifacts),
  `assets.check-mapping-and-layout` (`data-assets` CheckReport:
  fidelity/coverage recompute, compile-proof verification;
  `layout.visual-review` is `needs-review`, never auto-passed).
- `agent.propose-minimal-repair`, `agent.propose-revision`,
  `agent.propose-asset-insertion`, `agent.propose-migration`,
  `agent.plan-document` — as a controlled seam, not a model call: each
  yields `waiting-input` with a typed request; the host answers via
  `workflow resume`. There is no model runner yet.

**Live since M4**: `release.freeze`, `quality.run-release-checks`,
`gate.all-page-review`, `release.prepare-whitelist`,
`gate.release-approval`, `release.package-staging`,
`release.rebuild-package`, `release.finalize` — the full release pipeline
wired into `resources/workflows/release.json`.

**Registered but unsupported**: `quality.compare-baseline` (the
`baseline-compare` release CHECK is live; this workflow op's
affected-page diffing is not implemented) and
`quality.compare-and-venue` (a combined compare+venue op is not
implemented — the underlying `venue.verify-current` IS live: pinned-HTTPS
re-fetch of every `sources[]` URL in the target's venue profile, sha256
compare against the recorded `contentHash`, `venue-source` evidence rows,
policy-gated by `network.venueVerification`).
Each carries a concrete `unsupportedReason` in the registry; executing one
throws `NOT_IMPLEMENTED` and drives the workflow to `blocked` — never a
silent success.

## Quality / release (M4 — implemented)

- The release check engine runs the `release` ruleset live:
  `build-current`, `references-resolved`, `required-sections`,
  `assets-present`, `protected-content`, `text-extraction`,
  `page-dimensions`, `font-coverage`, `anonymization-scan`,
  `visual-coverage`, `venue-profile`, `baseline-compare` — persisted check
  rows + a durable `check-report` artifact per run.
- Page-image review is a real host channel: `submitPageReview` requires
  `human.review`, binds the verdict to the page artifact's bytes as
  evidence, and takes the reviewer identity from the request context —
  never from tool parameters. `requireAllReleasePagesReviewed` in the host
  policy makes unreviewed pages a blocking gate.
- Release packaging is deterministic: whitelist = snapshot files minus
  deny-listed generated/hidden/secret paths; the source zip is byte-
  reproducible (sorted entries, fixed timestamps); the clean-room rebuild
  extracts ONLY the staged zip into a scratch dir (path-traversal
  guarded), runs the approved preset with `SOURCE_DATE_EPOCH` pinned, and
  sha256-compares the rebuilt PDF.
- Release status is honest: `blocked` names every failing gate;
  `review-ready`/`submission-ready` require checks clean + review coverage
  + usable digest-bound approval + staged package + verified rebuild.
- Still unsupported release checks (registry-declared, blocking when a
  profile requires them): `answer-mapping` only — teacher↔student
  question-numbering/marks correspondence needs a document model we do
  not have. `answer-isolation`, `asset-provenance`, and `score-sum` are
  live (convention-based, documented in check-registry.json); an exam
  source using other mark conventions reports `needs-review`, never an
  invented sum.
- `venue-profile` (M5) additionally enforces source freshness: a
  non-internal profile with missing `checkedAt`, `status: "expired"`, or a
  past `validUntil` can never silently `pass` — it reports `fail` (when it
  carries error-severity requirements) or `needs-review`, with a
  `staleness:` finding naming the field. Internal scaffold profiles
  (`template.origin: "internal"`) are exempt by design.

## M5 — domains & product finish

- **Domain profiles remain `design-unverified`.** The 30 fixtures under
  `fixtures/domains/` (indexed by `fixtures/index.json`) exercise the real
  import/build/diagnostic/patch pipeline against domain-shaped input; there
  is NO domain-rule engine — rule entries with `checkImplementation: null`
  are advisory and surface as `needs-review` in any honest runner.
- **Venue profiles are sourced, not authoritative.** Six real profiles
  (`resources/profiles/venues/`) carry fetched source URLs + sha256 content
  hashes + `checkedAt`/`validUntil`. They encode what the cited pages said
  at fetch time — the freshness rule above is what keeps a stale copy from
  passing silently. `neurips-2025` and `icml-2025` are intentionally already
  expired on this host's clock and now evaluate to `fail`.
- **Venue verification is a source-hash check, not authority**:
  `venue.verify-current` is live (re-fetch + sha256 compare of the
  profile's declared `sources[]`, evidence persisted); it answers "did
  the cited page change", not "are the rules right".
  `quality.compare-and-venue`, `quality.compare-baseline` remain
  `NOT_IMPLEMENTED` workflow ops (blocked, not faked).
- **`resources/profiles/capability-registry.json`** is the honest
  capability ledger — verified/design-unverified/unsupported/
  environment-blocked with evidence + reason per surface.
- **Real-agent evaluation is a canary** (`scripts/pi-canary.sh`,
  `docs/EVAL.md`), not a gate: transcripts are recorded, not asserted.
- **No correctness claims**: nothing in checks, fixtures, or venue/domain
  profiles asserts scientific or mathematical truth — compilation and
  convention-conformance are the ceiling.

## Authoring surface (ADR-0007) — honest limits

- **Protection modes are a Pi-session setting.** `authoring` (via
  `LATEXWB_PROTECTION`, host-policy `protection.mode` or `/latex mode`)
  pre-authorizes only patches whose protected changes are *all* additions.
  `latexwb patch-apply` and managed workflows always use strict semantics.
  Historical patch rows without a `change` classification stay strict.
- **Change classification is lexical, not semantic.** The analyzer masks
  comments, compares math regions byte-for-byte and matches labels,
  citation keys, numeric anchors and literal blocks by content; it does not
  understand what an equation *means*. A whitespace-only edit inside an
  existing math region still counts as `modified`. The known-command
  vocabulary is generated from the pinned bundle's kernel and ~130 common
  class/package files plus every command already used in the base snapshot;
  a command from any other package is flagged as unfamiliar until the
  project uses or defines it.
- **The operator dialog needs a UI.** It appears in the interactive TUI and
  in RPC hosts that answer extension dialogs. `pi -p` / JSON mode has no UI,
  so a gated apply stays `POLICY_DENIED` and `latexwb approve` (or authoring
  mode) is the channel. The dialog was exercised through Pi's RPC dialog
  protocol with a scripted operator, not by a human at the TUI.
- **Draft lint is heuristic.** `latex_check` ruleset `draft` scans
  comment-masked sources reachable from the target root plus the producing
  build's stored diagnostics. `draft.typography` covers Latin prose only (CJK
  never matches) and lists at most 40 findings; `draft.references` degrades
  to `needs-review` when `xr` `\externaldocument` is loaded;
  `draft.build-log` reports `unsupported` when the build stored no result.
  It gates nothing.
- **Diagnostic page numbers are estimates.** File and line attribution come
  from TeX's file stack and `l.<n>`/`on input line` anchors (unknown values
  stay `null`); page numbers derived from shipped-page tracking carry
  `confidence: "heuristic"`.
- **Templates are generic.** The eight approved templates (`article-basic`,
  `report-basic`, `zh-article`, `zh-thesis`, `beamer-basic`, `zh-beamer`,
  `letter-basic`, `exam-basic`) compile offline with the pinned bundle; none
  is an institution's or venue's official format.
- **Fake-IP DNS admission is narrow.** `network.fakeIpCidrs` accepts only
  sub-ranges of `198.18.0.0/15`; private, loopback and link-local answers
  are always refused (`allowPrivateAddresses` is schema-`const false`).
- **Live evaluation is small.** The writing round used one text-only model
  (`deepseek-v4-flash`) and one vision run (`deepseek-v4.1-flash`) on a
  handful of prompts ([AGENT-WRITING-2026-09-24](acceptance/AGENT-WRITING-2026-09-24.md));
  prompt guidance does not guarantee another model's behavior.

## Interfaces (M2+)

- HTTP adapter (API_CONTRACT §6.3), SSE event stream endpoint,
  `cursor-expired` handling, authenticated approvals/review endpoints.
- CLI subcommands `serve`, `edit` are absent — `latexwb <cmd>` exits 3
  with `NOT_IMPLEMENTED`. `check`, `export`, `render`, `review`,
  `release`, `provision-renderer` are live since M4, and every nested
  operation also has a flat spelling (`release-package`, `check-run`, …) —
  full reference in [RUNBOOK.md](RUNBOOK.md#command-reference).
- A standalone host UI (beyond Pi's TUI/RPC dialogs and footer status) and
  SyncTeX mapping (synctex is produced in job output dirs but not yet
  exposed through a tool surface).

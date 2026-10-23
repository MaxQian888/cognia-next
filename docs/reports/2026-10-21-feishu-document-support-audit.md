# Feishu document support audit

Date: 2026-10-21. Scope: checked-out Cognia source and installed `lark-cli 1.0.83` on macOS. This is an implementation and local-contract audit, not real-account acceptance.

Evidence ledger: [2026-10-21-feishu-document-support-audit.md](../evidence/2026-10-21-feishu-document-support-audit.md).

## Repair follow-up (2026-10-21)

The four initial findings below are now repaired in the working tree. The original audit is retained as before-state evidence; its negative cache probe describes that historical state, not a current verification command.

| Finding | Repair                                                                                                                                                                                                                    | Regression evidence                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| F1      | Search retains the provider's original document type in `RemoteDocRef.sourceType`; the provider passes it to the shared fetcher/parser for opaque bare ids. Existing URL and recognized-prefix behavior stays compatible. | Real search → provider → fetcher tests for opaque doc/docx ids; parser rejects untyped arbitrary strings, malformed input and sheets. |
| F2      | CLI ingestion sends `--doc` and explicit `--doc-format markdown`; normalization reads `data.document.content` / `document.content` and never imports unknown JSON as document text.                                       | Exact argv, nested-envelope and empty/unknown-body tests; generated ingestion argv accepted by installed CLI dry run.                 |
| F3      | Edit schemas support explicit body format, empty replacement deletion, content-free block deletion, operation-specific required anchors, revisions, range bounds and block move/copy.                                     | Positive/negative schema cases, exact argv and installed-CLI dry runs.                                                                |
| F4      | Anchored image upload resolves the target first, appends the media, then moves only the returned new block id. Move failure removes only that new block; missing id or failed cleanup reports uncertain state explicitly. | Lookup/upload/move/cleanup failure injection, exact affected block ids, and generated multi-step CLI dry runs.                        |

An additional contract failure was discovered during verification: the CLI rejects `--yes` on ordinary document reads, edits and media commands. These commands now rely on the existing Cognia dispatcher approval and omit that flag; only high-risk document deletion forwards explicit approval as CLI `--yes`. Tests cover approved/unapproved deletion and all generated document commands.

No new product module was needed: the existing shared fetcher, parser, provider reference and document skill family were extended. A patch changeset was added. No live document was read or modified.

### Current verification

- Before implementation: **4 suites failed, 27 failed and 94 passed tests** in `.cache/feishu-document-audit/red-tests.log`.
- After implementation: **51 suites passed, 670 tests passed**, no skipped tests, via the repository `pnpm test --runInBand` entry point. Includes the full Lark family, provider subsystem, auth/manifest/dispatcher boundaries, source staging, chat citation/attachment hooks and existing UI tests. Command and output are in `.cache/feishu-document-audit/final-tests.log`.
- Actual installed `lark-cli 1.0.83` accepted generated ingestion, range/section/keyword reads, Markdown/revision/empty-replacement edits, block deletion/move/copy, high-risk deletion confirmation and image append/move commands with `--dry-run`. These calls did not execute provider requests. Document tests are at `lib/skills/built-in/lark/doc.test.ts`.
- `pnpm lint`: exit 0. A final explicit-path ESLint run over all 12 changed source/test files also exited 0 (`final-eslint.log`).
- `pnpm lint:i18n`: exit 0; key parity and referenced keys passed.
- `pnpm audit:colocated-tests`: exit 0; no new gaps. No baseline was rewritten.
- Preflight `test-gap-auditor` and `pii-gate-auditor`: no blocking findings. The token precedence question was resolved by documenting compatibility behavior; outbound redaction and dispatcher approval paths remain in place.
- `pnpm typecheck`: **exit 2**, including a rerun after final implementation. Diagnostics name only files outside this task: `lib/claude/build-options.ts`, `lib/plugin/agent-sdk/dispatch.test.ts`, `packages/agent-codex/src/app-server-client.ts`, and `scripts/smoke/builtin-agent-budget-live.ts`. See `.cache/feishu-document-audit/final-typecheck.log`. The chained sidecar typecheck did not run after the root failure; this is not a clean repository typecheck result.
- `pnpm lint:static-export`: **exit 1** on three existing imports outside this task: `lib/browser/extension-engine.ts:450` (`node:fs/promises`) and `lib/plugin/core/builtin-artifact-fixture.ts:15,16` (`node:fs`, `node:path`). See `.cache/feishu-document-audit/static-export.log`. Full production build was not run; static-export compatibility is not established.
- No coverage run, live-account mutation, native UI acceptance, or browser interaction was performed. Existing UI tests emitted `act(...)` warnings. Local contracts do not establish real-account acceptance.

### Remaining boundary

Local regression obligations for all four repairs passed. Repository-wide type/static-export checks and real-provider acceptance remain recorded in the evidence ledger. Image upload/move is a multi-call operation: process death or lost responses can still leave an image with uncertain placement; the tool never reports a confirmed anchored success when the response lacks its created id. A disposable real document is needed for final native read/edit/image acceptance.

## Initial assessment

Cognia has three connected document paths: chat attachment reading, Twin source ingestion, and agent-operated document/Wiki tools. The first two primarily extract text; the third exposes richer CLI operations. The implementation is substantial, but concrete argument/schema/response mismatches prevent describing the whole feature as fully working.

Existing ADRs explain the split: ADR-0134 owns remote-document retrieval and attachment staging; ADR-0026 owns executable agent tools. A new audit report is appropriate because neither ADR records the current cross-path defects and fresh test results.

## Capability matrix

“Implemented” below means executable source is wired and relevant local tests pass. It does not mean a real authorized Feishu document was exercised.

| User flow                 | Implemented behavior                                                                                                           | Boundary                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat `@lark:`             | Keyword search, pasted-link matching, account selection, fetch-on-pick, staged attachment, citation, draft/attachment handling | Provider declares `hosts: ["tauri"]`; search needs OAuth user identity; token round-trip defect below                                          |
| Cloud document reading    | Docx, legacy docs, Wiki nodes resolving to doc/docx                                                                            | API returns `raw_content` as plain text; no full media/block/style preservation                                                                |
| Spreadsheets in chat      | Read visible worksheets as sectioned CSV                                                                                       | At most 10 tabs, 500 rows and 50 columns per tab                                                                                               |
| Bitable in chat           | Read tables/records as sectioned CSV                                                                                           | At most 5 tables and 200 records per table                                                                                                     |
| Large chat attachments    | Character clamp, visible truncation marker, warning; existing attachment token gate                                            | Provider keeps 200,000 body characters; attachment policy is a further independent gate                                                        |
| Twin → Add source → Lark  | Account + document URL/token → preview/staging → confirmed source registration                                                 | Default API text snapshot; accepts doc/docx/Wiki, not sheet/Bitable; staged row does not retain a remote subscription or refresh configuration |
| Agent document tools      | Six tools: search, fetch, create, update, upload image, delete                                                                 | Requires installed CLI and connector credentials; update/upload limitations below                                                              |
| Agent Wiki tools          | Search nodes, read node, create node, move node                                                                                | Node operations are separate from document-body editing                                                                                        |
| Adjacent structured tools | Seven Sheets tools and eight Bitable tools                                                                                     | Separate from the read-only chat provider                                                                                                      |
| Entry points              | Character opt-in for desktop agent tools; connector-bound manifest; `/lark docs search …`; settings capability diagnostics     | Not enabled in every ordinary desktop character automatically                                                                                  |

Source anchors:

- `lib/docs-providers/providers/lark/index.ts:57`, `search.ts:42`, `lib/docs-providers/limits.ts:18`.
- `hooks/chat/use-remote-doc-staging.ts:106`, `components/chat/composer.tsx:1694`, `lib/chat/mentions/pick-registry.ts:226`.
- `components/twin/add-source/source-inputs.tsx:239`, `lib/twin/ingest/stage.ts:435`, `stage.ts:534`.
- `lib/skills/built-in/lark/{doc,wiki,sheets,base}.ts`, `lib/claude/build-options.ts:3258`, `lib/slash-commands/actions/lark.ts:65`.

## Confirmed gaps

### F1 — Search-to-fetch token round trip is narrower than URL handling (high impact)

`searchLarkDocs` returns token-only references. `docInputFor` forwards the bare id when there is no URL. The fetcher reparses that string, and the bare-token parser accepts only historic prefixes such as `doxcn`, `doxbc`, `doccn`, and `wikcn`.

A synthetic alphanumeric id `Z1FjAbCdEfGh1234567890` is accepted inside a `/docx/` URL but rejected as a bare token; calling the real fetcher with it throws `larkInvalidUrl` before any HTTP request. Consequently a search result with that id shape cannot round-trip, even though a pasted URL with the same id can. The frequency of this token shape in the user's actual account is unmeasured.

Evidence: `lib/twin/ingest/lark-url.ts:53,112`; `lib/docs-providers/providers/lark/index.ts:53,104`; `search.ts:72`; local contract probe.

Suggested correction: preserve the already-known resource kind when fetching search results instead of inferring it again from token prefixes.

### F2 — Optional CLI ingestion uses obsolete arguments and misses the documented body envelope (medium impact)

`fetchViaCli` sends:

```text
docs +fetch --api-version v2 --doc-token <token>
```

The installed CLI rejects it with exit 2:

```text
unknown flag "--doc-token" for "lark-cli docs +fetch"
```

Its current argument is `--doc`. The embedded fetch reference also shows body content under `data.document.content`. `normalizeCliPayload` does not read that field: the local envelope fixture becomes serialized JSON instead of extracted document text. The CLI branch labels its result Markdown without selecting `--doc-format markdown`.

This is the optional ingestion branch; the current Twin UI and chat provider use the API default, so it does not invalidate those default paths. The fetcher comments describing Node-only CLI execution are stale: actual execution now uses the Tauri terminal bridge in `lib/skills/built-in/lark/process.ts`.

Evidence: `lib/twin/ingest/lark-doc-fetcher.ts:296,320,334`; CLI dry run and local normalization probe. Existing fetcher tests even assert the obsolete `--doc-token` flag.

### F3 — Update tool schema does not fully represent its advertised operations (medium impact)

- Tool descriptions allow Markdown, but update has no body-format field and never sends `--doc-format`. The CLI defaults to XML. A supplied `format: "markdown"` is stripped by the real Zod schema.
- `payload` must always be a nonempty string. This rejects empty-text `str_replace` deletion and forces irrelevant content for `block_delete`.
- Operation-specific anchors are optional at schema level; missing required selectors reach CLI validation.
- Range fetch exposes no end-block selector; `sectionId` is wired to the start-block flag. The common `mode: "range"` alone fails CLI validation.
- The wrapper does not expose CLI revision-based editing or block move/copy operations.

Evidence: `lib/skills/built-in/lark/doc.ts:119,203,217,231`; installed `docs +fetch/+update --help`; Zod/argv contract probe. Exact live formatting outcomes were not tested.

### F4 — Image insertion treats a block id as a text selector (medium impact)

The input `anchorBlockId` is documented as a block id, but is passed as `--selection-with-ellipsis`. CLI help defines that option as matching the target block's text, optionally with a `start...end` pattern. Supplying an ordinary block id therefore does not express the advertised anchor.

Appending an image without an anchor has a separate implemented path; it was not live-tested.

Evidence: `lib/skills/built-in/lark/doc.ts:260,270`; installed `docs +media-insert --help`; captured argv from the real tool body.

## Setup and reliability concerns requiring live validation

- Default OAuth requests `offline_access im:message im:message.send_as_user`. The desktop authorize button and principal admin flow do not add document search/read scopes. The API search source itself names separate document scopes. An enabled IM connection alone is therefore insufficient evidence of working document search. Audit the app grants and user consent before acceptance.
- API retrieval uses the shared user-token refresh harness. CLI auth reads `user_token` directly from the keyring and has no matching refresh/retry wrapper in this path. Expired-token behavior requires a live check.
- Desktop dispatcher forwards approval as `humanConfirmed`, while the Lark tool family derives CLI `confirmed` only from `hitlBypass`. Approval-to-CLI confirmation propagation needs a dedicated behavioral test before claiming desktop write approval works end to end.
- URLs for Lark international/custom domains are recognized, but the shared API harness fixes its base to `https://open.feishu.cn`. Recognition does not establish deployment/region compatibility.
- CLI capability checks validate version, command existence and required flag names. They do not validate selector meaning, all combinations of arguments, or response parsing.

Source: `lib/connectors/adapters/lark/auth.ts:52`, `oauth-begin.ts:107`, `components/settings/connections/forms/lark-config.tsx:342`, `lib/connectors/principal/admin-intent.ts:231`, `lib/skills/built-in/lark/auth-bridge.ts:133`, `lib/skills/built-in/dispatcher.ts:351`, `lib/skills/built-in/lark/doc.ts:59`, `lib/connectors/adapters/lark/authed-api.ts:43`.

## Boundaries

- Browser, mobile companion, cloud companion and headless profiles have no direct remote-doc provider route in this implementation. `docsProviderReach` distinguishes the unavailable reasons. Do not infer document support from IM connectivity.
- The chat provider is retrieval-only. Document modifications go through agent tools, not a native full document editor.
- The audited provider excludes Slides and mindnotes. No automatic cloud-document refresh/subscription was found in the inspected chat/Twin staging paths.
- API retrieval is plain text/CSV. Images, comments, complex layouts, embedded objects and edit fidelity are not proven by successful text extraction.
- Mutation-tier confirmation, explicit destructive opt-in, audit entries and attachment redaction paths exist in source and focused tests. This audit did not establish a complete security certification.

## Initial audit verification

Two root-entry-point runs completed:

```sh
pnpm test --runInBand lib/skills/built-in/lark lib/skills/built-in/manifest.test.ts lib/skills/built-in/dispatcher.test.ts lib/twin/ingest/lark-doc-fetcher.test.ts lib/twin/ingest/lark-url.test.ts lib/twin/ingest/stage.test.ts components/twin/add-source/source-inputs.test.tsx components/twin/add-source/add-source-flow.test.tsx components/twin/lark-account-picker.test.tsx components/settings/built-in-skills/lark-tab.test.tsx
# 22 suites passed; 266 tests passed.

pnpm test --runInBand lib/docs-providers/providers/lark lib/docs-providers/reach.test.ts lib/docs-providers/index.test.ts hooks/chat/use-remote-doc-search.test.ts hooks/chat/use-remote-doc-staging.test.ts lib/chat/mentions/attachment-citations.test.ts lib/chat/mentions/pick-registry.test.ts components/chat/composer.doc-citations.test.tsx lib/connectors/adapters/lark/authed-api.test.ts components/settings/connections/docs-providers/docs-providers-card.test.tsx
# 15 suites passed; 194 tests passed.
```

Total: **37 suites, 460 tests passed**. The first run includes installed-CLI capability and dry-run integration tests. Some React tests emitted pre-existing `act(...)` warnings; expected error-path tests emitted warnings.

Additional probe: `node .cache/feishu-document-audit/verify-contracts.cjs`. This loads/transpiles actual source, substitutes external dependencies, checks actual Zod schemas and tool argument construction, and runs the invalid fetch command only with `--dry-run`. Output: `.cache/feishu-document-audit/contracts.json`. It confirms the negative cases above; it is not a provider integration test. CLI response normalization uses a synthetic envelope matching the embedded documentation. No document content was read or modified.

No coverage, full build, repository-wide typecheck/lint, browser interaction, or native/provider acceptance was run: product code was not changed. Only this report and its evidence ledger were authored. CodeGraph was unavailable because this checkout has no index; direct source inspection was used.

## Initial recommended order (superseded by the repair follow-up)

1. Repair search-result token round trips and add provider-search-to-fetch integration coverage.
2. Align optional CLI ingestion arguments, explicit output format, and nested response normalization.
3. Correct update schemas/body format and image anchor semantics; cover actual generated argv rather than registration alone.
4. Add document-specific scope onboarding and verify approval/token refresh with a user-selected disposable document in real Tauri.

# Structured document reading implementation

This change extends the existing document parsers, knowledge generations, retrieval adapters, Agent tool host, plugin project API, and source preview. It does not introduce another Agent framework or a PageIndex runtime dependency.

## Entry points and configuration

In Settings, the existing Knowledge Base source manager now exposes application reading defaults. Create a library first if the manager is not visible. Workspace knowledge settings also expose vector, hybrid, and keyword retrieval.

`AppSettings`, `Character`, and `ChatSession` accept `knowledgeReading`. Precedence is application → character → session. Defaults retain vector retrieval and disable the additional reading tools. Enabled reading adds `knowledge_list_documents`, `knowledge_read_outline`, `knowledge_read_original`, and `knowledge_locate` through the existing tool manifest and IPC dispatch.

```ts
const knowledgeReading = {
  enabled: true,
  retrievalStrategy: "hybrid" as const,
  topKPerBase: 5,
  ragTokenBudget: 2_000,
  maxCalls: 32,
  maxReadChars: 16_000,
  totalReadChars: 64_000,
  maxOutlineNodes: 200,
  summaryMaxChars: 500,
}
```

Budgets are bounded by `resolveKnowledgeReadingSettings` and shared across calls on a reader. Zero call/read budgets explicitly disable those operations. A caller can request less text but cannot raise host limits. Follow `nextCharStart` with the returned `generationId` for continuation. Keyword candidates work against an existing index without an embedding runtime; hybrid candidates degrade to lexical results when the vector lane is unavailable.

The optional `summaryProviderId` selects a host-registered callback from `registerKnowledgeSummaryProvider` in `lib/knowledge-base/runtime/progressive-reading.ts`. Its disposer unregisters the provider. No provider is called by default. Summaries are bounded navigation metadata; answers must use original reads. Registering a summary callback is a host integration seam, not an unrestricted plugin permission or a source authorization mechanism.

## Data and lifecycle

`ProcessedDocument` separates original `content`, `embeddableContent`, and `structure`. Structure contains stable heading-path IDs, parents, canonical text hashes, UTF-16 half-open character ranges, and one-based line/page ranges. Markdown frontmatter, fenced code, and Setext headings retain original offsets. PDF outlines and page provenance use the existing parser and OCR router. Scanned and mixed PDFs retain page mappings; digital pages retain their existing spatial metadata.

KB originals and structure are stored with immutable generation snapshots. Chunk metadata carries the original version and locations. Publication uses existing generation swaps and guards against source edits, deletion, and ownership changes. Rollback reads the selected snapshot. Deletion clears snapshots and their generation state. A project text edit invalidates old projections and positions. Twin publishes its current snapshot and companion source metadata atomically, including empty replacements.

KB citations preserve version, generation, page, line, section, and character fields through the Claude adapter. Source clicks reuse the Twin text preview, highlight the original range, label historical versions, and reject deleted or unavailable references. Tests cover duplicate clicks, close/reopen, stale versions, and retry after failure.

## Authorization and plugins

Source access is checked in the service against the actual entrypoint and verified caller. Workflow admission freezes generation bindings; nested Agent and team calls inherit the parent scope ceiling. Model text, plugin arguments, document context, and arbitrary session IDs do not grant access. Session teardown removes readers and authority.

Existing `ctx.project` gains `listKnowledgeDocuments`, `readKnowledgeOutline`, `readKnowledgeRange`, and `locateKnowledgeDocument`. Existing add/update/remove knowledge-file operations retain indexing ownership. Agent reads require both `project:read` and `knowledge:read`, plus the host-created `toolContext.project` invocation binding. Revocation and `forbid` are checked by the shared permission guard. Public invocation APIs cannot use legacy project getters to bypass the bounded Agent scope. Retained APIs close when invocation ends.

The existing sandbox webview transport exposes the same supported project operations with method allowlisting, bounded requests, cleanup, and live grant checks. See the [English SDK guide](../content/docs/en/plugin-dev/author-sdk.mdx) and [Chinese SDK guide](../content/docs/zh/plugin-dev/author-sdk.mdx) for types, manifest declarations, code examples, and runtime support.

## Main implementation paths

| Concern                     | Files and reused modules                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Canonical structure         | `packages/document/src/document-structure.ts`, existing processor and Markdown/PDF parsers                      |
| OCR and Twin publication    | `lib/twin/ingest/{parse,ocr-fallback,job-runner,persist}.ts`                                                    |
| Original offset restoration | `packages/redact/src/index.ts`                                                                                  |
| KB lifecycle                | `lib/db/knowledge-bases.ts`, `lib/knowledge-base/ingest/`, `lib/knowledge-base/revisions.ts`                    |
| Project ingestion           | `lib/project-knowledge/ingest/`, `wire-ingest.ts`, `stores/project/project-store.ts`                            |
| Reading/configuration       | `lib/knowledge-base/runtime/{progressive-reading,reading-settings,session-reader}.ts`                           |
| Retrieval                   | Existing KB/project retrieval modules, shared BM25, RRF and retrieval kernel                                    |
| Agent host                  | `lib/claude/{build-options,knowledge-builtin-tools,plugin-tool-ipc}.ts`, existing executor and dispatch paths   |
| Citation UI                 | `lib/claude/adapter.ts`, `components/chat/message-parts/sources-part.tsx`, existing Twin previews               |
| Settings UI                 | `components/settings/knowledge-base-manager.tsx`, `components/shell/workspace-knowledge-section.tsx`            |
| Plugin contract             | `types/plugin/plugin-knowledge.ts`, existing SDK exports, project API, permission guard and project webview RPC |
| Frozen workflow authority   | `lib/workflow/knowledge/access.ts`, execution admission, existing Agent/team nodes and dispatch                 |
| Evaluation                  | `packages/eval-core/src/fixtures/long-document.ts`, `lib/ai/eval/ci/structured-reading-fixture.ts`              |

Each changed runtime/UI module has corresponding colocated tests. Split English/Chinese message sources feed the normal generated messages.

## Validation and limits

Final focused validation used installed binaries, without installing dependencies or enabling coverage:

| Check                                                                                    | Result                       |
| ---------------------------------------------------------------------------------------- | ---------------------------- |
| Ingestion, generation lifecycle, workspace/settings UI, citations and previews           | 25 suites / 671 tests passed |
| Retrieval, original offset restoration, configuration types and deterministic evaluation | 8 suites / 148 tests passed  |
| Reader, budgets, settings sync, Agent manifests, IPC and executor                        | 8 suites / 171 tests passed  |
| Workflow admission, nested dispatch and team authorization                               | 10 suites / 363 tests passed |
| Document and eval-core package typechecks                                                | Passed                       |
| Scoped ESLint and formatting                                                             | Passed                       |
| Compiled locale freshness, ICU validation and i18n key parity                            | Passed                       |

The plugin API, guard, invocation, webview bridge, permission catalog and SDK contract group additionally passed 12 suites / 261 tests. Canonical generated permission artifacts passed their freshness check.

The final whole-app TypeScript check completed with a 16 GB heap using `tsc --noEmit --incremental false`. All new document/reader/plugin/settings integration diagnostics were fixed. Seventeen remaining diagnostics are in unrelated CLI external-Agent, connectivity story, chat/external-Agent tests, identity test and push-notification code. The overall command therefore exits nonzero and is not reported as passing.

Full send-options validation passed 438 tests and failed four old exact-tool expectations missing `artifact_capture`. Isolated copies of the repository's HEAD source and test reproduced all four. The broader plugin context suite also reports an existing `connectors.deleteEphemeralCard` catalog-parity mismatch, outside the document API. Whole-repository ESLint reports five errors and 1,748 warnings in unrelated external-Agent/composer code, existing team database code and generated PDF plugin assets. These files were not cleaned or reset.

The [deterministic evaluation](structured-document-reading-evaluation.md) uses the existing RAG scorer, a 74,034-character fixture, real parser and database adapters, and deterministic embedding/judge boundaries. It makes no paid model calls. Original section reading consumes 275 source characters for the fixture questions. Canonical fast RAG retains the same evidence; the separate legacy projection case demonstrates recovery of a code-only fact through original reading.

Native PDF rendering/OCR hardware paths and a live desktop/browser click-through still require platform testing; component tests exercise navigation state and failure handling. Production builds and deployment were not performed. KB snapshot history currently retains originals until source/base deletion; automatic history pruning is not introduced. Twin has a current snapshot and no preexisting revision rollback API. PDF bookmarks without precise text destinations may share whole-page ranges.

Durable team workflows can read only admitted knowledge index bindings. Static `action.team.run` profiles now discover character-bound Knowledge Bases through the existing team runtime port, including variant and capability-overlay resolution, and pin their generations at admission. Dynamic team IDs and bindings introduced after admission cannot expand that frozen scope; they require a new admission with the required indexes. Frontend/hybrid plugin and sandbox transports are supported as documented; Python, WASM, headless, and asynchronous Node activation replay are not advertised as supported reading transports.

Repository-wide lint/type diagnostics and preexisting broad-suite failures are reported separately from focused feature checks in the task outcome. The workspace contains unrelated ongoing changes; no reset, commit, push, publish, or deployment was performed for this task.

## Acceptance follow-up

The former static-team admission gap was closed through the existing host port. The follow-up passed 77 tests across nine admission, team, dependency-direction and headless-host suites. Dynamic team IDs and later profile edits still require predeclared dependencies or a new admission; this is a scope boundary, not permission inferred from model output.

After that fix and the final plugin SDK type cleanup, the whole-app TypeScript check was rerun. `/tmp/cognia-structured-acceptance-typecheck.log` contains the same 17 diagnostic headers as the prior final run, with no additional errors from the follow-up. The command still exits 2 because those unrelated workspace diagnostics remain.

Snapshot retention is not an omitted source-deletion path: source/base deletion removes the associated snapshots, generations and pointers, and stale or orphaned references fail closed. No automatic age/count-based pruning policy was added. Repeated KB rebuilds therefore retain immutable originals and increase storage usage until deletion. Introducing pruning requires an explicit policy for retained citations and rollback generations. Twin continues to have its current snapshot rather than a newly invented historical rollback API.

The remaining 17 TypeScript diagnostic headline messages match the earlier `/tmp/cognia-structured-typecheck.log` exactly after normalizing line/column numbers, and their files are outside this task's edit ownership. Examples include the CLI's missing `toolUseID`, external-Agent elicitation signature mismatches, the connectivity story's `PairRemedy` literal, and the existing push timer type. This is an earlier dirty-workspace comparison, not a claim that a clean checkout passed.

Lint attribution was checked separately against HEAD without resetting files. HEAD copies of `session-panel.test.tsx` and `composer.tsx` pass ESLint; both paths were already modified in the saved initial workspace status, and this task did not edit them. The generated `public/plugins/cognia-pdf/dist/index.js` is absent from HEAD and accounts for three errors and most warnings. `lib/db/agent-team-runtime.ts` reproduces its unused-import warning from HEAD. The plugin catalog mismatch is also visible in HEAD: `connectors-api.ts` implements `deleteEphemeralCard`, while the canonical catalog omits it. Four send-options expectation failures were separately reproduced by executing isolated HEAD copies.

Live browser verification was attempted on a temporary loopback-only server with installed dependencies and `NEXT_PUBLIC_E2E=1`. After the local socket restriction was approved, Turbopack failed compiling `/` with `Parent client reference not found for next/dynamic import` and HTTP 500. The supported webpack fallback started but did not produce a root response through the retry window (including a separate 30-second HTTP request); browser control also timed out before a usable app was visible. Both temporary servers were stopped. No fixture account, real user data, OCR provider or paid model was used. Logs: `/tmp/cognia-structured-ui-dev.log` and `/tmp/cognia-structured-ui-webpack.log`.

Consequently, live citation clicking and settings persistence remain unverified beyond their component/integration tests. Native OCR/desktop E2E remains unverified because the repository's real Tauri harness requires Windows WebView2/CDP, whereas this host is macOS. The platform requirement is documented in `.agents/skills/cognia-e2e/references/tauri-and-native.md`. Browser mocks would not establish native OCR correctness. A successful app boot and the Windows native harness are still needed for those acceptance checks; no unrelated compiler repair was attempted.

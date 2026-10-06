# Structured document reading: deterministic regression evaluation

The long-document fixture checks that original text can be read through the actual knowledge reader after indexing, with source scope, ACLs, immutable revisions, and read budgets enforced by the service. It reuses the existing RAG scorer rather than introducing another evaluation system. It is a regression fixture, not a benchmark of model reasoning or a comparison with PageIndex.

## Run

From the repository root, using the installed tools:

```sh
node_modules/.bin/jest packages/eval-core/src/fixtures/long-document.test.ts lib/ai/eval/ci/structured-reading-fixture.test.ts --runInBand --coverage=false

COGNIA_STRUCTURED_READING_REPORT=1 node_modules/.bin/jest lib/ai/eval/ci/structured-reading-fixture.test.ts --runInBand --coverage=false --silent=false
```

The second command emits one JSON report for each retrieval strategy. The integration suite also participates in the existing `test:evals` directory selection. Neither command needs a provider key, network access, or a paid model call. Coverage is not enabled.

## Fixture and boundaries

`packages/eval-core/src/fixtures/long-document.ts` is a portable synthetic Markdown generator with 48 background chapters, nested recovery sections, a fact inside an INI code block, a prose approval fact, and an unsupported question. The default original document is 74,034 UTF-16 characters. `revision: 2` changes the recovery delay from 47 to 61 and the approval owner from Cedar to Birch while retaining heading titles. `backgroundSections` accepts integers from 1 through 500; the fixture rejects unsupported revisions and invalid counts.

`lib/ai/eval/ci/structured-reading-fixture.ts` accepts an explicit fast retrieval adapter and original-section reading adapter, then invokes `makeRagScorer` for context recall and faithfulness. The answer generator is an exact-match oracle: it returns the synthetic reference only when executed context contains that reference, otherwise it abstains. The faithfulness judge is also an exact-match test double. No Agent tool calls, token usage, latency, or Agent steps are fabricated. Faithfulness of an abstention does not imply task completion; the separate `answerCorrect` and `abstained` fields preserve that distinction. Context recall for the unsupported question remains `not-applicable`, represented as `null` in JSON.

The co-located integration test exercises these real implementations:

- `processDocument` preserves original Markdown and builds the canonical structure.
- `prepareChunks` uses the existing format-aware chunker over canonical original text, matching the updated ingest contract. A separate compatibility case seeds the legacy embedding-only projection.
- The normal Dexie schema and persistence functions store sources, revision snapshots, generations, pointers, and chunks, using the existing `createDbTestFixture` over fake IndexedDB.
- `retrieveKnowledgeBaseChunks` executes vector, keyword, and hybrid strategies. Keyword search and hybrid fusion use the existing retrieval kernel and BM25 implementation.
- `createKnowledgeReader` uses its default database adapter, lists documents, returns the outline, and reads original sections through stable section IDs.
- The existing database source deletion removes chunks, generation snapshots, generations, and pointers before the source is rebuilt.

The vector-store boundary returns deterministic scores and uses a precomputed query embedding. It is a test double, not a real embedding model. Section selection uses the known synthetic section title, not a reasoning model. Generations are seeded directly as validated rows so the evaluation checks reading and filtering contracts; it does not test embedding, ingest job orchestration, or generation-swap transactions. Those contracts belong to their existing ingest and database suites.

## Observed results

On this change, all 19 fixture and integration tests passed. The report command passed all 10 integration tests. The existing RAG scorer suite adds 20 passing tests. Scoped ESLint for the four TypeScript files and the eval-core package typecheck passed.

| Case                            | Fast vector | Fast keyword | Fast hybrid | Original section reading |
| ------------------------------- | ----------- | ------------ | ----------- | ------------------------ |
| Code-only delay: context recall | 1           | 1            | 1           | 1                        |
| Prose approval: context recall  | 1           | 1            | 1           | 1                        |
| Unsupported policy              | Abstains    | Abstains     | Abstains    | Abstains                 |

Original section reading returned 275 characters across the three questions, less than 1% of the 74,034-character source. This excludes outline metadata and measures executed source text only. The canonical indexing comparison verifies fast RAG compatibility: both modes retain the answer evidence. In the separate legacy-projection test, fast context recall is 0 for the code-only fact and original section recall is 1, because the Markdown embedding projection removes fenced code blocks. These synthetic checks do not establish general performance superiority of progressive reading over fast RAG.

The integration suite additionally proves:

- A 12-character read limit truncates original evidence, exposes the continuation offset, and exhausts the configured cumulative budget. An empty retrieval budget yields no context. The oracle cannot answer from unseen text.
- Stable section IDs survive changed body facts; explicit retiring revisions return historical text while the default reader returns current text.
- Deleted sources are unreadable even with an old generation ID; local chunks and generations are removed. Rebuilding the source makes newly indexed text readable again.
- HTTP ACL revocation is checked during execution, and a source outside the selected knowledge base scope is rejected. Trusted local and public workflow semantics remain owned by the existing access service.
- Adapter failures reject the evaluation rather than producing a passing report.

## Complementary checks and remaining validation

### Workflow and nested Agent authority

Workflow Agent turns and team runs derive source authority from the durable invocation's entrypoint, verified initiator, and dependency lock through the shared `resolveWorkflowKnowledgeAccess` helper. The admitted index bindings form the knowledge base ceiling. Static `action.agent.turn` knowledge base bindings and static character-bound knowledge are frozen at admission alongside existing `knowledge.retrieve` dependencies. A binding introduced after admission cannot widen the run.

Nested `dispatch_agent` calls read the parent's host-registered authority and pass it into child execution. Unknown caller sessions receive an empty knowledge ceiling. Public plugin dispatch arguments have the internal authority field removed before execution. Team runtime contexts retain a defensive copy of the same authority and forward it through sidecar and text-only dispatch. Chat teardown and teammate completion remove registered readers and authority.

Static `action.team.run` nodes discover their current roster's effective backing characters through the existing ADR-0217 team runtime host port. Discovery reuses the dispatch capability overlay resolver and its first-character selection, then the saved/variant character resolver. Admission pins those characters' knowledge generations before execution; later team or character edits cannot widen an admitted run. Missing teams or backing characters fail admission. Legacy hosts without the dependency callback add no scope.

Teams selected through expressions or composed after admission still require their knowledge to be declared by another admitted knowledge dependency. They remain within the frozen lock, including durable desktop/CLI workflows. Unbound interactive team execution retains the existing local access semantics. Runtime source ACL checks continue to apply independently of dependency discovery.

These authority contracts have dedicated dispatch, team, workflow access, and admission regression tests. The long-document fixture itself remains a service-layer test.

This Markdown fixture does not exercise PDF rendering, OCR engines, UI clicking/closing/back navigation, actual Agent tool-host dispatch, or plugin bridge dispatch. These require their corresponding parser, ingest, reader, citation, Agent integration, and plugin contract suites. The focused suites include `packages/document/src/document-structure.test.ts`, `packages/document/src/parsers/pdf-parser.test.ts`, `lib/twin/ingest/parse.test.ts`, `lib/knowledge-base/ingest/ingest-source.test.ts`, `lib/knowledge-base/ingest/persist.test.ts`, `lib/knowledge-base/runtime/retrieve.test.ts`, and `components/chat/message-parts/sources-part.test.tsx`. Their results must be reported separately; this fixture does not imply they passed.

No browser E2E was added for the fixture itself: it introduces synthetic data and service-layer assertions without a new user interaction. The changed citation-navigation user journey still needs its own UI validation. Real model evaluation and native OCR/PDF platform behavior are not established by deterministic fake IndexedDB tests.

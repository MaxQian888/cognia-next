# MultiAgentBench repair: adversarial review

Date: 2026-10-26. Scope: the 2026-10-26 repair, compared with its retained pre-repair files. Three fresh-context reviewers examined storage, resume/accounting, and execution/judging separately. They received artifacts and contracts without the author's rationale. Source snapshots and probes are retained under `.cache/multiagentbench-repair-review-2026-10-26/`.

The review found **five actionable defects in paths reachable by the CLI**, four narrower API/data-boundary defects, and one contradictory-prompt risk. Source code was not changed. Cross-model review was offered and explicitly skipped by the user. No real model, network or credential access was used in the probes.

The five main findings are P2: the recovery/configuration cases require malformed, corrupted or edited on-disk evidence; they were not observed in the earlier normal smoke. The review does not establish normal CLI duplicate paid dispatch or loss of its all-attempt token ledger. Two reviewers suggested P1 for recovery/configuration; the parent retained the findings but assigned P2 because those additional input-corruption preconditions matter.

## Actionable CLI findings

### F1 — Validate complete recovery records before importing them (P2)

`scripts/eval/multiagentbench-runner.ts:519-525` validates replay identities, then imports recovery events. Replay at lines92-108 validates neither complete trial/sample shape nor token bounds. Projection and accounting happen after the append.

Verified counterexamples:

- A recovered trial with matching task/variant/repetition but no `solver` or `judgments` enters `events.ndjson`; projection then throws `Benchmark failed and final evidence snapshot failed`. The original results snapshot survives, but the authoritative journal now contains the invalid record.
- A settled sample with `metricAvailability.usage="known"` and no `usage` is likewise imported before projection fails.
- A recovered known sample with input=-900/output=2 is accepted as **total=-898**, measuredCalls=1 and unknownLiabilityCalls=0. Execution then reaches the injected credential reader and next trial.

Before any import, validate complete candidate event/trial/sample schemas, finite nonnegative usage, and every projection that the imported records must support. A rejected recovery must preserve the original journal and snapshot.

### F2 — Validate frozen options independently of themselves (P2)

`scripts/eval/multiagentbench-runner.ts:656` casts parsed `executionOptions`; the comparison at line390 compares a reconstructed options object with the same source object. It does not validate its types/bounds or consistency with the manifest's model, mode, budgets and protocol.

Verified counterexamples with unchanged source/runtime provenance:

- Top-level model remains `fixture`, but nested `executionOptions.model` changes to `different-model`. The injected credential reader runs and the trial receives `different-model`.
- Nested `timeoutMs="not-a-number"` reaches the injected credential reader and persists an attempt start. The actual frozen trial then fails at `AbortSignal.timeout`: `The "delay" argument must be of type number. Received type string ('not-a-number')`.
- A live manifest with zero settled trials and nested `dryRun=true` returns exit0 before journal replay.

Validate the complete options schema and cross-field invariants before opening recovery storage or reading credentials. Reject live/dry-run contradictions. This is an artifact-validation defect, not a claim that a local file hash authenticates a maliciously rewritten manifest.

### F3 — Match settlement metadata to its admission (P2)

`scripts/eval/multiagentbench-runner.ts:97-98` accepts a settlement using only its call ID. It does not compare phase, agent ID, task ID or judgment kind with the admission.

Verified input: solver admission `callId=c`, followed by judge settlement `callId=c` with known10+2 usage. Replay accepts it; accounting reports solver12, judge0 and unknown liability0. Corrupted or misassociated evidence can therefore discharge the wrong liability.

Reject settlements whose immutable call metadata differs from admission. Unknown liability must not disappear because a different call's sample shares an ID.

### F4 — Preserve raw bytes and reject invalid UTF-8 before rollback (P2)

`scripts/eval/multiagentbench-storage.ts:194-198` decodes acknowledged journal bytes with replacement before validation. With a complete JSON record containing byteFF inside a string, followed by a torn tail, replay returns a replacement character and rewrites the acknowledged prefix as UTF-8 EFBFBD. The tail backup does not contain the overwritten interior bytes.

This happens before the runner's semantic validation, so a later rejection cannot undo it. Before/after binary artifacts and hashes are retained in `probes/storage/adversarial-v2/`.

Strictly validate UTF-8 and complete records before changing the journal. Preserve acknowledged content as raw Buffer bytes, including during torn-tail recovery.

### F5 — Verify quotes against the proposal actually shown to the judge (P2)

`lib/ai/eval/multiagentbench-runtime.ts:365` validates quotes against the original solver output. The real pure-model target first redacts the judge prompt.

The probe uses the actual target and PII gate with synthetic generation. `Participant contact: patient@example.invalid` becomes `Participant contact: <EMAIL_001>` in the outbound judge prompt. A judge response quoting the exact outbound text is rejected as `quotes text absent from the proposal`.

Preserve a canonical judge-visible proposal representation and validate evidence against it. Keep the outbound PII gate. A valid redacted quotation must not turn a compliant primary assessment into an error.

## Narrower boundary findings

These counterexamples are real, but do not demonstrate the corresponding failure in today's CLI wiring. They are P3 robustness work unless those APIs gain additional callers.

| ID  | Boundary                    | Counterexample                                                                                                                                                                                   | Current CLI qualification                                                                                                                                     |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Storage failure latch       | `journal.stat()` EIO occurs outside the append failure latch. Of two queued appends, the first rejects and the second fulfills; disk admission still reports ready.                              | `record()` aborts the shared controller and execution checks it after the barrier; no extra CLI paid dispatch was established.                                |
| A2  | Closed storage ownership    | After a reserve-cleanup error releases the lock, a successor opens. Retrying predecessor `close()` deletes the successor's reserve; a closed predecessor can also append to its journal.         | Normal runner finally calls close once. The counterexample requires retained-object reuse/retry. Make lifecycle closure terminal and ownership checked.       |
| A3  | Awaiting parallel admission | One hook rejects while another is awaiting. Without caller abort, the second hook can later return successfully and dispatch because `evidenceAvailable` was checked only before await.          | The CLI callback aborts the shared signal; the same probe with that abort produces no dispatch.                                                               |
| A4  | Returned trial sample       | A settlement hook rejects after a20-token sample returns. The thrown finally prevents assigning the sample to solver/judge trial fields; primary-cell accounting becomes unmeasured/lower-bound. | CLI recoveryEvents retains the complete sample and all-attempt accounting; this is returned-trial information loss, not demonstrated all-attempt ledger loss. |

## Contradictory-prompt risk

The captured communication prompt requires a `{"rating": X}` object, includes `milestoneOutputSchema` whose type is array, and adds `Follow the supplied JSON schema`. This is a verified conflicting output contract at `multiagentbench-runtime.ts:316-325`; the rate at which a model follows the wrong schema has not been measured. Supply a schema specific to each judgment kind. The earlier successful communication smoke does not resolve the contradiction, and this review makes no claim that those earlier grades failed.

## Positive controls and limits

The parent ran actual synthetic child-process SIGKILL/restart probes through the hash-verified final frozen runner. These are I/O/runtime tests, not provider performance results:

| Crash point                                            | Explicit retry required | Final cells / physical attempts | Captured synthetic tokens | Unknown calls | Owned resources released |
| ------------------------------------------------------ | ----------------------- | ------------------------------- | ------------------------- | ------------- | ------------------------ |
| After durable admission                                | Yes                     | 3/4                             | 36                        | 1             | Yes                      |
| After durable call settlement, before trial settlement | Yes                     | 3/4                             | 48                        | 0             | Yes                      |

Both controls passed. They narrow the findings: ordinary interrupted-call accounting works in these cases; semantically invalid/corrupted recovery records and mismatched representations remain insufficiently defended.

This round did not rerun the full regression suite, full typecheck, full app build or live benchmark. Prior green tests and smoke results remain dated evidence rather than proof against the new counterexamples. Product source and historical benchmark artifacts remain unchanged.

## Reproduction receipts

- Resume/configuration/association: `.cache/multiagentbench-repair-review-2026-10-26/probes/resume/probe.mjs` and `results.json`.
- Storage: `probes/storage/adversarial-v2/probe.mts`, `result.json`, `journal-before.bin`, `journal-after.bin`.
- Judging/PII/parallel controls: `probes/judging/probe.cjs`, `results.json`, `communication-prompt.txt`.
- Actual process interruption controls: `probes/process-crash.mjs` and `probes/process-crash/results.json`.
- Reviewed source snapshot: `input/` and `inputs.json`.

Run all probes with the recorded Node26 runtime and local dependencies. The process-crash probe intentionally SIGKILLs only its own synthetic child processes. It retains outputs; do not point it at a real campaign directory. The review stops after one bounded cycle with actionable findings; no fix or new model campaign was performed.

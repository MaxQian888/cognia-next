# d.sh adoption feasibility for Cognia

Date: 2026-09-30 (Asia/Shanghai).

Scope: primary-source inspection of `SiriusNEO/d.sh` and comparison with current Cognia source. No upstream program was executed, installed, or connected to a model; no real credentials were used. Cognia checks cover focused context unit tests and a synthetic compaction probe, not desktop or provider acceptance.

Clarified decision: the user's intended use is an extremely small agent utility, or an agent embedded in an environment as its initialization mechanism. The primary proposal is therefore a bounded bootstrap agent that can work before the full Cognia runtime is available, prepare or repair the environment, verify readiness, and hand off. Existing initialization lifecycle and persistence should be extended where available. Context-recovery improvements remain supporting findings rather than the main adoption target. The initial assessment was a design proposal. The approved implementation and its verification are recorded in the 2026-10-01 section below.

## Clarified proposal: a tiny environment agent

The user clarified on 2026-09-30 that the interest is in the standalone small-tool and initialization roles. A restricted profile inside a fully started Cognia sidecar does not cover the latter: the target environment may not yet have the dependencies required to start that sidecar.

Two entry points can share one small core:

- **Task utility:** accept a short task, work inside the selected environment using shell and text operations, return a result, and exit. It should not require the app, browser UI, full external-agent integration, or a background service.
- **Initialization agent:** receive an environment target and explicit readiness checks; inspect available tools, perform bounded setup/repair, verify the checks, and terminate before the normal runtime starts. The model adapts to unfamiliar failures; known setup operations remain deterministic scripts.

Proposed initialization sequence:

```text
Probe environment
  → reuse a still-valid successful setup, or run the declared setup recipe
  → use the tiny agent for an opted-in adaptive setup or a recoverable setup failure
  → run explicit readiness checks
  → record initialization result
  → start the normal runtime
```

The minimal core needs model HTTP access, command execution, text-file access, a bounded observe/act loop, real exit/timeout/cancellation handling, and a machine-readable result. A persistent shell is useful for multi-command setup, but restoring it across process restarts is unnecessary for the first design. Browser control, MCP discovery, RAG, teams, and long-lived chat history do not belong in this utility unless a concrete initialization task needs them. Credentials should be supplied for the invocation rather than written into the executable/script.

Distribution can be a single script or a small standalone executable. A full TypeScript/Cognia-sidecar dependency would undermine the pre-runtime bootstrap use case. d.sh demonstrates the script option, but its actual Bash 4.3+ and curl prerequisites still need to exist or be supplied deterministically. Packaging size, platform compatibility, and readiness behavior have not been measured here.

### Existing integration points inspected after clarification

- `lib/project-environment/executor.ts:75` owns setup/action execution; `:130` coalesces setup by root and signature, and `:159` checks whether successful initialization can be reused. `lib/project-environment/setup-reuse.ts` fingerprints declared inputs and verifies outputs exist. These are the right boundaries for an opted-in adaptive setup mode or repair phase; existing successful-reuse and failure semantics should remain authoritative.
- `types/project-environment.ts:26` already records initialization status; `:88` separates setup scripts, variables, and keyring references. A future tiny-agent setup declaration would need to participate in the signature/fingerprint and have explicit readiness checks. A model declaring success cannot by itself certify that setup succeeded.
- `crates/cognia-sandbox-pool/src/docker.rs:1150` prepares agent containers, and `:1039` carries environment lifecycle commands into their runtime configuration. A container bootstrap belongs after sufficient shell/network access exists and before the formal agent starts, within the intended container. It must not turn the host probe or image-admission checks into an agent-controlled repair step.
- `crates/cognia-sandbox-pool/src/build.rs:888` rejects host `initializeCommand` in Dev Container builds. That remains a constraint: an environment agent should not silently execute repository-supplied initialization on the host as a workaround.
- `cli/src/runtime/bootstrap.ts` starts the full sidecar and waits for readiness; that is a handoff target, not an implementation of a dependency-minimal environment agent. The remote-host ADR still describes automated SSH provisioning as deferred; a bootstrap design alone does not establish working remote deployment.

The smallest useful pilot would be one disposable Linux container with an intentionally incomplete project environment: the tiny agent completes a concrete setup goal, explicit checks pass, a full agent then starts, and a second initialization reuses the recorded result. Follow with broken networking, bad credentials, command failure, cancellation, and exhausted step/time budget. Standalone operation before the full sidecar starts is a required acceptance check, not merely an optimization.

## Inspected snapshot

- Repository: [SiriusNEO/d.sh](https://github.com/SiriusNEO/d.sh).
- Inspected `main` commit: [`f8b8ff864694624fe86157004e484f25e0397a3a`](https://github.com/SiriusNEO/d.sh/commit/f8b8ff864694624fe86157004e484f25e0397a3a), committed 2026-09-15T22:59:14+08:00.
- Fresh source checkout: `/tmp/cognia-dsh-upstream-20260930`; read-only inspection.
- Four commits in the fetched history, starting 2026-09-10. Tracked content at this SHA is exactly `d.sh`, `README.md`, `README.zh.md`, and `.gitignore`. `d.sh` has 1,675 lines. The only post-initial code fix corrects interactive `read` exit-status capture: [commit 829b8ba](https://github.com/SiriusNEO/d.sh/commit/829b8baf490d3944f0cf5d27f6ca00585f08b460).

## What the project actually is

An independent Bash implementation of a small coding-agent loop, positioned as a bootloader for minimally provisioned servers. Its purpose is to let a model prepare an environment or install a fuller agent before Node/Python/package-manager infrastructure exists. It is not the official `deepseek-ai/deepseek-harness` SDK or a dependency-free build of that SDK. [README L5](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/README.md#L5), [README L70-L89](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/README.md#L70-L89).

The README names the official Harness `sdk-minimal` two-tool profile at `dsh-v0.1.5-alpha.1` as its behavioral reference. The relationship is inspiration/adaptation, not SDK linkage. Version-history claims about the official Harness are author claims in this README, not independently checked by this upstream-only inspection. [README L72-L81](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/README.md#L72-L81).

## Architecture and evidence

| Area             | Actual implementation                                                                                                                                                                                           | Primary source                                                                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration    | Environment-overridable endpoint/model/key; default model `deepseek-v4-flash`; 100 tool-loop steps; 300-second command timeout; 600-second API timeout                                                          | [d.sh L10-L38](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L10-L38)                                                                                                                                                                                                                                  |
| Protocol         | Bearer-authenticated Chat Completions, streamed by default; always adds DeepSeek `thinking`, conditionally `reasoning_effort`; appends `/chat/completions` to base URL                                          | [L973-L1020](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L973-L1020), [L1636-L1637](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1636-L1637)                                                                                                                |
| Parsing          | Hand-written JSON parser in Bash, UTF-16 surrogate handling, raw/type/value maps, depth 64, explicit NUL rejection                                                                                              | [L471-L608](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L471-L608)                                                                                                                                                                                                                                   |
| Persistent shell | One Bash coprocess; NUL-framed commands; randomized completion marker; shared cwd/env/functions; no TTY; command stdin `/dev/null`; timeout/interrupt kills the owned process group and resets shell            | [L612-L719](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L612-L719)                                                                                                                                                                                                                                   |
| Editor           | Absolute-path text `view/create/str_replace/insert`; unique exact-match replacement; creation refuses overwrite; no binary/NUL; output clipped to 16,000 characters                                             | [L725-L928](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L725-L928)                                                                                                                                                                                                                                   |
| Streaming        | Accumulates content, reasoning, and indexed tool-call fragments; checks role, completion status, and complete tool calls before execution                                                                       | [L1204-L1389](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1204-L1389)                                                                                                                                                                                                                               |
| Loop             | Append user; compact; request model; validate/collect calls; sequentially execute both available tools; append tool results; save at a normal terminal answer                                                   | [L1437-L1547](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1437-L1547)                                                                                                                                                                                                                               |
| Persistence      | Role-tab-JSON lines rather than conventional one-JSON-object-per-line; system message regenerated; temp write, mode 600, rename; malformed rows skipped                                                         | [L413-L467](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L413-L467)                                                                                                                                                                                                                                   |
| Context          | Approximate tokens from character count; prune large tool results first; retain tool-call boundaries; structured model summary; only replace history when summary is smaller; bounded context-overflow recovery | [L931-L971](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L931-L971), [L1045-L1183](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1045-L1183), [L1437-L1465](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1437-L1465) |

## Ideas worth borrowing

These are design inferences from the inspected source, not claims of absent Cognia functionality.

1. A deliberately small execution profile: a persistent shell and precise text editing can cover provisioning/coding tasks with little startup infrastructure. The distinctive opportunity is a remote/bootstrap entry point, not porting a desktop app into Bash. [Two schemas, L899-L928](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L899-L928).
2. Explicit shell lifetime as part of the tool contract: retain ordinary state, but tell the model when timeout/interrupt has reset it. [L656-L719](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L656-L719).
3. Completed-turn checkpointing and fail-closed streaming assembly are useful acceptance criteria: incomplete responses must not dispatch tools, and persisted conversations must remain protocol-valid. [L1272-L1389](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1272-L1389), [L1517-L1547](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1517-L1547).
4. Layered context recovery: deterministic tool-output pruning before paid summarization, keep assistant/tool exchanges together, reject ineffective summaries, bound overflow retries. [L947-L971](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L947-L971), [L1090-L1183](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1090-L1183).

## Adoption constraints and traps

- **Bash 4.3+ is a real dependency**, checked at startup. A system with older Bash cannot use it directly. Despite the two-dependency headline, persistence/setup/transport also invoke ordinary OS utilities such as `chmod`, `mv`, `rm`, and `mktemp`. No Node/Python/jq dependency is present. [L42-L45](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L42-L45), [L189-L255](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L189-L255), [L973-L1010](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L973-L1010).
- **Permission integration is absent**: shell commands and absolute-path editor operations execute directly with host permissions. No approval broker, filesystem boundary, sandbox, PII gate, or plugin/MCP protocol exists in the tracked script. This makes direct app embedding materially different from reusing an idea. [L640-L653](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L640-L653), [L869-L894](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L869-L894), [L1488-L1507](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1488-L1507).
- **Credential behavior should not be copied into Cognia**: setup rewrites the key into `d.sh`; mode 600 is the protection. Passing Bearer auth via curl stdin avoids exposing it as a curl argument, but there is no app vault integration. Plain HTTP endpoints are accepted. [L189-L255](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L189-L255), [L325-L349](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L325-L349), [L985-L991](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L985-L991).
- **Interrupted multi-tool turns need scrutiny**: static inspection shows results are appended one by one; on interrupt the turn returns immediately, but interactive mode continues without rolling back/reconciling all pending calls. A later prompt can therefore reuse an in-memory assistant message whose remaining tool calls lack results. Manual compaction also saves current history. This is a potential protocol/recovery defect, not a runtime reproduction. [L1536-L1542](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1536-L1542), [L1145-L1147](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1145-L1147), [L1575-L1606](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1575-L1606).
- **Editor mutation is not transactional**: replacement/insertion write directly to the file, without compare-and-swap, atomic replacement, or undo. Session atomic rename has no concurrent-writer lock. These are limits of this tiny runtime rather than app-ready persistence semantics. [L822-L867](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L822-L867), [L416-L442](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L416-L442).
- **Compatibility is narrower than general OpenAI compatibility**: always emitting DeepSeek extensions means an arbitrary compatible endpoint may reject the request. No capability negotiation is present. Default million-token context and character-based estimation are heuristics, not discovered model limits. SSE handling assumes each `data:` line is an independent JSON chunk. [L931-L945](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L931-L945), [L1012-L1020](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1012-L1020), [L1342-L1357](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/d.sh#L1342-L1357).
- **License needs clarification before copying/distribution**: there is no LICENSE file or explicit license grant for this independent repository at the inspected SHA. References to MIT describe the official Harness and adapted material; they do not establish an explicit license for all independent code. Preserve attribution and resolve provenance before vendoring. [Acknowledgements](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/README.md#L87-L89), [snapshot tree](https://github.com/SiriusNEO/d.sh/tree/f8b8ff864694624fe86157004e484f25e0397a3a).

## Maturity and verification boundary

No committed tests, CI workflow, release artifact, package manifest, or benchmark exists in the inspected four-file tree. `.gitignore` mentions `dsh-test.sh`, so the repository may have private/local tests; their existence, contents, or results cannot be established from the tracked source. [Snapshot tree](https://github.com/SiriusNEO/d.sh/tree/f8b8ff864694624fe86157004e484f25e0397a3a), [.gitignore](https://github.com/SiriusNEO/d.sh/blob/f8b8ff864694624fe86157004e484f25e0397a3a/.gitignore).

The code is useful as a compact reference and bootstrap concept. Its tiny dependency footprint is the main differentiator. A direct production dependency would bring a second transport/parser/tool/session implementation while requiring additional permission, identity, credential, recovery, observability, and integration work. The actual Cognia overlap must be determined from current Cognia source before proposing changes.

## Current Cognia comparison

Cognia baseline: `6c7de49f525d23aca58f4eb1cac143349bf6a353`, plus the shared working tree as inspected on 2026-09-30. Many unrelated files were already modified. Only this research document was authored for this request; application and runtime source were left unchanged.

| d.sh idea                            | Current Cognia evidence                                                                                                                                                                                                                                                                                                                                                                  | Adoption decision                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small two-tool runtime               | `runtime/deepseek-harness/README.md:3` describes the official product launcher and minimal bundle, with managed read-only, workspace, and ACP profiles. `lib/ai/agent/agent-executor.ts:409` already translates explicit tool grants.                                                                                                                                                    | Reuse a restricted profile/grant. A second provider loop, Bash parser, or external-agent protocol is unnecessary.                                                                                                                                                                                 |
| Persistent shell                     | `sidecar/src/tools/builtin/terminal-repl/index.ts:3` already provides a private persistent PTY; `sidecar/src/tools/builtin/registry.ts:106` registers it when enabled. `sidecar/src/tools/builtin/core-files/bash.ts:304` instead spawns a process for each foreground command.                                                                                                          | Persistent state exists, but it is not the contract of ordinary `bash`. An optional session shell facade could improve ergonomics; retain ownership, approval, sandbox, termination, and platform handling.                                                                                       |
| Tool-exchange-aware compaction       | `sidecar/src/context/compaction.ts:273` slices by message count. `sidecar/src/context/strategies.ts:126` drains tail messages individually and `:166` chunks by count. `sidecar/src/context/tool-message-pairing.ts:48` repairs unmatched parts; `sidecar/src/runtimes/ai-sdk/index.ts:863` calls it before sending.                                                                     | A verified improvement opportunity: plan around complete exchanges rather than dropping results after a split. Extend the existing planner and strategies.                                                                                                                                        |
| Prune before summary                 | `sidecar/src/runtimes/ai-sdk/compaction.ts:379` generates summaries; `:411` caps results afterward using `sidecar/src/context/tool-result-cap.ts`. The shell itself already spills oversized full output to a file at `sidecar/src/tools/builtin/core-files/bash.ts:165`.                                                                                                                | Add an age-aware pruning stage before planning and re-evaluate the threshold afterward. Existing output caps do not provide this ordering. Preserve recent results and references to recoverable full output.                                                                                     |
| Structured continuation checkpoint   | `lib/rag/compaction-runtime.ts:89` captures goals, active state, decisions, evidence, blockers, next steps, constraints, and reinjection versions. `lib/rag/compaction-checkpoint.ts:61` encrypts persistence. The AI SDK default summary prompt at `sidecar/src/runtimes/ai-sdk/compaction.ts:31` is shorter and unstructured.                                                          | Already substantially implemented. Align summaries with existing recovery fields if needed; do not introduce a second checkpoint format.                                                                                                                                                          |
| Terminal-first lightweight assistant | `hooks/terminal/use-ai-shell.ts:141`, `components/terminal/ai-shell/ai-shell-panel.tsx:33`, and `lib/terminal/ai-shell/plan-executor.ts:53` provide a hook, panel, and sequential executor. A literal-reference search across `app`, `components`, `hooks`, `lib`, `cli`, and `stores` found no production consumer of `useAiShell` or `AiShellPanel` outside their definitions/exports. | Reuse candidate, not a verified available product flow. Mount and validate the existing modules before creating another panel. An autonomous observe/execute loop would require additional integration with existing agent execution, rather than being delivered merely by mounting the plan UI. |

The current runtime README pins `0.1.5-rc.1` and records its original verification date as 2026-09-12. This review did not re-certify that upstream npm channel. ADR-0120 contains historical claims about the old launcher and session format; current code and runtime documentation take precedence for this comparison. d.sh's own alpha-profile inspiration must not be confused with Cognia's managed runtime release.

## Concrete compaction reproduction

The existing planner was exercised directly with a synthetic, complete history:

```text
system
user: inspect the build
assistant: tool-call build-1
tool: result build-1 = Build failed: missing dependency
assistant: I will fix the missing dependency.
```

Calling `planCompaction` with `keepRecentMessages: 2` places the assistant call in `middle` and its tool result in `tail`. Calling `applyCompaction` with a synthetic summary, then the same `sanitizeToolMessagePairs` used by the send path, produces:

```json
{
  "middleRoles": ["user", "assistant"],
  "tailRoles": ["tool", "assistant"],
  "retainedToolResultsBeforeRepair": 1,
  "retainedToolResultsAfterRepair": 0
}
```

This is a deterministic reproduction against current planner and repair functions. It proves that a count boundary can separate a valid exchange and the subsequent repair removes the recent result. The tool result is outside the summary material in this example. It does not measure the behavior of a live summary model or prove a real user session was affected. d.sh's boundary rewind is useful inspiration; it also needs adaptation for parallel calls, provider-specific message shapes, selective retention, and recursive chunking.

## Terminal execution details to resolve before adoption

Static inspection found two issues in the currently unconsumed AI Shell modules:

- `hooks/terminal/use-ai-shell.ts:118` reports exit code `0` after five seconds when integration events are unavailable. That is a timer, not evidence the command succeeded. A reused terminal assistant must report an unknown result or obtain a real exit signal.
- `lib/terminal/ai-shell/plan-executor.ts:89` responds to abort by resolving its wait as cancelled; `hooks/terminal/use-ai-shell.ts:373` aborts that controller. Neither sends a process-stop request in these paths. A cancelled plan must distinguish stopping observation from actually terminating the foreground command.

d.sh attempts explicit command completion and process-group reset, which are useful behavioral requirements. Its own interrupted multi-call recovery is incomplete by static inspection, so its cancellation implementation should not be treated as a complete reference solution. Terminal state survives ordinary commands but may be lost on reset; that must be made visible to the agent.

## Supporting improvements and acceptance checks

1. **Preserve complete tool exchanges during compaction.** Extend `context/compaction.ts` and `context/strategies.ts`, retaining the pairing sanitizer as a defensive final check. Verify that calls and results stay together across count boundaries, token draining, parallel calls, selective retention, and recursive chunks; recent results must remain available after repair. Preserve frozen-summary behavior and existing strategy contracts.
2. **Prune old tool results before summary.** Extend the existing cap/planning/orchestration boundary. Preserve tool identities, errors, recent state, and full-output references; re-evaluate the trigger after pruning. Measure input tokens and paid summary calls on a fixed transcript, and verify an agent can retrieve omitted output. No performance gain is claimed until measured.
3. **Productize the existing terminal assistant if desired.** Wire the current panel/hook to the terminal session and governed execution path, repair completion/cancellation semantics, then validate local, remote, and unavailable-integration cases. A restricted tool profile belongs in existing permission resolution. Desktop/host verification is required; component tests alone do not establish command control.
4. **Consider a bare-server bootstrap entry only for a concrete remote-provisioning need.** d.sh's small dependency footprint is useful there. Such an entry still needs versioned artifacts, credential handling, real completion status, and a handoff to the normal Cognia runtime. There is no demonstrated need to ship it as another desktop agent runtime.

Source copying/distribution is not part of these recommendations; the repository snapshot has no explicit license grant for its independent code. The design ideas can be implemented in existing Cognia modules without adopting its hand-written parser, self-modifying credential storage, or ungoverned execution path.

## Checks run for this review

```sh
rtk node scripts/test/run-sidecar-tests.mjs \
  sidecar/src/context/compaction.test.ts \
  sidecar/src/context/strategies.test.ts \
  sidecar/src/context/tool-result-cap.test.ts \
  sidecar/src/context/tool-message-pairing.test.ts
```

Result: **43 tests passed, 0 failed** across four test files. A separate read-only Node probe produced the split-and-drop result above. Existing tests passing does not disprove that additional behavior gap. No coverage, full typecheck/build, desktop E2E, upstream execution, paid model call, or performance benchmark was run.

## Implementation — 2026-10-01

The approved bootstrap utility is implemented as `crates/cognia-bootstrap-agent`,
with `cognia-bootstrap run` for standalone tasks and `init` for deterministic
setup plus adaptive repair and independent readiness checks. The project
environment manager persists optional bootstrap configuration and reuses native
execution, keyring references, initialization history and setup fingerprints.
The executable is staged as a desktop sidecar and as a static core bundle tool,
available before the full Node Agent runtime. The implementation is original;
no upstream d.sh source is copied. See the crate README for the complete CLI,
limits, credential boundary and Unix platform contract.

### Verification — 2026-10-01

| Check                                 | Observed result                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Standalone Rust unit/loopback suites  | `cargo test --locked -p cognia-bootstrap-agent`: 41 passed                                                                                                                     |
| Frontend/environment/transport suites | 8 Jest suites, 136 passed                                                                                                                                                      |
| Staging + workflow contracts          | 43 Node tests passed, including actual target-specific file copying                                                                                                            |
| Native shell/environment source tests | 13 passed in a temporary narrow harness loading the actual changed sources; credential adapter stub refuses all access                                                         |
| Rust lint/build                       | Scoped Clippy with `-D warnings`, rustfmt, optimized release build passed                                                                                                      |
| Desktop binary staging                | `bootstrap-agent:prepare` staged the target-suffixed macOS sidecar                                                                                                             |
| Release CLI smoke                     | Loopback mock provider, real shell + editor repair, readiness, handoff exit7, state reuse without model credential, missing-key failure, SIGTERM grandchild cleanup all passed |
| Runtime independence                  | PATH limited to `/usr/bin:/bin`; no Node present, binary4,859,312 bytes, only macOS system frameworks/libraries linked                                                         |
| Frontend gates                        | Scoped ESLint/Prettier, generated locale checks, ICU/parity/key reference/sort checks passed                                                                                   |
| Architecture/gate wiring              | Rust architecture and verification registry passed                                                                                                                             |

The global TypeScript check completed but failed on four unrelated diagnostics in
Lark refresh fixtures, workflow publication and an unavailable `sharp` import.
Bundle pin validation is blocked by the concurrently added Goose runtime not
yet classified in bundle pins. The full Companion Cargo test build hit disk
exhaustion; the focused source harness above does not establish whole-crate or
Tauri acceptance. Docker daemon was unavailable, so Linux static image builds,
container smoke, real Tauri settings UI and authenticated provider acceptance
remain unverified. No production credentials, login files, commits or pushes
were used.

# Evidence ledger: runner agent selection

- Status: verifying
- Lane: standard
- Created: 2026-10-21
- Updated: 2026-10-21
- Related: ADR-0182, ADR-0183; deploy/runner; deploy/bundle

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 按这个方向进行对抗审查，确保是合理的，先把现有 Runner 和 bundle 的执行链路梳理清楚，再实现按需选择 Agent、固定版本和自定义镜像，保留 Full 镜像作为兼容选项，并验证实际运行。

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                              | State       | Basis                                                                        | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------- | ---------- |
| O1  | Legacy Runner passes CLI command/args into its image; pool resolves against bundle probe commands.                     | Verified    | container_backend.rs, sandbox-pool/command.rs; source 2026-10-21             | -          |
| O2  | At task start Runner Full used floating npm versions; bundle already has exact pins and integrity-locked dependencies. | Verified    | deploy/runner/install-agents.sh; deploy/bundle/npm; source 2026-10-21        | -          |
| O4  | Docker recovered after explicit user restart authorization; the three local-auth services returned healthy.            | Verified    | Docker restart and ps 2026-10-21; traex-bridge restart loop predated restart | -          |
| O3  | Docker daemon is reachable on local ARM64; no existing bundle image is loaded.                                         | Observed    | docker info/image ls 2026-10-21                                              | -          |
| H1  | Filtering manifest alone meaningfully reduces installed CLI content.                                                   | Invalidated | Full npm ci precedes stage; reviewer confirmed dependencies remain           | O1         |
| H2  | A shared selected set can prune the locked dependency closure and keep truthful commands.                              | Verified    | Offline npm prune spike: Codex lock 367 to 8 package entries; worker tests   | O2         |
| G1  | Trace both paths; implement selected Agents, fixed versions and custom images; retain Full and verify real execution.  | Agreed      | User request 2026-10-21                                                      | -          |
| C1  | Preserve admission, isolation, manifest v1 and existing Full callers.                                                  | Verified    | ADR-0182/0183 and current implementation contract                            | O1         |
| C2  | Do not modify unrelated shared-tree edits; do not commit or publish this task.                                         | Verified    | Current git status and user scope 2026-10-21                                 | -          |

## Problem frame

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

The problem is unnecessary Agent payload and mutable builds across two independent execution paths (O1/O2/G1). Build-time explicit runtime IDs must determine dependencies, shims, downloads and manifest together. Existing custom-image authority remains in force (C1). Full remains the compatibility default; selected variants are opt-in. Size and latency gains require actual image measurements, not inference from installed package counts.

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                      |
| ------------ | ------ | -------------------------------------------------------------------------------- |
| scale        | medium | Build tooling, Dockerfiles, CI and supervisor staging.                           |
| technical    | medium | npm owns offline dependency pruning; existing bundle stage is reused.            |
| coupling     | high   | Legacy npx differs from bundle command mapping; shared commands and dual libc.   |
| requirement  | low    | User explicitly authorized implementation and validation.                        |
| verification | high   | Real Docker available; remote K8s/E2B and second architecture not yet available. |
| risk         | medium | Reversible artifacts, but incorrect fallback could change execution boundary.    |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                       | Severity | Source             | Claim                                                                | Refuted by                                                    |
| --- | ------------------------------------------------------------------- | -------- | ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| R1  | Excluded CLI is fetched by npx or survives in dependencies.         | high     | reviewer, FMEA     | Selected invocation is offline and selected closure is pruned.       | Excluded CLI executes or download is attempted.               |
| R2  | Manifest claims a CLI missing from image or breaks shared commands. | high     | ADR-0183, reviewer | Same selection drives pins, install scripts, files and manifest v1.  | Advertised command missing; nested dependency version drifts. |
| R3  | Full callers or custom-image isolation regress.                     | high     | ADR-0182, reviewer | Full remains compatible; custom images keep current admission/probe. | Existing default/alias fails; policy bypass appears.          |
| R4  | glibc-only selected runtime fails remote dual-libc staging.         | medium   | reviewer           | Staging remains separate from executable capability.                 | Empty libc tree prevents remote initialization.               |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk        | Method                                                                                               | Independence   | Evidence                                                                                                                                                                                                                                            | Coverage                                                                                                                                                                                                           | Status  |
| --- | ----------- | ---------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| V1  | R1,R2       | Node behavioral tests and immutable-lock checks.                                                     | tool           | recovered-final-node-tests.log: 83/83 passed                                                                                                                                                                                                        | All/shared/unknown/none selections; dependency identities; native npx bypass regression                                                                                                                            | passed  |
| V2  | R1,R2,R3    | Real Docker Runner/bundle/custom-image execution.                                                    | real-env       | recovered-{runner,python,full,bundle,native-selected}-smoke.log: all passed on final ARM64 images                                                                                                                                                   | CLI versions, new/legacy ACP aliases, refusal paths, selected postinstall, Debian/Python/Alpine injection, Git HTTPS                                                                                               | passed  |
| V3  | R3,R4       | Supervisor and pool command/policy regressions.                                                      | tool           | recovered-sandboxd-tests.log: 148/148; pool-command-tests.log: 4/4; source/gate checks passed                                                                                                                                                       | Stage copy safety, empty libc capability, stale removal, command refusal                                                                                                                                           | passed  |
| V4  | R1,R2,R3    | Fresh adversarial review, wiring and deploy gates.                                                   | fresh-reviewer | Reviewer recheck: no actionable issues; deploy-suite, agent-host-image, ESLint, actionlint passed                                                                                                                                                   | Inputs, aliases, custom-image authority and smoke-before-publish                                                                                                                                                   | passed  |
| V5  | R2,R3,R4    | Full/selected architecture and remote-provider execution.                                            | real-env       | Native CI matrices wired; this local verification exercised ARM64 Docker only                                                                                                                                                                       | Native amd64, remote CI and K8s/E2B execution are not verified here                                                                                                                                                | blocked |
| V6  | R1,R3       | Follow-up npx adversarial review and final-base binding.                                             | real-env       | reaudit/node-tests.log: 85/85; container-check.log: three PASS groups; pnpm lint and gates passed                                                                                                                                                   | Empty npm tag rejection, command argument ownership, /usr/bin/npx binding, nullable npm and direct wrapper recursion; 24 offline prune cases passed                                                                | passed  |
| V7  | R1,R2,R3    | Native alias/POSIX paths, dependency cache wiring, CI behavioral checks and rebuilt selected image.  | real-env       | optimization/final-node-tests.log: 88/88; linux-node-tests.log: 13/13; selected-smoke.log and hardened-acp.log passed                                                                                                                               | Actual ARM64 Codex/ACP offline image; selected/omitted empty tags; custom /usr/bin/npx; public native archives match lock SHA512; Full/bundle not rebuilt this round; typecheck explicitly skipped                 | passed  |
| V8  | R1,R2,R3    | Rebuilt default Full with Cursor; bounded offline CLI/ACP execution.                                 | real-env       | full-recheck/full-result.json; full-bounded-smoke.log, full-extra-smoke.log, full-cursor-inventory.log: exit 0                                                                                                                                      | Historical Node 26.8.2 artifact verified; build exited 75 after export/load due disk guard; superseded for current inputs by V9                                                                                    | passed  |
| V9  | R1,R2,R3,R4 | Rebuild current Node 26.12.1 Full and complete dual-libc bundle; actual injection and ACP execution. | real-env       | full-recheck/full-current-result.json and full-bundle-current-result.json; standard smokes and 6 extra bundle ACP cases passed; current source hashes unchanged; current Node tests 46/46; pnpm lint exit 0; final ledger/format/diff checks passed | Linux ARM64, all 11 bundled runtimes, Debian/Python/Alpine, Git HTTPS, refusal 64/68. Bundle used standard stages plus streamed OCI assembly, not the monolithic assemble/COPY command; typecheck skipped by user. | passed  |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                              | Action    | Based on          | Reversal trigger                                                                     |
| --- | ---------- | ------------------------------------------------------------------------------------- | --------- | ----------------- | ------------------------------------------------------------------------------------ |
| D1  | 2026-10-21 | Add opt-in selected artifacts using master lock; keep compatibility Full default.     | implement | O1,O2,H2,C1,C2,G1 | Selection cannot preserve locked dependency identities or existing caller semantics. |
| D2  | 2026-10-21 | Use existing custom-image variables/catalog; no new authority or runtime wire fields. | implement | O1,C1,G1          | Owning runtime requires a protocol change for selection.                             |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual | From | Why still open | Next action | Status |
| --- | -------- | ---- | -------------- | ----------- | ------ |

| X1 | Local Docker acceptance after storage recovery. | R1,R2,R3,V2 | Resolved: authorized restart completed; final selected/custom/Full/bundle and native selected smokes passed. Serial builds and immediate per-case volume release used. | - | closed |
| X2 | Native second-architecture and managed provider acceptance is unverified. | V5 | This round exercised local ARM64 Docker; no remote CI or K8s/E2B execution was performed. | Run the wired native CI and qualified remote-provider environment before rollout. | open |
| X3 | Full retains its documented compatibility exceptions. | R3 | Full global npm has no transitive lock; Cursor optional installer has no verified fixed artifact. | Prefer selected; disable Cursor in Full when exact artifacts are required. | open |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                   | How / when measured     | Result                                                                                                                                                     | Status |
| --- | ---------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Selected image starts exact requested CLI offline and excludes unrelated Agent commands. | Final real ARM64 images | Codex 0.157.1 / ACP 1.13.1; custom Python 3.12.15; bundle glibc/musl injection and refusal cases; selected Claude/OpenCode versions and offline ACP passed | met    |

# Evidence ledger: Pi subagent models

- Status: verifying
- Lane: standard
- Created: 2026-10-21
- Updated: 2026-10-22
- Related: docs/reports/2026-10-22-pi-subagent-models.md

## Original request

> 优先支持 Nico，并兼容本机 Gotgenes，让每个 Pi 自定义 subagent 单独配置模型，保留显式模型，未指定时才用默认子代理模型；仅检测到相关插件时启用；跳过 typecheck

## Knowledge

| ID  | Statement                                                                                                                             | State    | Basis                                                                         | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------- | ---------- |
| G1  | Supported installed Pi plugins expose individual custom-agent models and fallback child models.                                       | Agreed   | User request 2026-10-21                                                       | -          |
| C1  | Skip typecheck and coverage; preserve unrelated shared-tree edits.                                                                    | Verified | User instruction and baseline under .cache/pi-subagent-models                 | -          |
| O1  | Pi projection exports one model; importer discards model hints.                                                                       | Verified | Current gateway-task.ts and subagent-importers/pi.ts 2026-10-21               | -          |
| O2  | Nico 0.80.0 has required-child-extension API; Gotgenes 19.2.2 children read task-global extensions and project agents outrank global. | Verified | Published Nico artifacts, installed Gotgenes sources and independent reviewer | -          |
| O3  | Ticket gateway blocks PII before upstream forwarding.                                                                                 | Verified | crates/cognia-gateway/src/server.rs 1857 and 3263, independent reviewer       | -          |

## Problem frame

Extend the existing gateway plan and native Pi agent Markdown contract. Detect enabled installed supported packages on the execution host, preserve explicit model choices, admit them before launch and apply the shared child default only to omissions. No auto-installation or package upgrade. Success is demonstrated through focused tests and actual Pi processes against local fixture endpoints (G1, O1).

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                   |
| ------------ | ------ | ------------------------------------------------------------- |
| scale        | medium | Detection, model admission, projection, adapter and extension |
| technical    | high   | Two different SDK child extension contracts                   |
| coupling     | medium | Shared model editors and task-home writers                    |
| requirement  | low    | Explicit requested precedence and gating                      |
| verification | high   | Requires real installed Pi/extension process checks           |
| risk         | high   | Child model routing and native-tool permissions               |

## Risks

| ID  | Risk (impact)                                        | Severity | Source | Claim                                                             | Refuted by                                                    |
| --- | ---------------------------------------------------- | -------- | ------ | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| R1  | Incorrect detection activates unsupported plugin     | medium   | O2     | Only recognized installed enabled versions activate               | Missing/disabled/stale package activates                      |
| R2  | Explicit child model silently becomes parent/default | high     | O1, O2 | Exact explicit models enter lease/catalog and remain effective    | Project-agent fixture records wrong model                     |
| R3  | Child bypasses gateway or tool gate                  | high     | O2, O3 | Supported child calls retain gateway routing and Cognia extension | Denied child tool runs or unredacted request reaches upstream |

## Verification obligations

| ID  | Risk   | Method                                   | Independence   | Evidence                                                                                                                                                                     | Coverage                                                                                                     | Status |
| --- | ------ | ---------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| V1  | R1     | Detection/slot/editor tests              | tool           | Focused Jest: 16 suites, 1041 passed and 1 skipped; detection, model-slots, editor, host config and adapter tests                                                            | Missing, disabled, conflicting, unsupported, removed and valid packages                                      | passed |
| V2  | R2     | Plan/projector/import tests              | tool           | Focused Jest model-plan, projector, importer and pure routing suites; manager admission in both context cwd fields                                                           | Explicit, inherited, omitted, invalid, cross-provider and catalog models                                     | passed |
| V3  | R2, R3 | Native Pi subprocess fixture             | real-env       | .cache/pi-subagent-models/native/2026-10-21T16-00-29.935Z/report.json: both passed on real Pi 1.3.0                                                                          | Explicit/default/inherit/provider alias/project/global-only call override/background and denied native write | passed |
| V4  | R3     | Source audit and relevant gateway checks | fresh-reviewer | pi_child_gate_review and pi_model_wiring audits; precedence/cwd/workflow/save blockers fixed; extension staging 13 passed and pin check passed; gateway gate source reviewed | Required-child seam, task-global guard, existing final gateway boundary and wired save/admission             | passed |
| V5  | R1, R2 | Scoped lint/format and model regressions | tool           | Scoped ESLint zero warnings; Prettier; Rust formatting; 12 Rust gateway task tests; lint:i18n; Pi JS build with --no-dts                                                     | Changed paths; no pnpm typecheck or coverage                                                                 | passed |

## Decisions

| ID  | Date       | Decision                                                                                                            | Action    | Based on           | Reversal trigger                                |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------- | --------- | ------------------ | ----------------------------------------------- |
| D1  | 2026-10-21 | Reuse model-plan and native Markdown model fields; support verified Nico 0.80.0 and local Gotgenes 19.2.2 contracts | implement | G1, C1, O1, O2, O3 | Native fixtures contradict precedence or guards |

## Residual risks

| ID  | Residual | From | Why still open | Next action | Status |
| --- | -------- | ---- | -------------- | ----------- | ------ |

| X1 | Live provider, ticket-gateway and Tauri/VM/device end-to-end acceptance not performed | V3 | Actual executors used a loopback model fixture; gateway gate was reviewed at source | Validate on a connected host with a live provider when that acceptance is required | open |
| X2 | Gotgenes has no public required-load contract for corrupted child loaders | R3 | Native proof covers healthy guard load and denied tools, not arbitrary loader failure | Re-evaluate when Gotgenes exposes an enforceable child-load contract; do not broaden supported versions silently | open |
| X3 | Browser host-connected control validation unavailable | V1 | Agents page renders, but browser had no connected execution host; conditional UI is covered by component tests | Repeat detected-package settings flow on a connected host | open |
| X4 | Broad Jest run logs a worker teardown warning | V5 | Final run exits 0 with all focused suites passing; diagnostic run was interrupted, not counted | Isolate remaining suite teardown handles separately without claiming diagnostic success | open |

## Outcome

| ID  | Signal                                                                 | How / when measured                                                 | Result                                                                                                             | Status |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| M1  | Each supported custom Pi agent actually uses explicit or default model | Actual Pi requests on 2026-10-22 local time plus 1041 passing tests | Both plugin families used review/default/primary/search as required, foreground and background guard denied writes | met    |

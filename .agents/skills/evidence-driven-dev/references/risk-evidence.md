# Risk & evidence discovery

Goal: derive **verification obligations** from risks, not from the feature list,
before implementation starts. Someone who doesn't know a domain cannot write its
test plan, so the plan has to come from losses, a system model, and independent
knowledge sources. The output is the Risks and Verification obligations tables.

```
unacceptable losses + system model
        → systematic risk discovery (catalog · ADRs · history · lens · fresh reviewer)
        → claims (what the design promises) + assumptions
        → falsifiable obligations (what would refute each claim)
        → evidence + residual risk
```

## 1. Start from losses, not features

Ask (or confirm) what must **not** happen. That is a value question for the
user: "losing a user's chats is unacceptable; a slower first sync is fine." Then
sketch the system model: the components the change touches, who controls what,
and where data and authority cross a boundary. Five lines is enough. Name the
modules from the Subsystem Map.

## 2. Use independent sources

Your own brainstorm shares the blind spots of your own design. Pull risks from
at least two sources that are **not** you, and name the source in each R row:

1. **The cognia risk catalog** (below): traps this repo has actually hit.
2. **The touched ADRs**: their invariants, "Consequences" and rejected
   alternatives are pre-written risks.
3. **History**: `git log --oneline -i --grep='fix\|revert' -- <touched paths>`
   shows how this area broke before.
4. **Incident memory**: the user's memory notes on traps, pending smokes, and
   environment gotchas for this subsystem.
5. **A lens** chosen by the shape of the change (table below).
6. **A fresh-context failure hunt**: dispatch a subagent with the *problem
   model and system model only*, not your design or reasoning, asking "list
   the ways a change here could cause the unacceptable losses". It sees the
   problem without being anchored on your solution.

`ledger.mjs check` warns when every risk's source is your own brainstorm.

## 3. Lens picker

Use one or two that fit. Each is a prompt for systematic coverage, not a
ceremony.

| Change shape                                                                 | Lens                              | What it makes you ask                                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Crosses a trust boundary (pairing/companion, plugin API, share links, connectors, browser extension, IdP) | STRIDE                            | Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege, per boundary         |
| Auth, sessions, tokens, crypto, input handling                               | OWASP ASVS (relevant chapter)     | The mature checklist for that control instead of a reinvented one                                                        |
| An agent/automation/scheduler controls actions                               | STPA (unsafe control actions)     | Action not given when needed · given when unsafe · wrong timing/order · stopped too soon / applied too long              |
| A component or pipeline with distinct parts                                  | FMEA                              | Per part: failure mode → effect → how we'd detect it → severity                                                          |
| Quality-attribute trade-offs (latency, availability, cost, storage)          | ATAM-style scenarios              | "When X happens under load Y, response must be Z": sensitivity and trade-off points                                      |
| Services, deploy, sync servers                                               | Well-Architected reliability/ops  | Failure isolation, recovery, observability, change management                                                            |
| Concurrency, distribution, resumption                                        | Failure injection checklist       | Duplicate delivery, reordering, partial writes, crash between effect and record, clock skew, partition                   |

## 4. The cognia risk catalog

Risks this repo has hit before, each with the check that already exists for it.
When a row applies, its check is the default obligation. Reuse it rather than
writing a new one.

| Risk (when the change…)                                         | Existing check (agent / skill / gate)                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| adds code that is never mounted/registered/called               | `wiring-auditor`                                                                                                   |
| needs a server, Node built-in, or server-only dep in bundled code | `static-export-auditor`; `pnpm build` (static export)                                                              |
| sends locally derived text to a model/embedding/cloud           | `pii-gate-auditor`; route through `hasNoLeakingPii` (`packages/redact/`)                                           |
| changes the Dexie schema                                        | `dexie-migration`; `pnpm audit:data-governance`                                                                    |
| touches Rust async/locks/commands/serialization                 | `tauri-rust-reviewer`; `cargo test`; `pnpm audit:rust-architecture`                                                |
| adds user-facing strings                                        | `i18n-reviewer`; `pnpm lint:i18n`; `pnpm i18n:build:check`                                                         |
| adds source without a co-located test                           | `test-gap-auditor`; `pnpm audit:colocated-tests`                                                                   |
| behaves differently across browser / Tauri / Capacitor         | `tauri-smoke`; device run on the Android test phone; `run` for the browser                                          |
| changes a companion/paired-host response shape                  | `pnpm companion-api:check`. **Known gap:** it misses new Rust fields, so pair it with a paired-client run             |
| changes the plugin SDK / author-facing contract                 | `pnpm plugin:contract:check`; `pnpm author-types:check`; `pnpm plugin:author-imports`                              |
| changes sidecar layering or imports                             | `pnpm sidecar:typecheck`; `pnpm audit:sidecar-architecture`                                                        |
| opens a new network egress path                                 | `pnpm audit:network-egress`; proxy config under `crates/cognia-net/`                                               |
| changes what an agent run may do                                | per-run grants (ADR-0198), never by editing resolved `SendOptions`; `pnpm audit:agent-capabilities`                |
| makes an agent run reach a runtime risk surface (external send, computer use, native command, destructive data, credentials, broad file write) | classify it in `lib/policy/risk/` (ADR-0070) so ceremony applies |
| runs while other sessions edit the same checkout                | `concurrent-tree-safety`                                                                                           |
| anything else gate-shaped                                       | `pnpm gates:registry` / `scripts/gates/check-all.mjs` list every registered gate                                   |

The catalog is a floor, not a ceiling. The Subsystem Map's "Cross-cutting
hooks" section in `CLAUDE.md` lists more reuse-or-break seams.

## 5. Claims → falsifiable obligations

For each medium/high risk, write the **claim** the design makes and the
**refuting observation**:

```
R2  Resumed run re-executes a completed tool call → duplicate IM send (high)
    Claim:      resume never re-runs a tool whose result was persisted
    Refuted by: a run killed after the tool returns but before the turn commits
                re-sends the message on resume
```

"Refuted by" is the important column. If you cannot say what would prove the
claim false, the claim is a vibe and cannot be verified.

Then pick obligations whose **strength matches the severity**:

| Obligation kind                       | Typical independence | Fits                                                        |
| ------------------------------------- | -------------------- | ----------------------------------------------------------- |
| unit / integration test               | tool                 | logic, contracts, regressions                               |
| property / fuzz / fault-injection     | tool                 | invariants, crash windows, duplicate/out-of-order delivery  |
| static rule / gate                    | tool                 | layering, reachability, egress, i18n, schema governance     |
| spike / experiment                    | tool / real-env      | feasibility, performance, platform behavior                 |
| real-environment smoke                | real-env             | shells, devices, real providers, deployed services          |
| fresh-context adversarial review      | fresh-reviewer       | design claims a tool cannot check (`doubt-driven`)          |
| cross-model review                    | other-model          | high-stakes design or security reasoning (`codex-agent`)    |
| human / domain review                 | human                | value calls, security sign-off, irreversible migrations     |

A high risk should not be discharged by `self` alone. Formal proof is not
required: an experiment, an architectural constraint enforced by a gate, or a
fault-injection test is often the right strength.

## 6. Obligations are under change control

Write obligations **before** building, while you don't yet know which ones
your implementation will pass. Afterwards:

- never weaken or delete an obligation *because it failed*. Change it only
  with a stated reason (a D row or a note in the obligation), and treat it
  like changing a test to make it pass;
- if an obligation can't run here (no device, no key, disk full), mark it
  `blocked` and carry it to Residual risks. Don't quietly drop it;
- if the obligation set turns out wrong (it tests the wrong property), that is
  a finding about the risk model: revise the R row first, then the obligation.

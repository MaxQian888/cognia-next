# Complexity discovery

Goal: a **complexity profile** that says how hard this is along six independent
dimensions, with "unknown" allowed. It also defines the smallest spikes that
would turn the unknowns that matter into knowns. The profile is revised
whenever new evidence arrives, not estimated once.

## The six dimensions (rate each separately; never add them up)

A change can be tiny to write and very hard to verify, or large but routine.
A single "7/10" hides exactly the dimension that will hurt.

| Dimension    | Question                                                   | Signals in this repo                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scale        | How much work, how many integration steps?                 | Number of layers touched: Next UI → `lib/` → `sidecar/` → `crates/` → `src-tauri/` → `mobile/` → `services/`; generated artifacts that must be regenerated (i18n aggregates, author types, contract mirrors)                |
| technical    | Is any part novel or immature?                             | New crate/dependency, unfamiliar protocol or platform API, first use of a capability in this codebase, behavior only documented upstream                                                                               |
| coupling     | What else moves when this moves?                           | The three shells (browser / Tauri / Capacitor) sharing `out/`; paired host ↔ companion clients; sync protocol and frozen vectors; plugin SDK `catalog.json` mirrors; Dexie schema; wire formats shipped to installed clients |
| requirement  | Is the expected behavior still disputed or moving?         | Open value questions, Contested goals, a frame the user has not confirmed                                                                                                                                             |
| verification | Can correctness be judged reliably, and where?             | Headless jest/cargo test is enough → low. Needs the real desktop shell, a phone, a real provider key, a server box, or another person → high. These are the "smoke pending" items that pile up in memory                |
| risk         | What does a mistake cost, and can it be undone?            | Installed clients, IndexedDB/keyring layout, published SDK/protocol, external sends, data deletion, credentials; see ADR-0070 risk surfaces                                                                          |

Write a reason for every rating. For **unknown**, write what would resolve it
("unknown: haven't read how resume reloads tool state in
`lib/ai/agent/recovery/`").

## Unknown is a valid state

Before reading the owning code, its callers, and its runtime environment,
"unknown" is the honest answer for scale and coupling. Reporting
"I can't size this yet because X is unexplored" is correct engineering. A
confident number at that point is a guess dressed as an estimate.

Resolving an unknown is usually cheap: delegate a read-only sweep to an
`Explore` agent (haiku) or the matching `analyze-*` agent, and give it the exact
question ("which modules persist tool-call results, and does resume re-execute
them?"). Record the answer as O items with Basis.

## Spikes: buy the information that changes the route

When an unknown could change the technical route, run a bounded spike before
committing to a plan. A spike is defined by its question, not its activity:

```
SPIKE  question:   Can a single-process run persist and restore enough state to resume?
       why it matters: if no, checkpointing is off the table and the design changes
       budget:     ~30 min / one throwaway worktree
       success:    a resumed run continues from step N without re-running step N-1's tool
       kill:       state lives in closures we can't serialize → stop, record Invalidated
       location:   `git worktree add` scratch tree or `mattpocock-skills:prototype`
```

Rules:

- **One unknown per spike**: pick the unknown most likely to change the route.
- **Value-of-information test**: if no possible spike outcome would change the
  next decision, skip the spike and decide.
- **Spike code is not product code.** It answers a question and is thrown away.
  Never "just keep" it: rebuild under the normal gates.
- The result goes in the ledger as evidence (O/H state changes) and a D row.
- Respect the shared tree (`concurrent-tree-safety`). Spikes belong in a
  separate worktree, not this checkout.

## Re-estimate triggers

Revisit the profile, not just the plan, when any of these happens:

- an unexpected dependency, caller or second consumer turns up;
- a test fails for a reason outside the change you made;
- a platform/permission limit appears (sandbox, ACL, capability, store policy);
- the user changes the goal, or a value question gets answered differently;
- the change starts touching a coupling surface from the table above.

A rating that moves up a level is a checkpoint. Decide again (SKILL.md
decision table); don't silently absorb the extra scope.

## Reducing complexity is a design option

Before accepting a high rating, ask whether the design can lower it:

- narrow the scope to the part whose correctness you can demonstrate now;
- reuse an existing mechanism instead of a new protocol (Hard Rule 1);
- isolate behind a flag, a sandbox, or least privilege;
- make side effects idempotent or authorization-gated;
- ship incrementally with a rollback path.

Understandability and verifiability are quality attributes of the design. An
AI can produce a more intricate design; that does not oblige anyone to accept
it.

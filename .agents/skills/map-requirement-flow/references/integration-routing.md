# Integration routing

Use this reference only when the Requirement Flow needs an adjacent workflow. Check the skills and tools available in the
current session before naming or invoking one. If a listed capability is unavailable, continue locally when safe or state
the missing capability; never fabricate an invocation.

## Routing principles

1. Keep `map-requirement-flow` as the owner of behavioral completeness and traceability.
2. Invoke the smallest adjacent workflow that resolves the current uncertainty or produces the requested artifact.
3. Pass stable Requirement Flow IDs and evidence status into every handoff.
4. Require explicit user scope before creating files, issues, prototypes, tests, code, or remote artifacts.
5. Reconcile returned decisions into affected `REQ-*`, `HP-*`, `BR-*`, `SC-*`, `DEP-*`, and `GAP-*` entries.

## Upstream and decision support

| Need | Preferred skill or capability | Pass back into the flow |
|---|---|---|
| Direction is still unclear or may not be worth pursuing | `idea-refine` | Recommended direction, rejected alternatives, assumptions, minimum validation |
| Current external/product facts are uncertain | `research` or authoritative web/docs tools | Sources, date/version, confirmed facts, residual uncertainty |
| Expensive ambiguity requires structured challenge | `grilling`, `grill-me`, or `grill-with-docs` when available | Decisions, constraints, rejected options, unresolved questions |
| A non-trivial decision needs adversarial review | `doubt-driven` | Failure modes, counter-evidence, revised recommendation |

Do not force an interview when available evidence supports a reversible assumption. Do not use brainstorming to replace a
clear requirement.

## Repository and product evidence

| Evidence needed | Preferred capability | Usage boundary |
|---|---|---|
| Symbols, callers, dependencies, blast radius | Repository structural graph when `.codegraph/` and `codegraph_*` tools are available | Trust the graph for structure; do not duplicate with broad grep |
| TypeScript/JavaScript definitions and references | Language-server tools when available | Use for symbol-accurate navigation and diagnostics |
| Literal labels, routes, filenames, IDs | `rg` / `rg --files` | Use after scope is known; avoid broad structural inference |
| Current Next.js behavior | Repository-bundled Next.js docs plus `next-best-practices` when applicable | Follow the installed version, not memory |
| Observable UI and cross-surface behavior | Browser automation, `agent-browser`, or the applicable E2E skill/tool | Read-only inspection does not authorize product changes |
| Lark-hosted source requirement or decision record | Matching `lark-doc`, `lark-wiki`, `lark-base`, `lark-minutes`, or other Lark skill | Read the full source; external writes require explicit request |

Follow current repository instructions when they prefer a narrower tool or evidence source.

## Design and specification handoffs

| User wants next | Preferred skill | Handoff contract |
|---|---|---|
| Test an interaction or state-model uncertainty cheaply | `prototype` | Target `HP/BR` IDs, hypothesis, decision to resolve, disposable scope |
| Define deep module or interface boundaries | `codebase-design` | Flow owners, contracts, states, failure/recovery requirements |
| Produce a product requirements document | `to-prd` when its publication behavior is desired and authorized | Full traceability matrix, goals, non-goals, success criteria, open decisions |
| Produce a Cognia implementation-accurate technical proposal | `cognia-tech-proposal` | System map, `Existing/Change/New/TBD`, dependencies, gaps, criteria |
| Draw a review-grade architecture or flow visual | `lark-arch-diagram` or the current diagram capability | Authoritative IDs, actors, states, edges, exception semantics |

The Requirement Flow remains the behavioral source for these handoffs unless the repository declares a different canonical
artifact.

## Delivery, validation, and governance handoffs

| User wants next | Preferred skill | Handoff contract |
|---|---|---|
| Map behavior to Cognia E2E coverage or implement E2E | `cognia-e2e` | Entry, action, observable outcome, diagnostic signal, `HP/BR/SC` IDs |
| Add an approved journey to the canonical Cognia path model | `cognia-user-path-mindmap` | Approved topology, roles, loops, retries, priority/spec ownership |
| Break approved scope into independent issues | `to-issues` | Requirement IDs, dependency graph, acceptance criteria, verification seams |
| Implement approved work | `implement` or the task-specific implementation skill | Approved flow version, system ownership, branches, criteria, non-goals |
| Audit a resulting Cognia code change before completion | `preflight` | Changed files, mapped criteria, known gaps, applicable platform risks |

Use `cognia-user-path-mindmap` only after the requirement topology is approved; it governs source-controlled journey
artifacts rather than discovering product intent. Use `cognia-e2e` to decide the owning test layer; do not turn every flow
step into a browser E2E.

## Publishing and remote writes

- Use the matching Lark skill when the user explicitly requests a Lark document, wiki update, Base record, whiteboard, or
  other remote artifact.
- Keep the local or conversational Requirement Flow canonical unless the user names another source of truth.
- Confirm the target before destructive replacement or whole-document overwrite.
- Fetch back and verify remote content after writing when the invoked skill requires it.

## Handoff payload

Pass this minimum payload to any downstream workflow:

```text
Flow title and version/date
Scope and non-goals
Confirmed / Inferred / Assumed / Open evidence
Affected REQ-* IDs
Happy Path HP-* IDs
Branch BR-* IDs, including recovery
Success criteria SC-* and verification seams
Dependencies DEP-*
System ownership and Existing / Change / New / TBD status
Journey gaps GAP-* and severity
Open decisions Q-* and recommendation
Requested downstream artifact and authorization boundary
```

If the downstream workflow changes a goal, branch, terminal state, or criterion, update the Requirement Flow before using
it to authorize further work.

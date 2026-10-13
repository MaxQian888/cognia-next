# Runtime library plugins share RPC contracts and consumer-owned JS modules

| Field         | Value                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Status        | Implemented; scoped checks passed; unrelated baseline diagnostics recorded                               |
| Author · Date | Codex · 2026-10-13 · Asia/Shanghai                                                                       |
| Scope         | Plugin manifests, dependency resolution, IPC, loader/lifecycle, SDK, Python mirror, author documentation |
| Source        | User request; [GitHub Comment Bot plan §18](./2026-10-12-github-comment-trigger.md)                      |
| Working tree  | Shared `dev`; preserve concurrent changes and do not switch branches                                     |
| Delivery      | `cognia-next` minor changeset; no release or deployment requested                                        |

## 1. One installable plugin can provide two explicit forms of reuse

Add a declarative library contribution to the existing plugin manifest. A library remains independently installable and loadable, and can retain ordinary plugin contributions. Consumers declare required plugin dependencies and use either schema-checked IPC RPC or an asynchronous import that returns real JavaScript exports.

RPC executes in the provider's context; a directly imported JS module executes with a consumer-owned context and instance. Neither path transfers provider permissions to the consumer. The existing dependency graph owns ordering and lifecycle protection. The service registry remains availability metadata rather than becoming a second invocation system.

The ten confirmed decisions below define the product behavior. Supported consumers are ordinary frontend/hybrid JavaScript plugins, including those hosted by CLI/headless, and Python RPC clients. Isolated Node sandbox plugins and WASM explicitly reject the new capabilities. The user confirmed the complete design and authorized implementation on 2026-10-13. Verification results are recorded separately; this plan alone is not test evidence.

## 2. Confirmed decisions determine the compatibility contract

| Decision          | Confirmed choice                                                                | Consequence                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1 Versioning     | One installed version per plugin ID; methods version with the plugin            | `dependencies` constrains provider `version`; incompatible requirements block activation; complete semver range checking is required       |
| Q2 Loading        | Automatically activate installed required dependencies in order                 | Missing, incompatible, or cyclic dependencies block consumers; never download missing libraries automatically                              |
| Q3 Authority      | Dependencies establish eligibility, not permission grants                       | Consumers need `ipc:call`; providers need `ipc:expose` for RPC; both independently hold method `requiredPermissions`; re-check at dispatch |
| Q4 Execution      | Support RPC and direct runtime JS imports                                       | No migration of `packages/github-bot-kit`; it remains build-time sharing                                                                   |
| Q4a JS context    | Each consumer receives an independent module instance using its guarded context | Never return the provider's activated exports or captured context                                                                          |
| Q5 Python         | Support Python RPC providers and consumers                                      | Named Python functions are declared in the manifest; Python does not directly import JS modules                                            |
| Q6 Removal        | Retain existing required-dependency protections                                 | Enabled/running consumers block disable; any installed required consumer blocks uninstall                                                  |
| Q7 Risk           | Risk informs discovery, review, and audit                                       | Existing `silent` / `confirm` / `forbid` policy governs execution; no new per-method approval layer                                        |
| Q8 Replacement    | Active consumers block updates and hot reloads                                  | Stop consumers first; after replacement, explicitly reactivate them with new module instances                                              |
| Q9 Import API     | `await ctx.libraries.importModule(providerId, moduleName)`                      | Returns real functions, classes, and objects; calling exports is not RPC; static import syntax is outside this design                      |
| Q10 Runtime scope | Ordinary frontend/hybrid JS, including CLI/headless, plus Python RPC            | Isolated Node sandbox plugins and WASM explicitly reject new library capabilities                                                          |

## 3. Existing owners supply most of the runtime machinery

| Confirmed evidence                                                                                                           | Owning source                                                                                                                              | Reuse or change                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| IPC has exposure, calls, ACL-filtered discovery, primitive argument schemas, size caps, timeouts, breakers, and idle wake-up | [ipc.ts](../../lib/plugin/messaging/ipc.ts), [messaging types](../../types/plugin/plugin-messaging.ts)                                     | Add manifest authority and input/output contracts to the existing dispatch path                               |
| The catalog permission correction has landed in `a3cc2dfd3`                                                                  | [catalog.json](../../packages/plugin-sdk/contract/catalog.json)                                                                            | Preserve its `ipc:call` / `ipc:expose` mappings                                                               |
| Required dependencies already determine ordering and blocking                                                                | [load-order.ts](../../lib/plugin/core/load-order.ts), [manager.ts](../../lib/plugin/core/manager.ts)                                       | Extend existing lifecycle checks rather than introduce a parallel graph                                       |
| The handwritten version matcher does not implement complete semver ranges                                                    | [dependency-resolver.ts](../../lib/plugin/package/dependency-resolver.ts)                                                                  | Correct the shared matching seam, including prerelease and zero-major behavior, with focused regression tests |
| Runtime services publish availability/provider metadata, not callable methods                                                | [service-registry.ts](../../lib/plugin/core/service-registry.ts)                                                                           | Preserve that distinction                                                                                     |
| Independently evaluated CJS bundles have fresh module-local state                                                            | [evaluate-plugin-bundle.ts](../../lib/plugin/core/evaluate-plugin-bundle.ts), [node-importer.ts](../../cli/src/plugin/node-importer.ts)    | Use a dedicated module entry per declaration, evaluated for each consumer generation                          |
| Secondary entries already use provider-root checks and browser asset integrity                                               | [loader.ts](../../lib/plugin/core/loader.ts), [native lifecycle](../../crates/cognia-plugin-runtime/src/lifecycle.rs)                      | Reuse verified reads; do not import arbitrary paths                                                           |
| Contexts already have permission guards, governance, and disposable scopes                                                   | [context.ts](../../lib/plugin/core/context.ts), [disposable-scope.ts](../../lib/plugin/core/disposable-scope.ts)                           | Add a lifetime fence around the context handed to imported modules                                            |
| Python named-function dispatch and reverse host requests exist                                                               | [host-request-router.ts](../../lib/plugin/python/host-request-router.ts), [host.py](../../crates/cognia-plugin-runtime/src/python/host.py) | Adapt declarative methods to IPC and align nested API access                                                  |
| Isolated Node plugins currently record context calls rather than await host results                                          | [node-plugin-host.mjs](../../scripts/plugin/node-plugin-host.mjs), [launchPluginJs.ts](../../lib/plugin/launcher/launchPluginJs.ts)        | Q10 excludes this runtime; reject the new capability instead of recording a nonfunctional call                |

Related architectural constraints: [ADR-0145](../content/docs/en/adr/0145-python-plugin-runtime-alignment.md), [ADR-0155](../content/docs/en/adr/0155-plugins-reach-the-host-through-one-door.md), [ADR-0156](../content/docs/en/adr/0156-every-in-tree-plugin-is-a-third-party-plugin.md), [ADR-0209](../content/docs/en/adr/0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs.md), and [ADR-0210](../content/docs/en/adr/0210-a-plugin-can-carry-a-pi-package.md).

## 4. The manifest declares RPC methods and JS module entries separately

The additive shape is `library.rpc` and `library.modules`, keyed by public method/module name. At least one nonempty group makes the plugin a library; no new mutually exclusive plugin runtime type is needed.

| Declaration | Required information                                                                                      | Validator and execution owner                                           |
| ----------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| RPC method  | Description, input schema, output schema, risk, required permissions; Python handler name when applicable | Manifest validation; existing IPC dispatcher; manager's Python adapter  |
| JS module   | Dedicated relative bundle entry, description, risk, required permissions                                  | Manifest/path validation; consumer-scoped module loader                 |
| Consumer    | `dependencies[providerId]` semver range                                                                   | Existing load-order and activation graph; repeated at invocation/import |

The RPC input schema describes the entire positional argument array accepted by `ipc.call`. Results are JSON values; use `null` for an operation without a value. Validate both directions and copy JSON data across the RPC boundary so same-process calls do not introduce shared mutable references that Python cannot reproduce.

JSON Schema dialect is explicitly pinned to draft-07. Schemas are validated at install/load and checked at calls without coercion, defaults, or mutation. Reject unresolved remote references and unsupported dialects rather than ignoring them. Keep validation caches tied to the provider generation. Request and response payloads both retain the existing IPC size ceiling.

The evaluator must work under the existing desktop CSP. Reusing Ajv's dynamic runtime compilation is insufficient: it requires `unsafe-eval`, which `src-tauri/tauri.conf.json` does not allow. Select and test an interpreted draft-07 validator instead of loosening CSP or writing a partial schema translator. The implementation uses the interpreted `jsonschema` package, with strict schema admission and JSON boundary tests. Static-export review confirmed that the new runtime imports introduce no Node builtins or dynamic schema compilation. [Ajv CSP documentation](https://ajv.js.org/security.html#content-security-policy), [jsonschema documentation](https://github.com/tdegrunt/jsonschema).

Method names and module names are own-property lookups; reject prototype-path names. Provider contracts are host-owned snapshots, not mutable objects handed back to authors. Discovery returns copies of schemas and risk/permission metadata.

Only direct, required `dependencies` create cross-plugin eligibility. Optional or transitive dependencies do not grant calls/imports. A declared library method cannot be widened by supplying `allowedCallers` to `expose`; the manifest dependency relation remains authoritative. Existing undeclared legacy IPC methods retain their compatibility behavior. Library-declared methods must be implemented before provider activation completes; missing implementations fail activation and roll back registrations.

## 5. RPC preserves existing transport behavior and adds declarative authority

The call sequence is:

```text
consumer context -> dependency/version/runtime gate -> both principals' permissions
                 -> existing consent policy -> re-check generation and eligibility
                 -> input validation/copy -> IPC timeout/breaker -> provider handler
                 -> output validation/copy -> result and metadata-only audit
```

Required consent never substitutes for a grant: require permissions before consent, and repeat checks after any await. Revocation, account locking, consumer teardown, or provider replacement during consent prevents dispatch. The host resolves identity from the caller's context, not a plugin-supplied caller ID.

Python providers declare a public module-level function name. The manager registers an IPC handler that invokes that function through existing named-function dispatch. JS providers continue using `ctx.events.ipc.expose`; declarations control the contract and access. Neither route exposes raw host internals.

Use typed errors for dependency/version failures, unavailable providers, access/permission denial, invalid inputs/outputs, disposed contexts, and unsupported runtimes. Keep existing timeout, abort, and circuit-open errors distinguishable. Input/access errors do not charge the provider breaker; provider execution/output failures do. No automatic retries of potentially side-effecting methods.

Timeout or cancellation stops waiting; it cannot undo a handler's side effects or forcibly terminate arbitrary JavaScript. Re-check lifetime before returning a late result, and report that an already-dispatched operation may have run.

## 6. Direct modules are instantiated in the consumer's JavaScript realm

The author entry exports a factory that receives the consumer's fenced, guarded `ctx` and returns `{ exports, dispose? }`. `exports` contains ordinary JS values; its functions/classes are not serialized and need not return promises. The optional disposer releases module-owned resources.

Require a bundled CJS entry distinct from the provider's main entry. Native ESM root cache-busting alone cannot isolate transitive module state. Extend the existing catalog entry-path metadata so the normal bundler, packager, and browser asset staging include these entries.

Cache one initialization promise per consumer generation, provider generation, and module name. Concurrent imports share that promise; different consumers evaluate separate bundles and instantiate separate factories. Failed initialization is not retained as a successful instance. Track pending initialization in the consumer's disposable scope; if teardown wins the race, dispose the late result and never publish it.

Module-level required permissions are checked for both principals before import under the selected no-delegation model. The module then uses only consumer-bound host APIs, which keep their existing per-call permission and consent checks. Plain JS operations have no host permission of their own. Provider permission state is never unioned into the consumer's context.

Fresh evaluation isolates bundle-local state, not globals or host-shared SDK modules. This is the existing trusted JS plugin execution model, not a new security sandbox. Retained plain functions, classes, or objects cannot be destroyed by the host. Teardown guarantees disposal and rejection of stale host-context use; it does not promise revocation of all ordinary JS values. A lifetime fence must stay invalid even after the same consumer ID is enabled again.

## 7. Lifecycle failures have explicit recovery paths

| Event                                       | Required behavior                                                           | Recovery                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Missing/incompatible/cyclic dependency      | Fail consumer activation before exposing its contributions                  | Install a compatible provider or fix manifests; retry explicitly                                  |
| Provider fails activation or omits a method | Remove partial registrations; do not activate dependents                    | Correct provider, then retry                                                                      |
| Unauthorized RPC or discovery               | Deny without exposing restricted method details or invoking provider        | Declare required dependency and obtain required permissions                                       |
| Idle-suspended provider                     | Check eligibility before waking; resume through existing manager path       | Retry lookup only after successful resume                                                         |
| Consumer disable/unload                     | Fence module contexts, drain/dispose modules, remove IPC ownership          | Fresh instances on explicit reactivation                                                          |
| Provider disable/reload/update              | Block while required consumers have enabled intent or active lifecycle work | Stop consumers first; do not silently restart them                                                |
| Provider uninstall                          | Block while any required consumer remains installed                         | Remove dependents or change their declared dependency first                                       |
| Account/profile change                      | Invalidate instances, grants, pending work, and contexts                    | Resolve everything again in the new active account                                                |
| No interactive consent responder            | Deny confirm-tier operation explicitly; never silently allow it             | Run through a host with a consent responder or change policy through existing authorized controls |
| Shutdown or force cleanup                   | Invalidate contexts and discard registrations even if cleanup fails         | Record bounded cleanup diagnostics; do not claim cancellation of completed side effects           |

Use existing lifecycle reservations so an import/activation cannot race provider draining. Update checks run before package files are replaced; a failed check must leave the installed provider untouched.

## 8. Python and isolated JS runtimes must have honest capability tables

The generated catalog currently assigns runtimes per namespace. Add optional method-level runtime restrictions so Python can use IPC call/discovery without admitting callback-based exposure and subscriptions. Validate overrides as subsets of namespace runtimes and apply the effective runtime in SDK generation and host dispatch.

The embedded Python shim and installable Python SDK must agree on nested `ctx.events.ipc.*` access. Raw `ctx.call` requests must not bypass runtime restrictions; test the host router, not only the proxy. Callback registrations continue to require declarative manifest contributions.

| Runtime                             | RPC provider/consumer                                            | Direct JS modules                    |
| ----------------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| Frontend/hybrid in browser or Tauri | Required                                                         | Required                             |
| Frontend JS hosted by CLI/headless  | Required; confirm-tier calls deny without an available responder | Required, using fresh CJS evaluation |
| Python on a Python-capable host     | Required                                                         | Explicitly unavailable               |
| Isolated Node sandbox plugin        | Explicitly unavailable                                           | Explicitly unavailable               |
| WASM                                | Explicitly unavailable                                           | Explicitly unavailable               |

Q10 confirms ordinary JS + Python support. Reject unsupported library declarations and calls in isolated Node and WASM runtimes with an actionable capability error; do not return stubs or serialized callback proxies as library modules. Extending the isolated Node reverse protocol is outside this task.

## 9. Diagnostics expose contracts without recording payloads

Extend existing plugin messaging/permission review surfaces to show library method names, risk, required permissions, and dependency/version blocking reasons. All new labels, aria text, and error presentation use split English/Chinese translation sources.

Use existing bounded diagnostics/audit mechanisms with caller, provider, method/module, version/generation, outcome, and duration. Do not retain arguments, results, credentials, or module exports. Runtime collections and schema caches are cleared on generation/account teardown. Do not add persistent call history, a new database table, or a network service for this feature.

## 10. Focused checks prove each promised behavior

| Work package | Owner               | Dependencies          | Deliverable and verification                                                                                                                          |
| ------------ | ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP0          | Primary implementer | Final design approval | CSP-safe schema validator spike and actual-loader module isolation test; resolve technical infeasibility before public API edits                      |
| WP1          | Primary implementer | WP0                   | Manifest types/validation, dependency range semantics, author exports, and co-located invalid-manifest/range tests                                    |
| WP2          | Primary implementer | WP1                   | IPC declarations, dependency-derived access, both-principal consent/revocation checks, discovery, JSON input/output validation, and focused IPC tests |
| WP3          | Primary implementer | WP1–WP2               | Consumer-owned JS module initialization, packaging, generation fencing, disposal, and loader/manager tests preserving real classes and callbacks      |
| WP4          | Primary implementer | WP1–WP2               | Python provider adapters, nested proxy parity, method-level runtime catalog, raw-request enforcement, and targeted Python/router tests                |
| WP5          | Primary implementer | WP2–WP4               | Cross-runtime integration fixtures; lifecycle/update race tests; diagnostics UI and i18n tests                                                        |
| WP6          | Primary implementer | WP5                   | Generated SDK artifacts, bilingual ADR/plugin-dev documentation, minor changeset, requested gates, and final evidence report                          |

Every changed governed module has its co-located tests updated. Fixtures must drive the actual manager/loader boundaries for provider activation, RPC, and direct module import; unit mocks alone do not establish that a plugin can independently install/load and serve a consumer.

Essential regression cases: two consumers with incompatible ranges; prerelease/zero-major/intersection ranges; missing and circular dependencies; optional/transitive-only access denial; unauthorized callers cannot wake providers; mutation of discovery metadata; revoked permissions during consent; malformed and oversized JSON inputs/outputs; output schema failure; JS/Python combinations; duplicate module imports; independent top-level and factory state; late initialization/disposal; stale context after re-enable; blocked update before disk replacement; and preserved legacy IPC behavior.

Commands are selected for changed files only. Required gates:

```sh
rtk pnpm plugin:contract:check
rtk pnpm author-types:check
rtk pnpm plugin:author-imports
rtk pnpm audit:colocated-tests
rtk pnpm lint:i18n
rtk pnpm docs:build
```

Use `rtk env NODE_OPTIONS=--max-old-space-size=16384 pnpm exec tsc --noEmit -p tsconfig.json`, capture its output, and report diagnostics for task-owned paths separately. Run only changed Jest/Python/native test targets and changed-file lint; no full suite or coverage. After split i18n edits, run `rtk pnpm i18n:build` and `rtk pnpm i18n:build:check`.

Generate contract artifacts with `rtk node scripts/plugin/generate-contract.mjs` and author bundles with `rtk pnpm author-types:bundle`; never hand-edit their outputs. Run `rtk pnpm changeset` for `cognia-next` minor. Remove `docs/out` and `docs/.next` after the requested docs build, coordinating ownership if another docs build is active.

Native desktop, real Python subprocess, browser CSP, and headless flow claims require their corresponding executed checks. Report unavailable runtime verification explicitly rather than infer it from unit tests.

## 11. Delivery is additive and leaves build-time kits intact

Existing plugins without library declarations retain legacy IPC behavior. New library consumers must declare the minimum compatible host/SDK contract so older hosts do not silently ignore the declaration. Extend packaging, manifest validation, and generated editor author types together.

No existing `github-bot-kit` consumer is migrated. No dependency is automatically downloaded. No database migration, cloud deployment, or release is part of this task. Feature rollback first stops/removes new consumers and library declarations before downgrading the host; it does not rewrite unrelated plugins or user data.

ADR-0226 was allocated after verifying 0225 was the actual maximum. Both ADR navigation files and bilingual `plugin-dev/library-plugins.mdx` author guides are included.

Shared integration files already have unrelated edits. Re-read each owning file before editing, retain others' changes, use explicit pathspecs, and do not commit a mixed file wholesale. No branch switch, stash, reset, rebase, merge, or hook bypass is permitted.

## 12. Review record and remaining decisions

| Reviewer | Decision                                                                            | Date       |
| -------- | ----------------------------------------------------------------------------------- | ---------- |
| User     | Q1–Q10 confirmed through one-question-at-a-time design review                       | 2026-10-13 |
| Codex    | Implementation and focused verification complete; see the verification record below | 2026-10-13 |

- **Q10, confirmed:** ordinary JS + Python; isolated Node sandbox plugins and WASM explicitly reject this feature.
- **Final confirmation, received 2026-10-13:** the user approved the complete design and implementation of WP0–WP6.
- **Implementation responsibility:** the primary implementer owns WP0–WP6 and their evidence. No release date or additional external approval has been assumed.

## 13. Verification record (2026-10-13)

Implementation includes RPC access/schema enforcement, consumer-owned CJS modules,
Python bidirectional RPC, lifecycle protection, packaging, generated SDK metadata,
and bilingual diagnostics. ADR-0226 and both author guides document the shipped
contract. The root minor changeset is `.changeset/lemon-planes-grin.md`.

Only named changed test files and exact native test filters were run, always
without coverage. ESLint was limited to changed files. No full test suite,
coverage run, or repository-wide ESLint was performed.

- Focused manager tests: 267 passed, including actual loader/RPC/module integration,
  disabled dependency activation, missing implementations, and Python admission rollback.
- Focused IPC tests: 73 passed, including schema/copy boundaries, permission checks,
  wake-up hydration, teardown, and metadata-only audit.
- Contract/schema/dependency/SDK tests: 7 selected files, 580 passed. Subsequent
  schema/access focused runs also passed after TypeScript fixture corrections.
- Context, loader, manifest parity, modules and diagnostic-card focused tests passed.
- Python SDK and embedded-host parity checks passed; host parity includes actual
  isolated interpreter discovery and asynchronous `on_startup` reverse IPC.
- Native filters: 2 CLI library tests, 1 runtime library capability test, and
  1 runtime library path-containment test passed. Initial disk exhaustion was
  resolved before these successful runs; no target-wide cleanup was performed.
- Changed packaging/generator library cases passed. The broader changed-file
  browser builtin test retains an unrelated inventory assertion (54 actual vs
  52 expected); its failure is not reported as a passing full-file check.
- `plugin:contract:check`, `author-types:check`, `plugin:author-imports`,
  `audit:colocated-tests`, `lint:i18n`, `i18n:build:check`, and `i18n:sort:check`
  passed. Generated files came from the repository generators.
- `docs:build` passed with all four new bilingual routes verified. `docs/out` and
  `docs/.next` were deleted afterwards.
- Read-only wiring, i18n, and static-export reviews found no remaining blockers.
  Earlier review findings were repaired with focused regressions.

Native desktop UI and a full browser installation flow were not manually driven.
Manager/loader integration, native contract tests, and Python process checks are
separate evidence layers and do not imply those manual acceptance results.

The requested 16 GiB TypeScript command completed with **zero diagnostics in
this task's files**. It exits nonzero for 12 diagnostics outside this scope
(existing stories, chat/session, account-sync, companion, and prompt-gate paths).
Those unrelated files were left unchanged. Shared generated author types reflect
the current source tree; no mixed shared-file commit was attempted.

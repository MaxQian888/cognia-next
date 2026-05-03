# Plugin system consistency closeout

**Date**: 2026-05-03
**Status**: Implemented (2026-05-03, commit `d2ca056`)
**Builds on**: ADR 0006 (Plugin system completion, 2026-05)
**Out of scope (future ADR)**: 0007 — Tauri backend handlers for the 31 missing `plugin_*` Rust commands

> **Implementation note (2026-05-03):** Step 6 (`getState()` extraction)
> turned out to be a no-op — the audit's "20 sites" were already at
> method-top in `core/manager.ts`; no method called `getState()` more
> than once, so there was no drift to fix. Step 5's "de-duplicated
> stringify" optimization was also dropped because `validateMessage`
> doesn't pass `serialized` downstream — only the byte-size correction
> shipped. `PluginPointKind` widened with `"runtime"` and
> `PluginPointDiagnostic.code` widened with `"plugin.silent-failure"`
> so silent-failure entries reuse the existing diagnostics-store
> transport. Final coverage: 100% on both new files.

---

## Context

ADR 0006 wired the existing 75-file `lib/plugin/` runtime into user-visible
surfaces — settings, `/plugins` route, marketplace, composer, Claude SDK
adapter, six built-in plugins. The integration is complete; what remains is a
set of inconsistencies left over from the phased port that show up as
silent gaps:

- `lib/plugin/index.ts` still exports a stub `pluginManager` and a stub
  `validatePluginManifest` that omits governance handling. The full
  PluginManager lives at `core/manager.ts` and the canonical validator at
  `core/validation.ts`.
- 12 `catch { /* ignore */ }` sites silently drop failures. Some are
  expected (web mode without Tauri backend), some are real (desktop fs
  failure). They are indistinguishable in logs.
- `contracts/diagnostics-store.ts` collects plugin-point diagnostics but
  has no UI consumer and no test file.
- ADR 0006 quotes `102 hook points` and `11 activation patterns`; the
  actual values in `plugin-points.ts` are 108 and 10.
- `messaging/ipc.ts` measures payload size in JS string length (UTF-16
  code units) rather than UTF-8 bytes — non-ASCII payloads silently slip
  past the size guard. The same line also re-stringifies the payload it
  has already serialized.
- `core/manager.ts` calls `usePluginStore.getState()` 22 times across its
  lifecycle methods rather than caching the snapshot once at the top of
  each method.

This spec collects all of the above into a single closeout. Risk is low
(internal-only refactors, no manifest schema change, no new SDK events,
no Rust changes). Estimated effort: 14 hours.

## Goals

1. Remove every "stub", "Phase 2", or "replaced with" facade in
   `lib/plugin/index.ts`. The package entry should re-export the real
   implementations and nothing more.
2. Eliminate the duplicate `validatePluginManifest`. There is exactly
   one source of truth, and every call site passes governance context.
3. Surface unexpected silent failures to the user via the existing
   diagnostics-store + a new Audit panel section. Keep expected web-mode
   no-ops silent (no log noise).
4. Make the IPC byte-size guard correct for non-ASCII payloads.
5. Hold the line on coverage: the new and modified code stays at ≥90%
   line/branch/function coverage per `CLAUDE.md`.
6. Update ADR 0006 so the documented numbers match the source.

## Non-goals

- Implementing the missing Tauri backend (`plugin_install`,
  `plugin_load`, `plugin_python_*`, `plugin_fs_watch`,
  `plugin_process_kill`, `plugin_shortcut_register`,
  `plugin_dev_server_*`, `plugin_backup_*`, etc.). This is a separate
  ADR 0007.
- Reworking marketplace, permission UX, composer integration, or
  built-in plugins. ADR 0006 leaves those stable.
- Adding new metrics or telemetry counters. The audit-panel approach
  rendered the "full health dashboard" alternative unnecessary.
- New SDK lifecycle event surfaces. `adapter-hooks.ts` is unchanged.
- Changes to the manifest schema, the 30 canonical extension points,
  the 108 canonical hook points, or the 10 canonical activation
  patterns.

## Architecture

The closeout is five surgical changes against the existing architecture.
No new modules; one new component file plus its test; one new helper
function appended to `diagnostics-store.ts`.

```
lib/plugin/
├── index.ts                        ── strip stubs; re-export from core/validation
├── contracts/
│   ├── diagnostics-store.ts        ── add recordSilentFailure() helper
│   └── diagnostics-store.test.ts   ── NEW (≥90% coverage of 7 public fns + helper)
├── core/
│   ├── manager.ts                  ── extract `const store = ...` once per method;
│   │                                  4 silent catches → recordSilentFailure
│   ├── validation.ts               ── unchanged (canonical validator)
│   └── ...
├── lifecycle/
│   └── backup.ts                   ── 3 silent catches → recordSilentFailure
├── messaging/
│   └── ipc.ts                      ── byte-size correctness + de-duplicated stringify
└── utils/
    └── analytics.ts                ── 5 silent catches → recordSilentFailure

components/
├── plugins/
│   ├── plugin-point-diagnostics-panel.tsx       ── NEW
│   └── plugin-point-diagnostics-panel.test.tsx  ── NEW
└── settings/
    └── sections/
        └── plugins-section.tsx     ── AuditTab() mounts the new panel below
                                       the contract-audit Card

stores/plugin/
└── plugin-store.ts                 ── line 885: pass { governanceMode } to validate

i18n/messages/
├── en.json                         ── add settings.plugins.audit.diagnostics.* keys
└── zh-CN.json                      ── mirror

docs/content/docs/adr/
└── 0006-plugin-system.md           ── fix 102→108, 11→10; append Follow-up section
```

## Detailed design

### 1. Stub removal & validation consolidation

`lib/plugin/index.ts` shrinks to roughly 40 lines: hooks-system re-exports
plus a re-export of the canonical validator.

```ts
// lib/plugin/index.ts (after closeout)
export {
  getPluginEventHooks,
  getPluginLifecycleHooks,
  type PluginEventHooks,
  type PluginLifecycleHooks,
} from "./messaging/hooks-system"

export {
  validatePluginManifest,
  type ValidationResult,
  type ManifestDiagnostic,
  type ManifestValidationOptions,
} from "./core/validation"
```

Removed: `PluginInfo` interface, stub `PluginManager` interface, stub
`pluginManager` object, stub `ValidationDiagnostic` /
`ManifestValidationResult` types, stub `validatePluginManifest` body
(L26–46 and L106–201 of the current `index.ts`).

The four production consumers of `@/lib/plugin` continue to work:

| Consumer                               | Symbol                    | Status after change                                                                        |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `stores/plugin/plugin-store.ts:29`     | `validatePluginManifest`  | Re-exported; signature widens, but the only field accessed is `result.valid` — compatible. |
| `hooks/agent/use-external-agent.ts:35` | `getPluginEventHooks`     | Unchanged.                                                                                 |
| `stores/artifact/artifact-store.ts:17` | `getPluginEventHooks`     | Unchanged.                                                                                 |
| `lib/scheduler/task-scheduler.ts:27`   | `getPluginLifecycleHooks` | Unchanged.                                                                                 |

The single `pluginManager.list/get` consumer is `lib/plugin/index.test.ts`
itself, which is rewritten as the re-export sanity check.

`stores/plugin/plugin-store.ts:885` is updated to pass governance:

```ts
const validation = validatePluginManifest(r.manifest, {
  governanceMode: this.pluginPointGovernanceMode ?? "warn",
})
```

If `plugin-store` does not already carry a `pluginPointGovernanceMode`
field, the implementation phase reads it once at store init from
`localStorage["cognia.plugins.policy"]` (same key
`core/manager.ts:resolveGovernanceMode` uses), defaulting to `"warn"`.

### 2. Silent-catch policy

A new helper appended to `lib/plugin/contracts/diagnostics-store.ts`:

```ts
export interface SilentFailureContext {
  /** Call-site identifier, e.g. "manager.syncBackendStatus". */
  site: string
  /** Short, user-readable description. */
  message: string
  /**
   * Whether the failure is structurally expected. Web mode without a
   * Tauri backend → true; desktop mode runtime failure → false.
   */
  expected: boolean
}

export function recordSilentFailure(
  pluginId: string,
  ctx: SilentFailureContext,
  error: unknown
): void {
  const errMsg = error instanceof Error ? error.message : String(error)
  if (ctx.expected) {
    loggers.manager.debug(`[silent:${ctx.site}] ${ctx.message}`, errMsg)
    return
  }
  loggers.manager.warn(`[silent:${ctx.site}] ${ctx.message}`, errMsg)
  recordPluginPointDiagnostic(pluginId, {
    code: "plugin.silent-failure",
    severity: "warning",
    field: ctx.site,
    message: ctx.message,
    hint: errMsg,
  })
}
```

Twelve sites adopt one of three patterns:

**Pattern A — Tauri invoke**
(`manager.ts:1452, 1474, 1486, 1506`; `backup.ts:112, 171, 474`):

```ts
try {
  await invoke("plugin_set_state", { pluginId, status })
} catch (error) {
  recordSilentFailure(
    pluginId,
    {
      site: "manager.syncBackendStatus",
      message: `Failed to sync plugin status to backend (${status}).`,
      expected: !canUseTauriInvoke(),
    },
    error
  )
}
```

**Pattern B — analytics localStorage**
(`analytics.ts:96, 108, 119, 270, 280`):

```ts
try {
  localStorage.setItem(...)
} catch (error) {
  recordSilentFailure(pluginId, {
    site: "analytics.persist",
    message: "Plugin analytics persistence skipped (storage unavailable).",
    expected: false,
  }, error)
}
```

`expected: false` is intentional — `localStorage` failure is always
worth surfacing (private mode, quota, disabled storage are
user-resolvable).

**Pattern C — loop aggregation** (`manager.ts:1486`, the
per-permission revoke loop): collect failed permissions in
`failures: string[]` inside the loop; after the loop, if
`failures.length > 0`, emit one diagnostic naming all of them rather
than N separate diagnostics.

### 3. Diagnostics panel

A new component `components/plugins/plugin-point-diagnostics-panel.tsx`:

```tsx
export interface PluginPointDiagnosticsPanelProps {
  // All optional — used for test injection, prod uses real APIs.
  getDiagnostics?: () => Record<string, PluginPointDiagnostic[]>
  subscribe?: (listener: () => void) => () => void
  clearForPlugin?: (pluginId: string) => void
  clearAll?: () => void
}
```

Subscription is via `useSyncExternalStore` so SSR + hydration stay
consistent. UI structure:

```
┌─ Card ──────────────────────────────────────┐
│ Plugin runtime diagnostics                  │
│ "Live signals from governance, silent       │
│  failures, and runtime checks."             │
│                                              │
│  [All] [Errors] [Warnings]    [Clear all]  │
│                                              │
│  ▼ cognia-screenshot              [3] [Clear]│
│    ⚠ plugin.silent-failure  manager.sync... │
│    ⚠ plugin.governance.hook ...             │
│  ▶ cognia-prompt-templates       [1] [Clear]│
│                                              │
│  (empty: "No runtime issues recorded.")    │
└──────────────────────────────────────────────┘
```

Behavior:

- Filter ToggleGroup: `all | errors | warnings` (client-side filter).
- Per-plugin Collapsible: groups with at least one `error` default
  expanded; warning-only groups default collapsed.
- "Clear" calls `clearPluginPointDiagnostics(pluginId)`.
- "Clear all" opens an `AlertDialog` for confirmation, then calls
  `clearAllPluginPointDiagnostics()`.
- Empty state: single muted line.
- Each diagnostic row: monospace `code`, `field`, `message`, hover
  tooltip with `hint`.

Mounting: `AuditTab()` in `plugins-section.tsx` (currently L515) keeps
its existing contract-audit Card and adds
`<PluginPointDiagnosticsPanel/>` directly below it.

### 4. IPC byte-size correctness

`lib/plugin/messaging/ipc.ts:424` (and any sibling sites within the
same function — implementation phase to confirm):

```ts
// Before
const size = JSON.stringify(data).length
if (size > MAX_MESSAGE_SIZE) throw new Error(...)

// After
const serialized = JSON.stringify(data)
const size =
  typeof Buffer !== "undefined"
    ? Buffer.byteLength(serialized, "utf8")
    : new Blob([serialized]).size
if (size > MAX_MESSAGE_SIZE) throw new Error(...)
// downstream consumers reuse `serialized` rather than re-stringifying.
```

If the function does not currently feed `serialized` downstream, the
re-use optimization is dropped and only the byte-size correction lands.

### 5. `getState()` extraction in `core/manager.ts`

22 sites across roughly 12 methods. Pattern:

```ts
async someMethod(...): Promise<void> {
  const store = usePluginStore.getState()
  // …everything in this method that previously called
  // usePluginStore.getState() now reads `store`.
}
```

Caveat: Zustand's `getState()` returns a snapshot, so any call that
crosses an `await` boundary AND depends on the latest mutated state
must NOT use the cached `store`. Implementation phase audits every
extraction site; if more than two methods need to re-read state after
`await`, those methods drop the optimization (only setter references
stay cached, since they are stable). The acceptance criterion is "no
behavioral change" — any test failure during this refactor reverts the
specific extraction.

### 6. Test plan

`lib/plugin/contracts/diagnostics-store.test.ts` (NEW) — 8 cases:

1. `recordPluginPointDiagnostic` writes; `getPluginPointDiagnostics(id)`
   returns the entry.
2. Multiple records for one plugin preserve insertion order.
3. `getAllPluginPointDiagnostics()` returns deep copies (mutation of
   returned value does not affect store).
4. `clearPluginPointDiagnostics(id)` removes the entry and notifies
   subscribers.
5. `clearAllPluginPointDiagnostics()` is a no-op (no notify) when
   already empty.
6. `subscribePluginPointDiagnostics` returns an unsubscribe that stops
   notifications.
7. `getPluginPointDiagnosticsRevision()` increments monotonically per
   notify.
8. `recordSilentFailure(expected=true)` does not call
   `recordPluginPointDiagnostic`; `expected=false` calls it once.

`components/plugins/plugin-point-diagnostics-panel.test.tsx` (NEW) — 10 cases:

1. Empty state renders the muted empty message.
2. Two errors + one warning all render under "All" filter.
3. "Errors" filter hides warnings.
4. "Warnings" filter hides errors.
5. Plugin with only warnings defaults collapsed.
6. Plugin with at least one error defaults expanded.
7. Per-plugin "Clear" button calls `clearForPlugin` and the group
   disappears after the subscriber re-fires.
8. "Clear all" → AlertDialog → confirm → calls `clearAll`.
9. Unmount triggers the unsubscribe returned by `subscribe`.
10. `getDiagnostics` is re-invoked after each `subscribe` notify
    (verifies `useSyncExternalStore` wiring).

`lib/plugin/index.test.ts` — rewritten:

```ts
test("validatePluginManifest is the canonical core export", async () => {
  const core = await import("./core/validation")
  expect(validatePluginManifest).toBe(core.validatePluginManifest)
})
```

Stub-related assertions (`pluginManager.list()` / `.get()`) are deleted.

### 7. ADR 0006 update

`docs/content/docs/adr/0006-plugin-system.md`:

- L100: `102 \`CANONICAL_HOOK_POINTS\``→`108 \`CANONICAL_HOOK_POINTS\``
- L101: `11 \`CANONICAL_ACTIVATION_PATTERNS\``→`10 \`CANONICAL_ACTIVATION_PATTERNS\``
- Append before References:

```markdown
## Follow-up (2026-05)

A consistency closeout cleared five debts left after the original
implementation:

1. **Stub removal** — `lib/plugin/index.ts` no longer ships a fallback
   `pluginManager` or duplicate `validatePluginManifest`. The single
   canonical validator lives at `lib/plugin/core/validation.ts` and is
   re-exported from the package entry. `stores/plugin/plugin-store.ts`
   now passes the active `governanceMode`, closing a silent gap where
   runtime-synced manifests skipped contract validation.
2. **Silent-catch policy** — 12 `catch { /* ignore */ }` sites switched
   to `recordSilentFailure`, which writes to the diagnostics store
   only when the failure is unexpected (i.e. desktop-mode Tauri
   invoke failure rather than expected web-mode unavailability).
3. **Diagnostics panel** — Audit sub-tab grew a live "Plugin runtime
   diagnostics" panel powered by `subscribePluginPointDiagnostics`,
   with severity filtering and per-plugin clear actions.
4. **IPC byte-size correctness** — `messaging/ipc.ts` now measures
   real UTF-8 byte length instead of UTF-16 code units, fixing a
   silent oversize-passthrough bug for non-ASCII payloads.
5. **Doc drift** — hook point count corrected from 102 to 108,
   activation patterns from 11 to 10, matching `plugin-points.ts`.
```

## Effort estimate

| Section                                                 | Hours    |
| ------------------------------------------------------- | -------- |
| §1 Stub removal + plugin-store fix + index.test rewrite | 1.5      |
| §2 Silent-catch helper + 12 site rewrites               | 3.0      |
| §3 Diagnostics panel + 10-case test + i18n × 2 locales  | 5.5      |
| §4 IPC byte size                                        | 0.5      |
| §5 `getState()` extraction (with per-site safety audit) | 1.5      |
| §6 `diagnostics-store.test.ts` (8 cases)                | 1.5      |
| §7 ADR 0006 update                                      | 0.5      |
| **Total**                                               | **14.0** |

## Acceptance criteria

- `pnpm typecheck` clean.
- `pnpm test` all green.
- `pnpm test:coverage` shows `lib/plugin/` ≥90% lines / branches / functions.
- `pnpm lint` clean.
- `lib/plugin/index.ts` contains no comments referencing "stub",
  "Phase 2", or "replaced with".
- Grep for `// Ignore` and `// ignore` under `lib/plugin/` returns zero
  matches in source files (test fixtures excepted).
- Desktop dev launch: any `plugin_*` invoke failure renders in the
  Audit sub-tab → "Plugin runtime diagnostics" panel.
- Web dev launch: no diagnostics produced from expected
  Tauri-unavailable codepaths (verified by clean panel after navigating
  to `/plugins`).
- ADR 0006 numbers (108 hook points, 10 activation patterns) match
  `plugin-points.ts`.

## Risks & mitigations

| Risk                                                                                                 | Mitigation                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getState()` extraction inadvertently caches stale state across `await`                              | Per-site review during implementation; revert any extraction whose tests fail.                                                                                                  |
| `validatePluginManifest` signature widening breaks an unforeseen consumer                            | Grep verified only 4 consumers. The widened return type is a superset of the old one (extra `errors[]` / `warnings[]` fields); existing reads of `result.valid` are unaffected. |
| New `recordSilentFailure` floods the panel under genuine outages                                     | `expected: !canUseTauriInvoke()` keeps web mode silent; desktop outages SHOULD be visible — that is the feature. Per-plugin Clear button gives users an out.                    |
| ADR 0007 (backend completion) does not get scheduled, leaving the panel permanently noisy on desktop | Acceptable: a noisy panel is a stronger forcing function than a silent failure. The panel itself is the work item registry for ADR 0007.                                        |

## References

- ADR 0006: `docs/content/docs/adr/0006-plugin-system.md`
- Source of truth for contracts: `lib/plugin/contracts/plugin-points.ts`
- Diagnostics primitive: `lib/plugin/contracts/diagnostics-store.ts`
- Settings shell: `components/settings/sections/plugins-section.tsx`

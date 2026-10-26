# Desktop select theme audit — 2026-10-20

## Scope and result

The Best-of-N picker in the composer More popover used an HTML select. Its
closed control followed Cognia's tokens, but its expanded menu was rendered
by the browser/OS. Best-of-N now composes the existing Radix Select directly.

The shared `NativeSelect` now preserves its existing HTML-select API while
using Cognia's Radix Select on desktop. Capacitor and touch-only browsers keep
their native picker. A narrow desktop viewport alone does not select the
native path. Multiple-selection listboxes retain native behavior.

The production-source audit found 135 `NativeSelect` instances after migration,
zero direct `<select>` instances outside the shared UI primitives, and one
explicit `native` override. Stories, tests and AI Elements are excluded from
that count.

## Other affected callers

Fifteen direct selects across these six files now use the shared policy:

- `components/integrations/integrations-hub.tsx`
- `components/artifacts/workspace-mode/task-resources-panel.tsx`
- `components/agent/external-agent/session-operations.tsx`
- `components/workflow/portal/workflow-portal.tsx`
- `components/mobile/remote-sessions/session-changes-panel.tsx`
- `components/settings/mcp/mcp-tool-rules-card.tsx`

Existing shared callers include browser settings, password/cookie import,
evaluation, workflows, automation, security, and mobile forms. Their native
change-event/value contracts remain intact through a native form mirror;
only the desktop picker is replaced. Empty option values are encoded for the
Radix item layer and decoded before native events and form submission.

## Native WebView exception

`components/editor/project/project-root-switcher.tsx` explicitly requests
`native`. Its system picker paints above the native child WebView without
marking the editor aria-hidden. A modal DOM select would hide/park the editor
through `useRegionVisibility`. The existing regression test continues to
verify opening, cancelling, choosing and genuine dialog occlusion.

## Validation

- Jest: 73 affected suites, 1,109 tests passed, without coverage collection.
- Focused ESLint: passed with zero warnings.
- Full repository `pnpm lint --cache-location /tmp/cognia-select-eslint-cache`:
  passed with zero warnings using a fresh cache.
- i18n lint: passed; no translation resources were changed.
- Browser: actual Best-of-N component inside a Popover opens a dark themed
  four-option menu and selects 3; the shared selector uses the light theme and
  selects 3; a 480px desktop viewport still renders a Radix trigger.
- Live app: Settings → Security & Privacy → Lock after inactivity opens a
  themed DOM listbox with Never / 5 / 15 / 30 / 60 minute options.
- Unit integration checks cover Capacitor/wide tablets, touch-only web,
  Tauri/touch input, controlled catalog changes, groups/disabled options,
  empty/numeric values, labels, native form values, reset and one change event.

The new `lib/testing/select-option.ts` is test-only support for the many
existing consumer tests: no existing shared driver handled both picker types.
It interacts with visible Radix options on desktop and native options on
mobile. Form-mirror inspection is explicit, and deliberate invalid/disabled
DOM-tampering tests retain their original checks.

## Verification limits

The final repository typecheck reports nine errors in five files outside this task:
`chat-header.test.tsx`, `session-summary-trigger.test.tsx`, `guild-rail.test.tsx`,
`sidebar-nav-section.test.tsx`, and `permission-api.test.ts`.
The static-export gate reports an unrelated `node:fs/promises` import in
`lib/browser/extension-engine.ts`. A complete production build and real
Tauri/iOS/Android acceptance were not run.

An initial broad test run exhausted temporary cache space. The successful
final run used `--no-cache` and did not delete shared caches or user data.

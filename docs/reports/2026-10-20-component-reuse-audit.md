# Component reuse audit — 2026-10-20

## Scope and result

Follow-up to the Select and native-control audits. This pass inspects production
TSX in `app/` and `components/`, excluding tests, stories, shared UI primitives
and AI Elements. It compares candidates with the actual local component APIs
and checks representative callers. No production source is changed by this audit.

CodeGraph was unavailable because the checkout has no index. Source navigation
used JSX AST inventory, `rg`, and direct reads instead; no index was created.

| Candidate pattern                                       | Source locations | Meaning                                                                         |
| ------------------------------------------------------- | ---------------: | ------------------------------------------------------------------------------- |
| `window.confirm/prompt`                                 |   17 in 10 files | Browser-owned confirmation/input surfaces                                       |
| Native elements declaring `role="tablist"`              |   22 in 21 files | Candidates requiring a keyboard/semantics review, not 22 confirmed defects      |
| Explicit `role="alertdialog"` outside shared primitives |     5 in 5 files | Four inline confirmation areas; one deliberately non-modal plugin consent card  |
| Raw data/presentation tables                            |     8 in 7 files | Four ordinary data tables and four renderer-owned tables                        |
| Pulse blocks matching the placeholder heuristic         |     8 in 8 files | Most are status decorations; FilesImageThumb is a confirmed loading placeholder |

Counts refer to JSX locations and calls, not rendered items. The inventory is
discovery evidence, not a rule that every matching element must be replaced.

## 1. Prioritize themed confirmations and host selection

Existing owners: `components/ui/alert-dialog.tsx`, `dialog.tsx`, `select.tsx`.

| Location                                                                   | Trigger                                                                   | Reuse opportunity                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `components/settings/automation/automation-audit-table.tsx:87`             | Clear audit log                                                           | AlertDialog; the confirmation and related load/success messages also contain existing hard-coded English |
| `components/account/runtime-target-menu-section.tsx:118` and `:125`        | Remove companion; choose replacement for active companion                 | AlertDialog plus a Dialog/Select of valid hosts instead of typing a host ID into prompt                  |
| `components/mcp-apps/managed-mcp-app-card.tsx:83`, `:87`, `:104`, `:107`   | Authorize tool call, destructive second approval, external link, download | Themed approval dialog with the same approval boundaries                                                 |
| `components/artifacts/workspace-mode/task-resources-panel.tsx:346`, `:879` | Irreversible apply / sensitive content                                    | AlertDialog preserving the exact resource and pending operation                                          |
| `components/inbox/overrides/conversation-override-form.tsx:513`, `:520`    | Promote override / permissions                                            | AlertDialog preserving both decision stages                                                              |
| `components/inbox/inbound-recovery-panel.tsx:34`                           | Retry inbound work                                                        | AlertDialog retaining the retry warning                                                                  |
| `components/terminal/terminal-session-chip.tsx:287`, `:302`                | Take over / release session                                               | AlertDialog, with terminal focus restored after cancellation                                             |
| `components/settings/connections/forms/adapter-permissions.tsx:79`         | Change permission policy                                                  | AlertDialog retaining the impact confirmation                                                            |
| `components/account/account-lock-screen.tsx:818`                           | Reset storage layout                                                      | AlertDialog that remains usable before an account is unlocked                                            |
| `components/connectivity/pair/paired-step.tsx:143`                         | Choose replacement host                                                   | Dialog/Select with explicit valid-host choices                                                           |

The first two are straightforward product UI candidates. MCP approval needs
careful state ownership, but its frame already accepts `boolean | Promise<boolean>`
and awaits approval (`mcp-app-frame.tsx:37`, `:118`), so asynchronous themed
approval fits the existing contract. Migration must retain destructive double
approval, denial on cancellation/unmount, and attribution to the original
request. No approval was exercised during this audit.

## 2. Reuse keyboard behavior for ordinary tabs and option groups

Existing owners: `components/ui/tabs.tsx` and `toggle-group.tsx`.

The following inspected strips render Button/native-button tab roles and
`aria-selected` but do not provide roving tab stops, arrow-key handling or
panel associations in their source:

- `components/settings/sections/diagnostics-section.tsx:87`
- `components/account/quick-unlock/quick-unlock-panel.tsx:250`
- `components/mobile/goals/goals-mobile-section-switcher.tsx:40`
- `components/chat/message-parts/usage-diagnostics-card.tsx:392` and `:545`

Diagnostics is mounted by Settings and `/me/diagnostics`; QuickUnlockPanel by
AccountLockScreen; the Goals strip by GoalsMobileBody. These are live callers.

**Browser reproduction:** the actual GoalsMobileSectionSwitcher remained on
`overview`, with focus on Overview, after ArrowRight. All three tabs had
`tabIndex=0` and no `aria-controls`. In the same fixture, the existing shared
Tabs moved focus and selection to `history`. Separate keydown/keyup calls
allow Radix's deferred focus operation to complete.

Use Tabs with TabsContent when selecting a corresponding panel. For scope,
axis or status filters, first determine whether ToggleGroup/RadioGroup is the
correct semantic owner. Reusing Button alone supplies button styling, not the
behavior of the role assigned to it.

Do not mechanically migrate editor/terminal/artifact tab strips: they also
own close buttons, drag ordering, dirty state and focus restoration. Global
search likewise delegates keyboard cycling to its containing dialog.

## 3. Ordinary tables bypass the shared density behavior

Existing owner: `components/ui/table.tsx:9`.

Four ordinary data tables use raw table/head/cell markup with fixed padding:

- `components/settings/sections/plugin-messaging-card.tsx:184`
- `components/sites/observability/site-analytics-view.tsx:245`
- `components/issues/projects/project-table.tsx:47`
- `components/router-fusion/delegate-checks-table.tsx:147`

The local Table applies `densitySurfaceProps("table", density)` and TableCell
reads `--density-row-padding`. These callers do not apply that surface marker
or consume the row-padding variable, so their fixed cell padding bypasses the
shared table-density policy. PluginMessagingCard is mounted by Diagnostics;
ProjectTable by ProjectConsole; DelegateChecksTable by DelegateReviewPane.

Start with PluginMessagingCard and SiteAnalyticsTable. Preserve captions,
header scope, numeric alignment and narrow-screen overflow. ProjectTable also
has sticky headers and container-query column hiding: Table already offers
`containerClassName="overflow-x-visible"` for an existing outer scrollport.
Retaining fixed `py-*` overrides everywhere would still defeat density reuse.

The Markdown, code-line and chart renderers own document/presentation layout;
their native tables are not automatically candidates for settings-table UI.

## 4. Files thumbnail loading should reuse Skeleton

Location: `components/files-library/files-image-thumb.tsx:82`.

While media acquisition is pending, this renders a plain
`div.animate-pulse.bg-muted`, without Skeleton's marker or decorative semantics.
It is used by the Files card, row, preview and mobile row.

**Browser reproduction with `html.reduce-motion`:**

| Actual component                    | `data-slot` | Computed animation duration | Iterations |
| ----------------------------------- | ----------- | --------------------------- | ---------- |
| FilesImageThumb pending placeholder | absent      | `0.001s`                    | `1`        |
| Existing Skeleton                   | `skeleton`  | `2s`                        | `infinite` |

`app/globals.css:557` deliberately preserves status feedback for the Skeleton
marker. Reusing Skeleton fixes a behavioral mismatch as well as centralizing
the style. Preserve the thumbnail dimensions and its existing loading test ID.

Do not replace every pulse: live-status dots, boot milestones and streaming
cursors have different meanings. MathInline's span in `markdown-renderer.tsx:69`
already carries the Skeleton marker and stays a phrasing element so it remains
valid inside paragraphs; replacing it with a div would be a regression.

## 5. Reuse confirmation composition only after choosing modal semantics

Existing owners: AlertDialog for modal decisions; Alert for inline notices.

Inline confirmation areas currently assign alertdialog roles themselves:

- `components/best-of-n/best-of-n-comparison.tsx:414`
- `components/chat/image-workbench/image-workbench.tsx:498`
- `components/settings/connectivity/blocks/tunnel-block.tsx:298`
- `components/settings/connections/tabs/tunnel-tab.tsx:304`

These areas do not acquire AlertDialog's focus entry, panel description,
keyboard dismissal or focus restoration merely by setting the role. Decide
whether each is a modal decision or an inline confirmation, then compose the
matching primitive. Best-of-N must retain the candidate-specific publish key;
the tunnel areas must retain the pending start/stop intent and current host.

The fifth match, `plugins/dialogs/plugin-consent-overlay.tsx:143`, is different:
it explicitly sets `aria-modal="false"`, has request-bound IDs, a polite
announcement and its own focus handling. A modal AlertDialog would change its
non-blocking queue behavior. Automation consent and native capture/copilot
windows also need platform-specific review rather than blanket conversion.

## 6. Extend existing responsive form composition where appropriate

Existing owner: `components/shared/responsive-form-dialog.tsx`.

Candidates still duplicating long-form Dialog shells with 85–90vh limits:

- `components/twin/persona/style-sample-editor-dialog.tsx:129`
- `components/inbox/overrides/conversation-override-dialog.tsx:35`
- `components/settings/image-catalog/image-catalog-entry-editor.tsx:97`

The shared shell supplies desktop Dialog, mobile Drawer, dynamic viewport
height, one scrolling body and a pinned footer. It already has a production
consumer in `external-agent/detail/field-editor-drawer.tsx`.

This is an integration opportunity, not proof of a mobile keyboard failure.
ResponsiveFormDialog remounts children when switching shells. The Inbox form
and ImageCatalog EditorForm own draft state inside those children, so direct
wrapper substitution could erase edits during a viewport change. Preserve or
lift draft ownership and keep the existing reset-on-close/identity behavior.
StyleSampleEditor already owns its draft above its shell and is the smaller
candidate to start with. Physical-device keyboard acceptance remains necessary.

## Lower-priority consolidation and intentional exceptions

- Empty/EmptyHeader/EmptyTitle and the plugin-specific PluginEmptyState already
  exist. Consolidate equivalent full empty states through those; retain small
  inline zero-result hints and workflow-specific onboarding layouts.
- Badge, StatusBadge, ActivityPill and CountPill already cover common status
  presentation. Keep domain status mappings at the feature layer; do not merge
  unrelated state machines simply because their labels look alike.
- Spinner/LoadingRegion already distinguish decorative glyphs from announced
  loading. A Loader icon beside a labelled busy action is lower priority than
  a standalone unannounced loading area; avoid duplicate live regions.
- MenuKit already shares action lists between dropdown/context/menubar/mobile
  surfaces. TerminalQuickFix and TerminalCommandMenu deliberately retain PTY
  focus on mousedown, so a menu migration needs terminal focus/selection tests.
- BarcodeScannerOverlay composes Dialog's low-level Content to keep a native
  camera preview transparent. VideoPreprocessPanel uses low-level Slider thumbs
  to label trim start and end independently. These are purposeful compositions.
- The unused legacy ProgressBar export in `ui/loading-states.tsx` is not a
  reachable caller defect; a source similarity alone does not justify migration.

## Validation and recommended order

Validation: production JSX/call-expression AST inventory, direct component and
caller inspection, and the browser reproductions above. The fixture imports
actual GoalsMobileSectionSwitcher, FilesImageThumb, Tabs and Skeleton. Its media
boundary is held pending to reproduce the thumbnail's loading branch; it does
not test storage, network/media retrieval, an unlocked account, or live approvals.

This change adds documentation only. No application source, tests, translation
resources or configuration were changed; no new unit/build/typecheck results
are claimed for the audit.

Recommended implementation batches:

1. Files thumbnail Skeleton and ordinary tab/filter semantics.
2. Browser confirmation/prompt replacements with cancellation and request tests.
3. Ordinary tables, including density and scroll behavior.
4. Inline confirmation semantics and responsive forms with draft preservation.

Do not start a new generic UI framework for these findings. Existing primitives
and feature compositions cover the identified responsibilities.

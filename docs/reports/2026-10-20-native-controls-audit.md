# Native HTML control audit — 2026-10-20

## Scope and decision rule

This follows the desktop Select audit. It covers JSX in `app/` and
`components/`, excluding tests, stories, `components/ui/`, and
`components/ai-elements/`. Shared primitives deliberately render native HTML;
finding an HTML tag alone is not evidence of a styling defect.

Use the existing themed primitive for a normal form field or standard action.
Retain a native element when it provides a file dialog, specialized editor,
semantic grouping, or a deliberately styled composite interaction. In
particular, Button and Input themselves render native HTML. Radix supplies
interactive behavior where applicable; it does not replace every input type.

The initial inventory contained 918 native JSX control/grouping instances.
After this change, the same scan finds 906 instances across 529 source files:

| Native element        | Remaining JSX instances | Disposition                                                                                               |
| --------------------- | ----------------------: | --------------------------------------------------------------------------------------------------------- |
| `button`              |                     524 | Styled rows, cards, chips, editor/media controls, slot compositions, and one invisible positioning anchor |
| `input type=file`     |                      21 | Hidden or screen-reader-only file-dialog targets                                                          |
| Text/search `input`   |                       8 | Compact inline editors or fields integrated into another styled control                                   |
| `input type=time`     |                       2 | Mobile quiet-hours fields with native time entry                                                          |
| `input type=color`    |                       1 | Theme editor's color well and OS color picker                                                             |
| `input type=range`    |                       1 | Video seek control with custom track/thumb styling                                                        |
| `textarea`            |                       2 | Tray action composer and terminal AI-shell command composer                                               |
| `label` / `fieldset`  |                250 / 61 | Form association and semantic grouping                                                                    |
| `details` / `summary` |                 18 / 18 | Native disclosure semantics                                                                               |

Counts are source locations, not rendered controls: one mapped RadioGroupItem
renders five access choices. The scan does not certify every remaining
button's accessibility or exercise every interaction at runtime.

## Implemented fixes

Eleven standard control locations across seven source files now reuse the
existing shared components. The radio cards also reuse Label.

| Source                                                         | Change                                       | Behavior retained or checked                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `app/share/view/page.tsx`                                      | Two actions → Button; password field → Input | Explicit button types, password submission, wrong-passphrase state and read-ticket reuse; added `aria-invalid`          |
| `components/share/payload-view.tsx`                            | Three actions → outline Button               | Image download/copy and add-to-library disabled states and callbacks                                                    |
| `components/artifacts/workspace-mode/task-resources-panel.tsx` | Hunk checkbox → Checkbox                     | Label-click selection and exact selected-hunk payload                                                                   |
| `components/agent/external-agent/session-operations.tsx`       | Exclude-context checkbox → Checkbox          | Label activation, toggling and `excludeFromContext` callback                                                            |
| `components/sites/tabs/site-domains-tab.tsx`                   | Native radios → RadioGroup/RadioGroupItem    | Group name, label-card activation, keyboard navigation, policy payload and restoring saved values after switching modes |
| `components/twin/add-source/source-inputs.tsx`                 | Visible file field → Input                   | Native file selection, `accept`, multiple files, disabled state and staged-upload diagnostics                           |
| `components/chat/composer.tsx`                                 | Command progress → Progress                  | Existing finite/clamped 0–1 progress is converted to the shared component's 0–100 scale; cancellation retained          |

The Composer integration test also now selects Best-of-N through its visible
Radix option and verifies the reset label after sending.

## Intentional native controls

- File inputs remain hidden targets for existing upload buttons or labels.
  They preserve refs, FileList events and same-file reselection resets. The
  visible Twin source picker receives Input styling while retaining native
  file-dialog behavior.
- `custom-theme-editor.tsx` keeps the native color picker;
  `video-block.tsx` keeps its specifically styled media seek range;
  `notification-preferences-section.tsx` keeps mobile time entry.
- `plan-document.tsx`, `ai-shell-plan-view.tsx`, `terminal-dock.tsx`,
  `project-problems-panel.tsx`, `line-diff-view.tsx`, `composer-popover.tsx`,
  and `island-reply.tsx` use inline editing/search integrated with their
  surrounding surface and keyboard/focus behavior.
- `tray-panel-delegate-bar.tsx` and `ai-shell-panel.tsx` use specialized
  textareas with composer sizing and submit/IME behavior.
- Nine remaining buttons have no local `className`: five receive styles
  through Badge `asChild`, three wrap styled origin-chip Badges, and the
  workflow context-menu anchor is deliberately invisible. They are not
  unstyled standard actions. Other raw buttons already define their surface
  styling; this change does not mechanically give rows/cards the geometry
  of a form button.
- Native labels, fieldsets and disclosures are semantic HTML, not an OS
  popup escaping Cognia's theme.

## Verification

- Jest: seven affected suites, 224 tests passed, without coverage collection.
- Reproduction checks failed for the expected missing shared styles, radio
  grouping and password invalid state before implementation. Both newly
  checked share outline-button cases likewise failed before migration.
- All seven sources have updated co-located tests. Label activation, radio
  mode round trips, file uploads, action callbacks and progress semantics
  have behavioral checks alongside the styling assertions.
- Browser fixture: actual SiteDomainsTab plus existing shared primitives,
  using the app's compiled CSS. Checked radio keyboard navigation (separate
  keydown/keyup around Radix's deferred focus), label-card selection,
  restoring saved identities, checkbox activation and progress value 40.
  Light/dark screenshots were inspected; a 390px viewport has a 390px document
  width and keeps all five radio choices visible without horizontal overflow.
  The fixture stubs shell external-link integration; it does not exercise
  external links or a live provider operation.
- The live share route loaded in the development app. Its protected-share
  flow was not accepted against a live share server; password submission is
  covered by the page's integration tests.
- i18n lint: passed; no translation resources or user-facing strings changed.
- Full repository `pnpm lint`: passed with zero warnings, using a separate
  content-based cache to avoid stale diagnostics from the shared cache.
- Prettier: all 14 affected source/test files and this report passed.
- Typecheck: nine errors in five files outside this change:
  `chat-header.test.tsx`, `session-summary-trigger.test.tsx`,
  `guild-rail.test.tsx`, `sidebar-nav-section.test.tsx`, and
  `permission-api.test.ts`. These match the errors recorded before this audit.
- Static-export gate: blocked by the existing `node:fs/promises` import in
  `lib/browser/extension-engine.ts:450`; no violation in these changed sources.
- Scoped diff whitespace check: passed.

## Limits

No full production build, real Tauri/iOS/Android acceptance, live provider
operation, or exhaustive runtime test of the remaining native controls was
performed. The inventory is an audit artifact, not a blanket ban on native
HTML or proof that every custom interaction has identical styling.

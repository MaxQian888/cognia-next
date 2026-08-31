# Selection Action Platform — implementation plan

**Date:** 2026-08-30  
**Status:** Implemented behind the native replacement rollout flag  
**Decision record:** ADR-0159

## Objective

Extend the system-wide selection toolbar without replacing the native perception,
security, geometry, OCR, or ten existing actions established by ADR-0093 and
ADR-0095. The result is one host-rendered action platform for built-ins, Cognia
rewrite actions, and explicitly opted-in plugin quick actions.

The interaction model follows the useful parts of PopClip action management and
exclusions, Raycast AI replacement, Apple Writing Tools review/revert, DeepL
manual activation, and OpenAI source transparency. Cognia keeps stricter
boundaries: plugins never run in the overlay, selected text is permission-gated,
and replacement requires a fresh native equality check.

## Contracts

- `PluginQuickActionSurface` includes `selection`; omission preserves the legacy
  palette/composer/tray default.
- Text-reading actions declare dangerous permission `selection:read`. Metadata
  actions receive no text and need no selection permission.
- `PluginSelectionActionSpec` declares input, content types, origins, character
  limit, and output policy (`none`, `status`, `preview`, `copy`, or `replace`).
- Selection invocations carry candidate identity, authorized text, sanitized
  source metadata, origin, capture time, truncation, classification, editability,
  and replacement capability.
- The host accepts only bounded text, variants, status, or void results and
  rejects malformed output before it reaches the overlay.
- `ExternalSelectionCandidate` carries `editable` and `replaceCapability`;
  `ExternalSelectionRef` preserves `sourceUrl` and `capturedAt`.
- Contract version is 1.2.0; TypeScript and Python SDK version is 0.3.0. The
  minimum supported SDK remains unchanged.

## Ownership and event flow

```text
AX/UIA observer or manual chord
  -> native candidate (security, source URL sanitization, geometry)
  -> lightweight selection-toolbar window
  -> main window publishes eligible action descriptors
  -> overlay requests an action by candidate/action/request id
  -> main window revalidates registry + permission + candidate
  -> normalized result returns to host-rendered preview
  -> native exact-selection check -> paste -> clipboard restore -> undo lease
```

The overlay imports no authenticated plugin runtime, model client, or plugin UI.
The main window owns plugin enumeration/localization, permission consent,
execution, model routing, PII checks, timeout handling, and result normalization.

## Preferences

- `selectionToolbar.mode`: `off`, `automatic`, or `manual`; the old
  `selectionToolbar.enabled` bit migrates to `automatic`/`off` and remains a
  compatibility mirror.
- `selectionToolbar.disabledApps` and `selectionToolbar.disabledSites`; site
  values are hostname rules only (`*.example.com` is explicit subdomain match).
- Existing translation, contextual-action, and search-engine preferences are
  editable in Desktop Settings.
- `selectionToolbar.actionLayout.v1` retains ordered, hidden, and pinned ids,
  including ids belonging to currently disabled plugins.
- `selectionToolbar.directReplaceAllowlist.v1` records explicit per-action
  direct-replacement consent. Preview remains the default.

## Action resolution

The ten existing built-ins retain their native enforcement and default/contextual
ordering. At most six capsule slots render. User ordering and pins can replace
lower-priority slots; Copy remains the safety action. Remaining eligible actions
are rendered by one host-owned More panel. Disabling a plugin removes its live
descriptor without deleting its retained layout entry.

Cognia contributes one Rewrite submenu, not six permanent buttons. Improve,
Concise, Detailed, Technical, Simpler, and Variants call the existing
`enhancePrompt` engine, including its PII gate and existing utility/headless model
routing.

## Native safety and health

- Automatic mode retains the 4,000-character auto-raise ceiling. Manual/show
  and action shortcuts read AX/UIA on demand and apply the 20,000-character cap.
- Hostname exclusions run against sanitized AX metadata before candidate text is
  published. Secure fields and disabled applications retain their existing gates.
- Selection shortcuts are reserved while off but registered with the OS only
  while the selection scope is active.
- Settings shows non-prompting Accessibility, Input Monitoring, Screen Recording,
  UIA, OCR, and shortcut-scope health. Opening a system permission pane requires
  an explicit click.
- Replacement accepts only fresh, non-truncated, editable accessibility-origin
  candidates. Native code focuses the source, rereads selection text, requires
  exact equality, uses the audited clipboard-paste helper, and restores the prior
  text clipboard.
- Replacement is compiled off unless `COGNIA_SELECTION_REPLACE=1`. Refusal never
  falls through to unvalidated typing.
- Undo is candidate-, timeout-, focus-, and physical-input-generation-bound.

## Verification

Focused Jest and Rust tests cover migration, hostname matching, action slotting,
classification-aware prompts, provenance, manifest/permission validation,
consent, invocation/result normalization, Settings health, preview states,
replacement refusal, clipboard reuse, undo invalidation, IPC serialization, and
overlay ACL parity. The static selection-action parity gate is part of
`pnpm plugin:contract:check`.

Final release gates are coverage, typecheck, lint, format, i18n generation/parity,
plugin contract/SDK/Python tests, static export, and real macOS/Windows Tauri
matrix verification before the replacement rollout flag is enabled.

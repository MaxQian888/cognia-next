# Managed cloud desktop — Phase 2 verification

Date: 2026-10-15. The user approved Phase 2 after accepting ADR-0228. Implementation is in the detached managed-cloud-desktop-design worktree. Phases 3–4 have not started; their delivery/history dependencies remain unchanged.

## Implemented boundary

- The existing desktop viewer/hook accepts a Host-bound managed session. Settings connects through the existing lifecycle seam before opening that viewer. Docker retains its local adapter.
- Six authenticated Host commands cover status, frame, acquire, renew, release and input. Observation uses `host.observe`; mutations use `host.admin` plus the ADR-0153 admin lease and the separate 15-second principal-bound control lease.
- Input requires a current desktop generation, fence and single-use frame. Frame lifetime is five seconds; control renewal does not renew admin authority. Account/pairing/transport replacement, expiry and unmount invalidate the viewer session. Mobile is observation-only.
- The native path reuses the computer-server client, mutation mutex and uncertain-cleanup quarantine. Managed endpoints use protected WSS, with no provider credential or endpoint exposed to the viewer. Delete/deadline/revocation fences queued input. Unknown input outcomes are durably quarantined across restart.
- Manual input uses the existing automation permission, policy, kill-switch, rate and audit pipeline. Headless consent reaches the existing Host consent surface. Corrupt persisted policy refuses control. A delayed consent response cannot revive an expired frame or input lease. Existing Host automation permissions must allow ComputerUse; qualification never turns those permissions on. The driver cannot authenticate foreground process/window/URL metadata, so policies requiring those facts refuse input.
- Separate GUI qualification is required in addition to lifecycle qualification. The native operator's `control-smoke` entry measures control and cleanup before writing that receipt; it has no RPC entry. Agent input/delegation, handoff, live preview and durable acceptance evidence remain dormant.

## Checks performed

- Eight focused frontend suites: **89 tests passed**. Scope: managed client/settings, shared sandbox client, viewer/hook, connections tab, E2B adapter and connection capabilities. This includes Docker regressions, account/Host invalidation, late leases, stale input, mobile observation and qualification gating.
- After the single-use frame and takeover-gesture review fixes, the three affected hook/viewer/sandbox-client suites passed **34 tests**, including three new regressions. These counts overlap with the eight-suite run. The hook consumes proofs locally, refuses duplicate queued input without dropping control and promptly requests fresh pixels; capture epochs discard late pre-input responses. Native frames retain bounded unexpired proofs so background polling does not invalidate the pixels still displayed to the user. The managed Take control gesture now supplies the Host's required explicit takeover flag; its regression failed before the fix and passed afterward.
- ESLint on the eleven affected frontend files: passed.
- Three focused managed-desktop protocol tests: passed. Closed request schemas reject caller-supplied identity, invalid fences and oversized input; frame schemas reject endpoint/token fields.
- Companion API generation/check: **859 remote commands, 107 classified routes**.
- i18n build, build freshness and lint: passed; both locale sources and generated aggregates updated.
- Co-located test gate: **302 known gaps, no new gaps** (baseline 314).
- Rust architecture gate: **66 crates layered**, two existing baselined findings. Existing app-shell size warning remains advisory.
- Command grammar gate still reports the two pre-existing missing resources `connector.lark.callback` and `task.workspace.session_scratch`; neither belongs to this change.
- Read-only wiring and i18n audits passed. The test-gap audit found no missing co-located files; its requested direct consent-bridge and dual-auth test sources were added. Native review caught an incorrect `UiAction` import, which was corrected, and synchronous policy-file reads, now moved into serialized `spawn_blocking` work. The final send guard checks the current versioned memory snapshot. The final native source review found no remaining concrete issue; this is not compilation evidence.
- The PII/credential source audit found no new LLM/embedding path or credential/input-text disclosure in consent and logs. Literal user-requested GUI input remains unchanged.

Native tests were added for control/qualification refusal, principal/admin authority, frame/fence validation, concurrent controllers, capture-await races, queued and compound input fencing, cancellation quarantine and strict policy loading. **They were not executed.** The user directed that Rust verification be skipped after disk exhaustion; rustfmt is only a syntax/format check, not compilation or test evidence. No full test suite or coverage was run.

## Remaining enablement gates

No provider credentials were consumed, no desktop was provisioned, and no image/release was published. No actual browser/Tauri UI flow or real-provider smoke was run. Full TypeScript checking remains unverified after the Phase 1 heap failures.

Before qualification/integration, compile the final native changes and run only the affected native tests and thin Tauri/headless checks, then exercise the actual Host UI. After the user separately supplies credentials and explicitly authorizes spend, run lifecycle qualification first, followed by `control-smoke` for the exact owner/configuration/template. The operator requires `--authorize-paid-smoke` and a typed approval of its quote. Keep the normal Host stopped while the operator owns its journal, and restart it afterward for any outstanding cleanup.

Production GUI remains dormant until the Host has a valid GUI receipt. Passing fixture tests does not satisfy that gate.

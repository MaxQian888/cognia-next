---
title: ADR-0106 — End-to-end skill recorder
description: "Preflight, scoped capture, an append-only device-local bundle, structured review, previewed generation, disabled save and a controlled trial."
---

# ADR-0106 — End-to-end skill recorder

**Status**: Accepted (2026-08-01)

## Context

`cognia-skill-recorder` was a demonstration. `/record-skill` opened a plugin modal with Start and "Stop & generate"; the second button shipped the trace to a model and saved an **enabled** skill. There was no preflight, no scope, no pause, no review, no recovery, no provenance, and no trial. The native side kept everything in RAM, `record_cancel` deleted the capture directory, `record_stop` aborted the drain task before reading observations — silently losing the last key run — and `record_start` bypassed `dispatcher::run_gated` entirely, so it prompted for consent but never faced the whitelist, the tier policy, or the audit ring.

A recorder watches everything the user does. That makes it the one subsystem where "reasonable defaults" is not a sufficient answer: what it captures, what leaves the device, and what it turns on afterwards all have to be decisions the user made and can see.

This decision extends [ADR-0020](/docs/en/adr/0020-computer-use-completeness) (the automation gate and emergency stop) and reuses the PII gate from [ADR-0003](/docs/en/adr/0003-employee-digital-twin).

## Decision

### Flow

One authoritative state machine — `setup → preflight → recording ↔ paused → stopping → review → generating → draft → saving → saved`, plus `interrupted`, which is legal from every phase. Four entry points (Skills toolbar, command palette, `/record-skill`, the configurable `skills.record` chord, default `Ctrl+Alt+R`, desktop-only) all dispatch `OPEN` at the same global store. `OPEN` from a non-idle phase is a no-op that only raises the Sheet: that *is* reattach-instead-of-duplicate, enforced in the reducer rather than by UI discipline.

The Sheet mounts at the app root, not in the Skills panel — three of the four entry points fire on any route. Dismissing it mid-capture hides the panel; the floating 420×56 always-on-top controller is the surface while a recording runs. The controller is capture-excluded (`set_content_protected`, re-asserted after the NSPanel conversion and on every reveal, with a `GetWindowDisplayAffinity` post-check and a `WDA_MONITOR` fallback on Windows) and is **not dismissible by construction**: its capability file omits `core:window:allow-close` and `allow-hide`, and its permission file omits `record_start` and the entire bundle-read surface. Both omissions are pinned by `include_str!` tests.

### Admission, before anything else

`admission_check` is pure and ordered: kill switch → automation disabled → unsupported platform → plugin not installed → plugin disabled → missing grants → already recording → storage. It runs *before* the gate call, so a denial never raises a consent prompt. `record_start` is then routed through `run_gated` with `process_name` and `window_title` derived from the chosen scope, and `Call::forces_per_call()` makes a `Whitelist` tier unable to auto-allow a global input hook. `ConsentPrompt::is_one_shot()` prevents a session grant from forming: "don't ask again" is not a meaningful thing to grant in advance for a recorder.

### Capture is scoped, and the bundle is append-only

`CaptureScope` is `Window | Application | Desktop`, presented as three side-by-side choices rather than an advanced option. Because `Window` and `Application` carry identity fields, the choice is a kind **plus a target**: `record_list_capture_targets` enumerates the live window list (Cognia's own windows excluded, focused first), and `scopeForSelection` builds the scope from the picked target. A scoped choice with no target returns `null` and cannot start a recording — it is never widened to the desktop, and neither is a failed preflight retry. `ScopeBinding::decide` is pure; window identity is re-verified per capture against `(pid, app_name)` because the OS recycles window ids. **A key run has no cursor point, so it is scoped by the focused pid, not the mouse** — otherwise typing into a password manager while a scoped window sat under the pointer would be captured. Out-of-scope activity produces a step with no element and no frame, and the renderer shows only an aggregate count.

The bundle lives at `<data_dir>/cognia/recordings/<recordingId>/` as an immutable `manifest.json`, an append-only `journal.jsonl`, and `assets/<assetId>.png`. **Undo is a tombstone, never a truncation**; `replay` is a pure fold and a torn final line is dropped rather than fatal. `AssetId`/`RecordingId` parse only canonical UUIDs, which is the primary traversal defence, with a canonicalized prefix re-assertion behind it. Limits (60 min / 500 steps / 250 MiB per recording, 2 GiB global, integer 80% warning) are checked *before* a frame is written.

### Sensitive input fails closed

`SecureState` is `Plain | Secure | Unknown`, and `Unknown` is treated as `Secure` everywhere. State is sampled at the start of a run and on every key, and any secure sample makes the whole run `Sensitive` — which carries no value, **no length, and no shape**. Command modifiers (ctrl/alt/meta, deliberately not shift) turn a run into a structural chord such as `cmd+c` rather than transcribed text. Local OCR is a bounded 480×160 region clipped to the scope, restricted to `apple-vision` / `windows-media-ocr`; a cloud backend can never be selected, and its result lands in `ocr_hint` where it cannot be mistaken for typed input.

### Review is required, and generation is previewed

Every step carries an asset id, never bytes; frames are fetched on demand through a 64-entry cache. Edits are stored separately from the capture and replayed over it, which is what makes a saved source version immutable. Variable suggestions all arrive unconfirmed and block generation until answered — the recorder cannot tell a search term from a menu name, and guessing wrong yields either a skill hard-coded to one person's data or a placeholder where a fixed value belonged. The gate is in the reducer (`GENERATE_REQUESTED` is refused while any suggestion is unanswered), not in the UI, because an unconfirmed variable is not inert: the envelope falls back to the raw recorded text for it, so generating early would ship what the user typed to the model *and* write it into the skill. The manual-template path goes through the same event and is therefore gated identically.

`buildGenerationEnvelope` returns the exact strings that are sent, PII-gated before return, and the preview renders those same strings; a test pins the byte-identity. **Screenshots are never sent to the generation model.** Proposed `allowedTools` are intersected against the real catalog and confirmed by the user; an empty catalog reports everything unknown rather than silently keeping it. With no model configured the fallback is a *complete* skill written from the reviewed timeline, not a stub. Regeneration produces a candidate that is merged section-by-section — it never overwrites.

### Save disabled, try once, then enable

The skill is written in one Dexie transaction (`skills`, `skillResources`, `skillRecordings`) with `status: "disabled"`. The trial session carries two fields, because one alone does not produce a trial: `trialSkillId` is what actually loads the skill — `resolveSendOptions` reads it and loads the row **by id, past the enabled-status filter**, since the recording is deliberately still `disabled` — and `disabledSkillIds` is every *other* enabled skill, so the composer chips and the session badge agree with the send path about what is inert. Together the result cannot be explained by anything else. Enabling is a separate, explicit act.

### Device-local by construction

One additive table, `skillRecordings: "&id, skillId, status, updatedAt, [skillId+createdAt]"` (Dexie v141), holding edits, counts and provenance — never the capture. It is absent from `SyncableTable`, from the companion sync handler set, from `readDexieDelta` (which throws for unknown tables), from `ClearableTable`, and from the backup payload. That omission is asserted by test rather than left implicit. Logs and telemetry may carry phase, duration, counts, sizes, platform, scope kind and stable error codes — never text, frames, coordinates, window titles, document names, prompts or model responses.

### Emergency stop

`kill_switch::engage` replaces three divergent call sites (settings, global shortcut, tray): engage → persist → clear session grants → release virtual displays → `recorder.interrupt_blocking(KillSwitch)` → emit one event. The interrupt preserves the journal, so the stop is not a data-loss event; the banner says so, and offers no retry after a kill switch or a permission withdrawal.

## Verification

594 Rust tests in `cognia-automation` plus the `recorder_window` capability pins; the load-bearing ones are journal replay of a torn line, asset-id traversal rejection, key-run-scoped-by-focus-pid, recycled-window-id rejection, `Unknown`-is-secure, sensitive-carries-no-length, pause-flushes-the-buffered-run, interrupt-preserves-the-journal, and admission-rejects-the-kill-switch-first. On the TypeScript side, co-located tests cover the state machine's legal and illegal transitions, envelope byte-identity, the atomic save's transaction scope, the trial's skill isolation, and every recorder surface. Windows code paths are implemented and unit-tested but were **not** verified on a physical Windows device; the checklist for that is handed to the user.

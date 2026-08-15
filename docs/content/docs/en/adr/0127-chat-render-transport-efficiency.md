---
title: ADR-0127 — Chat rendering and transport efficiency, and the message customization contract
description: One coalescing policy for every chat rail, batched Companion frames, a widened message-display contract, and an audited disposition for every dormant chat/transport feature.
---

# ADR-0127 — Chat rendering and transport efficiency, and the message customization contract

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-16 |
| Builds on | ADR-0114 — Unified chat message presentation; ADR-0090 — Unified agent execution; ADR-0027 — Mobile sync orchestrator; ADR-0021 — WebRTC WAN transport |
| Scope | Main app (browser / Tauri / Capacitor) and the public share view. **Not** the CLI TUI (`cli/src/tui/`), which owns a separate Ink renderer. |

## Context

An audit of the chat rendering path, the message-customization surface, and the four transport rails (local sidecar, Companion WS/WebRTC, external agents, standalone CLI) established the following facts:

- **Rendering is mature but rail-asymmetric.** The sidecar rail commits React state at most once per animation frame and persists streaming deltas behind a 250 ms debounce (`hooks/chat/stream-coalescing.ts`). The **external-agent rail** does neither: `writeAssistant()` runs a full `replaceSessionMessages` per delta and persists only at turn end, so a crash mid-turn loses the partial. Closed-pane (background) sessions write Dexie per event with no throttle.
- **Nothing coalesces before the wire.** The sidecar emits one JSON line per token; Rust forwards one Tauri event per line; the Companion `EventBus` publishes one seq'd frame per event; WS and WebRTC ship one frame per event, uncompressed. A slow subscriber is closed on `broadcast::Lagged` (`ws.rs`) or told to resync (`signaling/dispatch.rs`). The only bandwidth lever is the all-or-nothing `streamPartialMessages` toggle.
- **Virtualization is count-based only.** `VIRTUALIZE_THRESHOLD = 40` messages; a 39-message session of 200 KB code blocks renders in document flow.
- **The presentation contract (ADR-0114) is fully wired**, but nine renderer capabilities (`enableMath/Mermaid/Diff`, `showLineNumbers`, code wrap, `mathFontScale/Alignment/ShowCopyButton`, serif body font) exist only as props with hard defaults — no setting, no UI. `messageDisplay` itself is missing from `SECTION_OWNED_KEYS` and `APPEARANCE_CONFIG_KEYS`, so "reset section", the changed-settings review, and appearance export silently skip it.
- **A dormant inventory** of 20 items was produced (see *Dispositions*). Each is now either wired, deleted, or explicitly recorded as inert.

## Decision

### 1. One coalescing policy for every rail that reaches the renderer

`SessionCoalescingRegistry` (rAF-throttled store commit + 250 ms debounced `persistStreamingMessages`, sealed by a synchronous commit + full `persistMessages` at turn end) is the **only** streaming write policy. The external-agent rail adopts it unchanged; the closed-pane branch adopts the same debounce for its direct Dexie writes. A rail that bypasses the registry is a bug, pinned by tests that assert ≤ 1 store commit per frame under a synthetic 100 tok/s stream.

### 2. Batched Companion frames, at the send loop only

Frame batching lives in the per-subscriber send loops of `companion_api/ws.rs` and `companion_api/signaling/dispatch.rs`, **not** in `EventBus` (the in-process A2A consumer keeps per-frame semantics). Rules:

- Window: **50 ms**, fixed. An idle subscriber's first frame is sent immediately (first-token latency unchanged); subsequent frames accumulate for the window. (Decided at 33 ms during the grill; raised to 50 ms during implementation because 33 ms yields ~31 sends/s at 100 tok/s, −69 %, and cannot meet the §5 −80 % bar — 50 ms gives ≤ 20 sends/s in steady state.)
- Only **consecutive frames of the same channel** are batched. A channel change, a control frame (`stream_ready`, `resync_required`, `ping`), or the window expiring flushes.
- Replay bursts are batched too.
- Envelope — WS: `{ "type": "event_batch", "channel", "seq_from", "seq_to", "frames": [EventFrame…] }` (safe because real channel names always contain `://`); RTC: `{ "kind": "event-batch", "event", "seq_from", "seq_to", "frames": [...] }`.
- Clients (`lib/tauri/transport-companion.ts`, `lib/tauri/transport-rtc.ts`) expand a batch into the existing per-channel monotonic seq cursor path; single frames remain valid forever (older servers).
- `Lagged` handling is unchanged.
- The `agent://message` parallel canonical stream is **out of scope**; its retirement stays with ADR-0090 Phase 9 and is recorded here only as a known transport cost.

### 3. Dual-threshold virtualization

`MessageList` virtualizes when **either** the message count ≥ 40 **or** the total text length of all parts > 256 KB. Sessions below both thresholds keep the zero-ResizeObserver flow path.

### 4. Widened message-display contract

`MessageDisplayPreferences.overrides` gains:

```ts
markdown?: {
  math?: boolean; mermaid?: boolean; diff?: boolean;
  codeLineNumbers?: boolean; codeWrap?: boolean;
  mathFontScale?: 0.8 | 1 | 1.2; mathAlign?: "center" | "left"; mathCopy?: boolean;
};
bodyFont?: "sans" | "serif";
```

Every preset supplies defaults; resolution stays in `resolveMessageDisplayOptions` (ADR-0114 precedence: session override → global → preset). **Both** renderers (Streamdown streaming branch, react-markdown finalized branch) and the code-block renderer read the resolved values; per-block toolbar toggles remain ephemeral overrides on top of the resolved default. The controls appear in `MessageDisplayControls` (desktop appearance tab, session sheet, and the mobile settings panel). The share view reads global settings only. The Shiki theme stays hard-coded (`lib/chat/code-theme.ts`) — both renderers must agree, and a picker is not worth that coupling.

`@theme --font-serif` is declared in `globals.css`; `bodyFont: "serif"` applies it to message prose, giving `typographyExt.serifFamily` its first consumer.

Per-surface density (`density.chat / .table / .sidebar`) becomes real: `densitySurfaceProps("chat")` on the message-list container, `("sidebar")` on the conversation list, and `("table")` on the `Table` root, whose cells read `--density-row-padding`.

### 5. Measurable acceptance

| Scenario | Bar |
| --- | --- |
| 2000-message session, 40 images, 12 mermaid | TTI < 800 ms; longTask total < 1.5 s |
| Single 200 KB code block | no main-thread block > 100 ms after finalization |
| 100 tok/s stream for 60 s | ≤ 1 store commit and ≤ 1 React commit per frame; no longTask > 50 ms |
| Companion at 100 tok/s | frames over the wire − ≥ 80 %; first-token latency + ≤ 50 ms |

Deterministic count assertions (commits/frame, batches, Dexie writes) run in Jest and gate CI. Timing bars live in the `@perf`-tagged Playwright suite (`tests/e2e/mobile/chat-render-perf.spec.ts`), opt-in as before.

### 6. Dispositions for the dormant inventory

| Item | Disposition |
| --- | --- |
| Read-aloud button unreachable under `focused`/`balanced` (only the `actions: "all"` branch rendered it) | **Fixed** — rendered in the core/hover branch too |
| Desktop `MessageList` omitted `directCharacter` | **Fixed** |
| `MessageRenderer` memo comparator omitted `onRewindFiles` | **Fixed** |
| `messageDisplay` + 6 siblings absent from `SECTION_OWNED_KEYS` / `DEFAULTS` | **Fixed** — owned by Appearance/Conversation; completeness guard now covers them |
| `APPEARANCE_CONFIG_KEYS` exported `agentFlowMode` but not `messageDisplay` | **Fixed** |
| `DEFAULT_APPEARANCE_SLICE` had zero consumers | **Wired** into `getSettings()` as the single default source |
| `AgentFlowDisplayToggle` + `chat.header.flowDisplay.*` keys | **Deleted** — superseded by `MessageDisplayControls` |
| Test-only exports (`parseShortcut`, `KeyboardShortcut`, `DetailsGroup`, `computeTimelineGeometry`) | **Deleted / internalized** |
| `ChatHeaderPresetPill` (system-prompt preset switcher) | **Wired** into the chat-header center chip cluster |
| `density.chat/.table/.sidebar` dead knobs | **Wired** (§4) |
| `typographyExt.serifFamily` dead knob | **Wired** (§4) |
| Hidden markdown/math/code renderer props | **Promoted** to settings (§4) |
| Plugin tool-result renderer registry (0 production registrations) | **Populated** — `web-tools`, `screenshot`, `clipboard-history` register cards |
| `command_ack` (emitted, unconsumed) | **Consumed** — duplicate command ⇒ no re-inserted user message, no re-entered streaming state |
| `session_closed` (AI-SDK rail) | **Correction, no change** — the audit reported it as forwarded-and-dropped; `makeWrappedEmit` in `sidecar/agent-host.mjs` intercepts it before the wire (it only retires the multi-turn session entry) and `sidecar/claude-host.test.mjs` pins that it is never forwarded. A renderer case would be dead code. |
| `companion://device-paired` (listened, never emitted) | **Emitted** from device registration, mirroring `device-seen` |
| `browser://console`, `browser://network`, `browser://snapshot` (declared, never emitted) | **Emitted** — push-on-append via the overlay sentinel channel (drain commands kept), consumed by a DevTools drawer (console/network) and an agent-engine snapshot cache keyed by generation; Companion forwarding **off** by default |
| `gateway://decide` renderer round-trip (flag-off by default) | **Inert, unchanged** — ADR-0090 Phase 9 |
| `agent://message` parallel canonical stream | **Unchanged** — ADR-0090 Phase 9 |
| `http` / `websocket` / `custom` / `sse` external-agent protocols (type-level only) | **Inert, unchanged** |
| `Transport.readBinary` absent on `TauriTransport` | **Inert by design** (desktop reads Dexie blobs) |

## Consequences

- Every rail that reaches the renderer now has identical write cadence; mid-turn crashes on the external-agent rail no longer lose the partial.
- Companion consumers receive far fewer, larger frames; older clients that do not understand `event_batch` must be upgraded before a server that emits it — the WS/RTC contract version is bumped accordingly.
- New presentation options must be added to `resolveMessageDisplayOptions` **and** both renderers before they are user-visible; the tests enforce Streamdown/react-markdown parity.
- Enabling per-surface density and serif body font makes previously inert UI live; users who had set them will see the change on upgrade.
- The browser push channels add a Rust → renderer event volume that only exists while the embedded browser is open, and only locally.

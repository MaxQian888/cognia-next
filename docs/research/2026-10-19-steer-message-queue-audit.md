# Steer messages, follow-up queues, and message reuse audit

Date: 2026-10-19 (Asia/Shanghai). Scope: current Cognia working tree, desktop/shared chat, rooms, mobile action surfaces, CLI TUI, and Codex integration. Baseline observed: `a09e47df33`, with substantial unrelated concurrent working-tree changes. Findings describe the files read, including uncommitted code; they are not a claim about a released binary.

This is a research artifact. No runtime code, configuration, schema, or existing changes were modified. Official Codex release evidence is recorded separately in [Codex updates](./2026-10-19-codex-steer-queue-updates.md).

The [remote Host persistence and failure-recovery extension](./2026-10-19-remote-host-delivery-audit.md) traces physical headless storage, client outbox, production RPC receipts, HostState/WorkSubmission replay, attachment lifetime, delayed live controls, and user recovery. Its source-level cross-layer findings supersede any inference that simply persisting `steerQueue` would complete remote delivery reliability.

## Conclusion

Cognia already implements pending-queue text editing, drag/keyboard reordering, removal, whole-queue interrupt-and-send, historical user-message editing/resending, attachment reconstruction, sibling branches, mobile resend, and persisted text-history recall. Rebuilding those controls would duplicate existing behavior.

The larger gaps concern semantics and delivery: the user cannot explicitly choose Queue versus Steer in the ordinary composer; renderer fallback entries merge into one turn; the renderer queue and its ordering do not survive restart; accepted live input cannot be revised through the pending editor; CLI queue controls lag the GUI; and historical resend means rerun from the old point rather than reuse the complete message at the current tail. Direct-chat queue draining also marks messages applied before replay admission is known.

## Terms that must stay distinct

| Term                    | Current meaning                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Steer                   | Additional input for an active turn, acknowledged by the runtime; acknowledgment does not prove the model has consumed it.                    |
| Renderer fallback queue | `SessionChatSlice.steerQueue`, used when live input cannot be accepted, or the turn has not been admitted.                                    |
| HostState queue         | Host-owned `message.enqueue` / `message.queued` state with action IDs and reconciliation. It is a different queue from the renderer fallback. |
| Historical edit/resend  | Create a replacement variant at an old question and rerun from there.                                                                         |
| History recall          | Restore previously submitted text into the current composer, then submit as a new message.                                                    |
| Put back                | Recover an undelivered steer into its session's composer, carrying recoverable files and context.                                             |

Sources: [steer model](../../lib/claude/steer.ts), [chat store](../../stores/chat/chat-store.ts), [HostState intents](../../packages/agent-config-types/src/host-state.ts), [HostState service](../../lib/sync/host-state-service.ts), [input recall](../../components/chat/composer/hooks/use-input-history.ts).

## Current capability matrix

| Capability                                | Desktop / shared chat                                        | Rooms                                                          | Mobile                                                                  | CLI TUI                                                            |
| ----------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Submit while working                      | Attempts live steer, otherwise queues                        | Queues until room turn ends                                    | Depends on runtime/host lane                                            | Plain text queues for the next boundary                            |
| Explicit per-message Steer / Queue choice | No ordinary composer choice found                            | No ordinary composer choice found                              | No shared choice established                                            | No equivalent Enter-steer / Tab-queue choice in `App.handleSubmit` |
| Edit queued text                          | Bubble and expanded Run Panel                                | Same store-backed editor locally                               | Shared panel is touch-aware; live device flow unverified                | No row edit action in steer reducer                                |
| Preserve position when editing            | Yes: update by stable entry ID                               | Same local store behavior                                      | Same shared implementation where mounted                                | Not applicable                                                     |
| Reorder queue                             | Drag grip and keyboard sensor                                | Shared local queue UI                                          | Touch grip implementation exists; not device-tested                     | No reorder action                                                  |
| Remove queued entry                       | Yes; removes queue entry and bubble                          | Same local helpers                                             | Shared queue controls where mounted                                     | Only whole queue clear in reducer                                  |
| Send selected queued entry now            | No per-row dispatch                                          | No per-row dispatch                                            | No shared per-row dispatch                                              | No per-row dispatch                                                |
| Send entire queue now                     | Interrupts current run, then replays; idle/error has flush   | Interrupts members, then drains                                | Shared callback-dependent controls                                      | No equivalent queue management control found                       |
| Edit accepted live steer                  | No pending editor once accepted                              | Ordinary room follow-ups stay queued                           | Same state restriction                                                  | TUI does not use native steer here                                 |
| Restart recovery                          | Bubble survives; queue/order does not; recover into composer | Store queue has same limitation                                | HostState transport queue must be considered separately                 | `string[]` queue is transient                                      |
| Historical edit and rerun                 | Yes, sibling branch; blocked while turn is active            | Yes, sibling branch; room reservation prevents concurrent edit | Long-press edit pane                                                    | Backtrack selection, edit, then truncate/rerun                     |
| Historical unchanged resend               | One-click resend through edit-and-rerun                      | Same shared handler                                            | Dedicated resend row                                                    | Recall text and submit; no GUI-style resend row                    |
| Recall as new message                     | ↑/↓, persisted session and cross-session text                | Shared composer                                                | Keyboard-dependent; no equivalent full-message touch action established | ↑/↓ input history                                                  |

The mobile column distinguishes shared code from verified runtime behavior. A platform-bound conversation explicitly omits `onEditResend` in `ChatView`, so the history-edit matrix does not imply that connector conversations can rewrite remote-platform history.

Sources: [Run Panel](../../components/chat/run-panel.tsx:244), [steer badge](../../components/chat/message-parts/steer-status-badge.tsx:53), [store operations](../../stores/chat/chat-store.ts:1207), [direct send gate](../../hooks/chat/use-claude-chat-controller.ts:1857), [room queue](../../lib/chat/room/runner.ts:414), [mobile actions](../../components/mobile/chat/message-action-sheet.tsx:301), [CLI submit](../../cli/src/tui/components/App.tsx:2393), [CLI actions](../../cli/src/tui/state/types.ts:1478), [platform-bound gate](../../components/chat/chat-view.tsx:1143).

## End-to-end implementation

### 1. Submission and live steering

Direct chat checks `streaming`, `awaiting_approval`, and pending execution admission. It persists an optimistic message carrying `metadata.steer`, mentions, and context summary. It then tries the HostState steering route, the session's actual external-agent lane, or the Anthropic execution handle/sidecar. Failure or unsupported input falls back to `enqueueSteer`.

External steering currently sends text only. Attachment-bearing external follow-ups queue; Anthropic can accept the complete `SendContent`. Fusion/cascade/panel turns and turns awaiting admission also queue. An addressed `@runtime` follow-up while busy is refused rather than silently rerouted. New steering instructions also supersede pending approvals and invalidate the cached safety-judge context.

Sources: [direct routing and fallbacks](../../hooks/chat/use-claude-chat-controller.ts:1857), [IPC acceptance contract](../../lib/claude/ipc.ts:488), [Codex adapter](../../packages/agent-codex/src/app-server-client.ts:2045).

Cognia's Codex adapter already calls `turn/steer` with the active `expectedTurnId`, detects unsupported methods, and supports version-gated `additionalContext`. A new Codex integration is unnecessary for basic steering. The desktop application's queue controls are not automatically inherited by this adapter.

### 2. Queue editing and order

`SteerEntry` carries a stable ID, text, content blocks, attachment metadata, web-search sources, reply target, citations, and context summary. `editPendingSteer` updates both queue and transcript bubble and persists the latter. The store maps the existing entry in place, preserving order and attachment blocks. `moveSteerEntry` only changes queue delivery order; transcript arrival order remains unchanged. Bubble badges show queue positions when multiple items wait.

The expanded panel supplies multiline text editing, Enter to save, Shift+Enter for newline, Escape to cancel, blur to commit, a pointer drag sensor, a keyboard sensor, and translated drag announcements. The queue row displays attachment count but does not provide attachment replacement/removal controls. Empty text commits discard the whole entry, including an attachment-only entry.

Sources: [entry shape](../../stores/chat/chat-store.ts:44), [editor synchronization](../../hooks/chat/steer-runtime.ts:273), [store updates](../../stores/chat/chat-store.ts:1215), [panel editor](../../components/chat/run-panel.tsx:244), [queue row](../../components/chat/run-panel.tsx:369).

### 3. Delivery, recovery, and status

`maybeDrainSteer` clears the queue and builds one framed payload containing all queued text, with all attachment blocks before the text. Sources and citations are merged. The first available reply target wins. Queue reordering therefore changes paragraph order in one prompt, not the execution order of independent tasks. Neither Run Panel row has an individual send action.

The whole-queue Send now action aborts the active turn before replay. It is not equivalent to injecting just one selected queue item into the active turn. Failed/idle queues have an explicit flush and discard path. A failed individual bubble offers Put back and Discard; Put back reconstructs recoverable text, files, citations, reply target, and context into the composer. If no composer claims it, the bubble remains available.

Sources: [payload framing](../../lib/claude/steer.ts:110), [drain](../../hooks/chat/steer-runtime.ts:481), [interrupt and flush](../../hooks/chat/use-claude-chat-controller.ts:6238), [recovery](../../hooks/chat/steer-runtime.ts:354), [queue actions](../../components/chat/run-panel.tsx:744).

Renderer queue entries are memory-only. Optimistic bubbles and edits persist to Dexie, but queue membership and reordered positions do not. After restart, a formerly queued bubble derives `failed` and can be put back manually. An `accepted` bubble in an idle session derives `applied`; this derives delivery from acceptance/lifecycle rather than an explicit model-consumption receipt.

This does **not** mean every queue in Cognia is memory-only. HostState separately stores/reconciles queued messages by action ID and projects queued rows into the transcript. Its public intent union has enqueue, steer, followup, abort, and transcript editing, but no explicit pending-queue update/move/remove intent. Local `moveSteerEntry` should not be assumed to change a Host-owned queue on another device.

Sources: [state derivation](../../lib/claude/steer.ts:63), [append persistence](../../hooks/chat/steer-runtime.ts:218), [HostState intent union](../../packages/agent-config-types/src/host-state.ts:232), [Host queue projection](../../lib/sync/host-state-service.ts:886), [Host mutations](../../lib/sync/host-state-service.ts:1882).

### 4. Historical messages and convenient resend

Desktop offers Edit and Resend for user messages. Edit opens a local draft; unchanged Resend immediately calls the same `onEditResend` handler with recorded text. Both are disabled while streaming or awaiting approval; the controller additionally guards pending admission. Assistant-message regeneration is separate.

`editAndResend` reconstructs available original attachments, carries the original context envelope and citations, resolves an edited leading `@handle`, tags the original question as a sibling, and sends a new branch variant. The previous continuation remains associated with the original variant. This reruns from that historical point; it does not append the same question after the latest conversation turn. Rooms implement the same sibling behavior. Mobile has a dedicated unchanged-resend action and edit pane using the shared command model.

Sources: [command gating](../../lib/chat/message-action-commands.ts:113), [renderer resend](../../components/chat/message-renderer.tsx:1265), [direct historical resend](../../hooks/chat/use-claude-chat-controller.ts:6712), [branch tagging](../../lib/chat/branch-regen.ts:107), [room edit](../../lib/chat/room/runner.ts:908), [mobile resend](../../components/mobile/chat/message-action-sheet.tsx:301).

Attachment reuse is substantial but not complete fidelity. Stored images and extracted document/audio content can be reconstructed. Native video bytes are not stored in the historical row; missing media bytes cannot be rebuilt. The resend path reports unavailable filenames instead of silently pretending it resent them. The inline historical editor edits text; it does not mount the full attachment composer.

Sources: [attachment reconstruction](../../lib/chat/attachments/resend.ts:111), [direct warnings and carry](../../hooks/chat/use-claude-chat-controller.ts:6743).

Desktop already has convenient recall for sending old text as a new message: ↑ at the start of the composer, ↓ to move forward or restore the stashed draft. It persists up to 100 entries per session, then also recalls recent text from other sessions with de-duplication. This history stores strings, not an original message ID, files, reply target, or complete context snapshot. It therefore covers text reuse but not full-message reuse. It is input-submission history, not a search/index of every historical transcript row; transcript edit/resend calls do not pass through the composer's `history.record` call.

Sources: [composer keys](../../components/chat/composer.tsx:2820), [input history](../../components/chat/composer/hooks/use-input-history.ts), [history persistence](../../lib/db/chat-input-history.ts:3), [record submission](../../components/chat/composer.tsx:2186).

### 5. CLI differences

The TUI collects busy-time plain messages into `string[]` through `STEER_ENQUEUE`; `useSteerQueue.takeSteer` joins them and clears the queue, and the turn driver sends the result at a boundary. The footer shows queue previews. The steer reducer exposes enqueue and clear, not per-entry edit, remove, move, or dispatch. This user-facing path is delayed follow-up delivery even when a backend supports a native live-steering operation through the separate agent/RPC layer.

The CLI does support input-history navigation and backtrack-to-edit. Editing submits through `forkConversationAt`, which truncates the persisted transcript under the same session ID and reloads the kept cells. That differs from the GUI's preserved sibling branches. Existing file changes are not reverted by this conversation edit; the CLI explicitly points to `/rewind both` for restoring files too.

Sources: [TUI submit](../../cli/src/tui/components/App.tsx:2393), [queue drain](../../cli/src/tui/components/app/use-steer-queue.ts), [queue reducer](../../cli/src/tui/state/reducer.ts:2248), [native adapter interface](../../cli/src/agent/session-runner.ts:314), [history edit](../../cli/src/tui/hooks/useAgentSession.tsx:1207).

## Gaps and suggested priority

| Priority | Gap                                                   | Evidence / acceptance criterion                                                                                                                                                                                                                             |
| -------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Direct drain marks delivery too early                 | `drainSteerVia` returns `void` from replay; `maybeDrainSteer` defaults to no admission wait, clears entries and marks them `applied` before dispatch. Confirm refusal/throw/missing sender with a targeted repro; retain recoverable state until admission. |
| P1       | Queue/Steer user intent is implicit                   | Add a visible behavior choice and one-message override; verify the same text can deliberately wait even when native steer is available. Existing IPC/HostState `now`/`next` support is reusable infrastructure, not a completed composer flow.              |
| P1       | Renderer queue/order restart recovery                 | Persist stable entries/order/delivery intent and reconcile uncertain submissions; prove restart/reconnect neither drops work nor duplicates accepted work. Reuse HostState concepts rather than adding another unrelated transport queue.                   |
| P1       | No independent queued turns or selected-item dispatch | Decide whether entries are independent follow-up turns or a deliberate merged instruction. For independent tasks, A must finish before B starts; selected-item send must not flush unrelated entries.                                                       |
| P2       | Accepted input has no edit/cancel window              | Pending editors only operate on renderer-queued entries. Define a runtime capability and deadline for replacing/canceling accepted-but-unconsumed input; after consumption use a new correction message.                                                    |
| P2       | Full-message reuse at current tail                    | Add an explicit restore-as-new-message action using the existing composer-restore and attachment-reconstruction helpers. Keep rerun-from-here distinct. Verify files, reply target, citations, and missing-media notices.                                   |
| P2       | Queue attachment editing                              | Current editors change text only; attachment counts are informational. Support add/remove/replace through the existing composer, preserving stable entry/order.                                                                                             |
| P2       | Host/local queue management parity                    | Introduce/route queue mutation commands to the owning Host with revision/ID checks. Verify one device's edits/order/removal appear on another before dispatch.                                                                                              |
| P2       | CLI queue-management parity                           | Replace anonymous strings with stable entries and expose row editing/order/removal/retry; connect an explicit live-steer choice to existing backend capabilities.                                                                                           |
| P2       | Submission/consumption status ambiguity               | Separate queued, submitted/accepted, consumed if observable, completed, failed, and uncertain-after-reconnect. Do not label confirmed model consumption based solely on an idle session.                                                                    |
| P2       | Queue edit versus drain races                         | `editPendingSteer` does not recheck current queue membership/state before rewriting the bubble; stale editors should fail or recover when dispatch already won. Add a deterministic drain-while-editing regression.                                         |

The first row is a source-confirmed ordering difference with room admission handling, not a claim that a live-provider loss was reproduced. Room store sinks call `maybeDrainSteer(..., true)` and `RoomRunner` resolves `onAccepted` or failure explicitly; direct chat does not use that handshake.

Sources: [direct replay callback](../../hooks/chat/claude-chat-events.ts:214), [default drain ordering](../../hooks/chat/steer-runtime.ts:489), [existing test asserting early applied](../../hooks/chat/steer-runtime.test.ts:564), [room admission callback](../../lib/chat/room/runner.ts:1017), [room sink](../../lib/chat/room/store-sinks.ts:54), [edit mutation](../../hooks/chat/steer-runtime.ts:273).

Recommended first delivery slice: delivery/admission correctness, explicit Steer/Queue semantics, and durable recoverable entries. Then expose independent dispatch and full-message reuse. Existing queue editors, DnD, branch helpers, attachment reconstruction, and history recall should be extended, not replaced.

## Verification

Executed existing targeted tests without coverage collection:

1. Queue/state/UI/attachment/mobile core: **10 suites, 344 tests passed**.
2. Direct controller, room hook/runner, renderer, branch semantics with name filter: **5 suites, 130 tests passed, 557 skipped by filter**.
3. Desktop input recall, Dexie history, CLI history: **3 suites, 28 tests passed**.

Total: **18 suites, 502 tests passed**. Existing tests emitted React `act(...)` warnings and expected mocked fallback/diagnostic logs; all selected suites exited successfully.

Commands:

```sh
rtk pnpm exec jest --runInBand --runTestsByPath lib/claude/steer.test.ts hooks/chat/steer-runtime.test.ts stores/chat/chat-store.test.ts components/chat/run-panel.test.tsx components/chat/run-panel.drag.test.tsx components/chat/message-parts/steer-status-badge.test.tsx lib/chat/message-action-commands.test.ts lib/chat/attachments/resend.test.ts components/mobile/chat/message-action-sheet.test.tsx cli/src/tui/components/app/use-steer-queue.test.ts
rtk pnpm exec jest --runInBand --runTestsByPath hooks/chat/use-claude-chat.test.ts hooks/chat/use-team-chat.test.ts lib/chat/room/runner.test.ts components/chat/message-renderer.test.tsx lib/chat/branch-regen.test.ts --testNamePattern='steer|Steer|editAndResend|resend|sibling|regenerate|branch owner|backtrack'
rtk pnpm exec jest --runInBand --runTestsByPath components/chat/composer/hooks/use-input-history.test.ts lib/db/chat-input-history.test.ts cli/src/tui/input/history.test.ts
```

No live Tauri/browser/device/provider flow was executed; no build, full typecheck, full lint, or coverage run was required for this research-only change. Mobile interaction quality, real runtime edit/cancel deadlines, and delivery under process/network loss remain unverified. Existing E2E sources were searched for dedicated steer/reorder/resend scenarios; this pass did not establish matching end-to-end coverage.

## Sources

- Current owning source files linked inline above.
- [ADR-0114: Chat message presentation](../content/docs/en/adr/0114-chat-message-presentation.md).
- [ADR-0177: A room is one conversation shape](../content/docs/en/adr/0177-a-room-is-one-conversation-shape.md).
- [Official current prompting controls](https://learn.chatgpt.com/docs/prompting#steering-and-queuing).
- [Official developer commands and keyboard history](https://learn.chatgpt.com/docs/developer-commands).
- [Official dated Codex/ChatGPT changelog](https://learn.chatgpt.com/docs/changelog).
- [Companion Codex release research](./2026-10-19-codex-steer-queue-updates.md).
- [Remote Host persistence and failure-recovery audit](./2026-10-19-remote-host-delivery-audit.md).

# Dynamic Island: notch placement and Cognia agent control

Date: 2026-09-25. Follows [2026-09-12-dynamic-island-completeness](./2026-09-12-dynamic-island-completeness.md).

The island could watch Cognia's own agents but not control them, and it sat in the wrong place on notched MacBooks. This change fixes the placement and routes each decision the island makes through the surface that already owns it. It adds no new executor and no new approval authority.

## Placement on notched displays

### Native window (`src-tauri/src/fleet/island_window.rs`)

Three tao 0.35 behaviors misplaced the window on macOS (source: `tao/src/platform_impl/macos/{window.rs,util/*.rs}`):

| Behavior                                                                                                                            | Effect                                                                                                                | Fix                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `set_outer_position` / `set_inner_size` convert `Physical*` using the window's **current** backing scale, not the target display's. | With a 1x external display next to the 2x notched panel, the window landed at half its coordinates and half its size. | Placement computes a logical frame (`island_frame`) and applies it with `LogicalSize` and `LogicalPosition`.                              |
| `set_inner_size` calls `-setContentSize:`, which keeps the frame's **bottom-left** corner fixed.                                    | Resizing after positioning pushed the top edge above the screen, so an expanding card slid off the top.               | macOS applies the size first, then pins the top-left.                                                                                     |
| `cursor_position` scales by the **primary** display, while `outer_position` and `outer_size` scale by the window's own display.     | On mixed-DPI setups, hover-to-reveal missed the island.                                                               | `cursor_hits_window` compares in logical px. The primary scale is read from AppKit on the main thread and re-sampled at geometry cadence. |

Windows keeps physical units and the old order (position, then size), because a move across a DPI boundary rescales the window there; Linux shares that path. On macOS the size is applied unconditionally, since a "skip if unchanged" read can see the size from before a still-queued resize. The content-size lock is held across the read and the apply, so a hover-loop tick cannot land a stale frame after an `island_resize`. The frame may also be exactly as tall as the housing strip (zero content height).

### Overlay layout (`lib/island/layout.ts`, `components/fleet/island-header.tsx`)

Where macOS reports the housing's width, the island is drawn as the housing grown wider:

- **Compact and minimal** live entirely in the menu-bar strip. Content sits in two ears either side of the camera, and nothing is drawn over the camera.
- **Idle minimal** is exactly the housing: black on black, so it is invisible, but it is still the hover target.
- **Expanded** grows downward from the housing. It is square at the screen edge and rounded below.

Before, a 420×44 pill hung below the menu bar over the frontmost app's toolbar, joined to the housing by a column. Where the housing's width is unknown, the flat pill remains and its content is padded below the inset.

A just-finished task holds the island out for `ISLAND_ANNOUNCE_MS`, named, instead of tucking it away unseen. The content `ResizeObserver` now ignores width-only changes. Before, it fired on every frame of the card's own width animation, and while a shrink was pending each frame cost two click-through IPC calls.

## Agent control and its owners

| Row owner                                       | Decision                                                           | Stop                           | Reply                                         | Owning path                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation (chat)                             | Allow, Always allow (unless the ask forbids a standing rule), Deny | Only while a turn is in flight | Yes; steers a running turn or starts the next | `hooks/chat/chat-control-bridge.ts` → the chat runtime's own `respondToApproval` and `stop`; room members via `lib/chat/approval-routing.ts` |
| Plan-step or budget gate                        | Approve, Reject                                                    | —                              | —                                             | `lib/ai/agent/team/gates/decide-pending-gate.ts`, shared with `GateModalsHost`                                                               |
| Durable run approval with a payload-free answer | Approve, Deny                                                      | —                              | —                                             | `lib/execution/run-control-dispatch.ts`, shared with the Agent Runs cockpit                                                                  |
| External session                                | Unchanged                                                          | Unchanged                      | Unchanged                                     | Rust hook ingress or the ACP manager                                                                                                         |

`lib/island/main-window-controls.ts` re-reads each authority at the moment of the press. `executeIslandAction` has already re-validated the intent against the projection.

A Cognia run whose session is a visible chat row now belongs to that conversation (`lib/island/conversations.ts`). It is titled by the conversation, merges with that conversation's approval, and opens the chat. Stop and reply are offered only for ordinary chats. Team rooms and workbenches run on other engines, so their own pages keep those controls.

Still decided in the main window, and labelled so on the row: Squad reviews that need a typed answer, human handoffs, ask-user questions, workflow approvals, and free-form external asks.

## Fixed along the way

- The sidecar streams `permission-request`, but an ALLOW is decided in the renderer and was only journalled. The live Fleet row for a Cognia run stayed "waiting for your approval" until the turn ended. Now `subscribeCanonicalAppends` (`lib/ai/agent/recovery/canonical-log.ts`) lets the unified Fleet store fold journalled resolutions. The chat controller's execution-handle branch now journals the `permission-resolved` that it used to skip.
- Every permission and question showed the hook ingress's 20-second countdown. ACP and chat asks became unanswerable after 20 seconds while still live. Rows now carry a real deadline or `null` (`answerWindow` in `lib/fleet/format.ts`).
- A refused decision, answer or reply now reports its reason on the row.
- Dead code removed: `ownerSource` and `sameOwner` were used only by tests. The team branches of `attentionOwner` and `dismissStale` were unreachable, since team gates became durable interrupts in ADR-0169. `useApprovalGate` was replaced by the shared gate helper. The overlay widgets' unused direct-command defaults are gone.

## Verification

- Rust: 37 island tests pass under `cargo test --lib fleet::island`, covering the logical frame, zero-height frames, mixed-DPI placement, the cursor space and the debug dump's field names. Clippy reports nothing in the island files.
- Jest: 85 suites and 1381 tests pass across the island, fleet, gate, run-control, chat, attention, Agent Runs, mobile Fleet and settings suites.
- Scoped `tsc`: no errors in the changed files.
- `lint:i18n` and `i18n:build` pass.
- Browser harness: the real `/island` page ran with a simulated Tauri bridge. It showed the minimal, expanded and compact-announcement notch presentations and the new chat and gate decision controls (with no countdown), and emitted correctly shaped intents.

Not verified: real macOS window placement on a notched panel and on a mixed-DPI external display. That needs `tauri-smoke` on a device.

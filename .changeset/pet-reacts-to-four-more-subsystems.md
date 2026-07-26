---
"cognia-next": minor
---

The desktop pet now reacts to four more subsystems, so it stops looking idle while the app is clearly busy. It notices when something is waiting on you (the Control Center's unified attention projection — chat approvals, team HITL gates, external-agent permission and input waits), when renderer background tasks start and settle, when a content capture is waiting for confirmation and when one lands, and when Source Control is mid-operation (commit / push / pull / fetch / sync / stage / checkout / stash / discard) or has failed.

Each adapter observes the narrowest seam it can and forwards no content: attention emits only on zero/non-zero edges so a burst of pending items does not produce a burst of reactions and stale journal entries are excluded; background tasks use the low-frequency start/settle seam rather than the subagent store that updates per token; capture reads a content-free persistence event, so no clipboard text, URL, image, fingerprint or source-app data reaches the pet event bus; and Source Control aggregates concurrent operations into one busy batch and forwards neither repository paths nor error text.

`PetRenderer` is also memoised, so an unrelated parent re-render no longer re-runs the whole sprite tree.

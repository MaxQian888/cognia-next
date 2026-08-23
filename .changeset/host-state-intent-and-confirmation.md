---
"cognia-next": minor
---

Remote sessions: a run's state now says what actually happened, not what was asked for.

**Stopping a run no longer looks stopped until it stops.** Pressing stop marked the turn finished immediately. If the request never reached the agent — a dropped connection, a busy host — the session read as stopped while the run kept going, and the composer came back for a turn that was still producing. A stop now shows as _stopping_ until the agent confirms it, and if the request never lands the session goes back to running and says the stop failed.

**Answering a prompt from a phone that drops out no longer loses the prompt.** Approving or declining a tool used to remove the request the moment you tapped, so an answer that never reached the desktop took the prompt with it — the run stayed blocked with nothing left to answer, recoverable only by reloading. The request now stays visible and marked as being answered, and returns to the queue if the answer does not arrive. If two devices answer at once, the second is told the first got there and refreshes, instead of overwriting it.

**A run waiting on several things shows all of them.** Approvals and questions were tracked in separate slots that could overwrite each other, so a second request could hide the first and strand the run on a prompt nothing displayed. They are now one list in the order the run raised them.

**A turn ending is not the conversation ending.** The end of one turn — and an agent restart — used to shut the composer for good. Both are now separate from whether the conversation exists: after a turn finishes or the agent restarts you can keep going, and only a deleted conversation locks it. A restart marks the interrupted work as interrupted and retryable rather than silently leaving it "running".

**A queued message that fails to send says so.** Sends, follow-ups, steers, stops and answers each carry their own status now — accepted, on its way, confirmed, or failed — so the app can tell a message that is still going from one that never left, and offer retry only where retrying makes sense. Queuing a message also no longer reports the transcript as changed before anything is written.

**Restarting the desktop picks up work left in flight.** Requests interrupted mid-send used to sit in the host's ledger forever after a restart, with the device that submitted them waiting on a reply that was never coming. They are now retried on startup, turns left running by the previous session are closed out, and if that recovery itself fails the host reports itself as degraded rather than presenting stale state as current.

**On upgrade:** cached remote-session coordination state is discarded and rebuilt on the next connection — conversations, messages and drafts are untouched. Messages still queued for sending that were written in the old format are dropped, because they can no longer be delivered.

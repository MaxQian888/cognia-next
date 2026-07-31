---
"cognia-next": minor
---

Mid-run follow-ups ("BTW") now actually reach the running agent. Typing while a turn is in flight hands the message straight into the live Anthropic sidecar stream instead of only queueing it for after the turn — the same path Lark/IM conversations already used. When no live lane exists (any non-Anthropic provider, a team turn, or a query whose input has already closed) it falls back to the existing queue-and-replay, now labelled honestly as "Queued" rather than claiming delivery.

Follow-ups also appear in the conversation the moment you type them, in your own words, with a delivery state (Queued → Delivered) and hover controls to edit or remove them before they send; the internal "By the way (steering): " framing is no longer shown back to you, and multiple follow-ups are no longer merged into one bubble. One that never made it — because the run errored or the app restarted — is kept and marked "Not delivered" with put-back / discard, instead of vanishing. The composer now stays writable while a tool awaits approval, which is exactly when redirecting matters most, and the run panel's "Send now" is renamed "Interrupt & send" with a first-use confirmation, since it cancels in-flight tool calls.

Branching a conversation now opens the branch **beside** its parent in a split pane rather than navigating away, so the original stays visible and can keep running (mobile, which has no split view, still switches). A branch's header shows which conversation it came from and jumps back to the exact branch point.

Adds a **side chat** to the right-hand workbench: an aside bound to the current conversation, seeded with its recent turns, for checking something without adding noise to — or spending turns in — the main thread. Any of its replies can be quoted back into the main composer.

Also fixes a pre-existing bug where quoting a message appended it to _every_ open composer instead of the one it was addressed to.

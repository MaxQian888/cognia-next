---
"cognia-next": minor
---

The side chat grows up. Type `/btw <question>` (or `/side`) to ask beside a conversation, even while its agent is mid-turn, or press ⌘; / Ctrl+; to jump into the side chat and back. A side chat now runs on the same agent, model, working directory and sandbox as its conversation, and is **read-only** until you switch it to "Can edit" (which grants the conversation's permissions, never more). On an external agent it uses that agent's own plan mode when it can enforce one and otherwise answers with the built-in agent, saying so. It is told the main transcript is reference only, so it answers your question instead of resuming the main task.

The main conversation's context now reaches the side chat incrementally — a snapshot first, then only what is new — instead of re-sending the same 8,000 characters on every turn, so side chat turns stay cheap and hit the prompt cache. Replies can be sent straight to the main thread (as a live follow-up when its agent is running), and "Bring back", "Send" and "Quote" no longer report success when nothing received the text: it lands in the conversation's draft instead.

Fixes: deleting a conversation now deletes its side chats and their messages (and a daily sweep removes ones left behind earlier); promoting the first side chat no longer turns it back into a side chat the next time the panel opens; clearing a side chat also forgets its seed and delivered context; side chats started by `spawn_task` keep receiving the main thread's context after their first turn, and their history now passes the PII gate like every other path.

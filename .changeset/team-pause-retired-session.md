---
"cognia-next": patch
---

Pausing an Agent Team teammate that runs on an external agent whose stop ends the whole session (such as DeepSeek Harness, or a gateway-managed session) no longer leaves the teammate "paused" on a session that no longer exists: the session is released, later steering waits for the teammate's next turn, and the teammate is parked for input when its unfinished work cannot be replayed safely.

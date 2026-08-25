---
"cognia-next": patch
---

Starting a conversation now keeps every setting it was seeded with. `createSession` accepted a full session config but persisted only a hand-listed subset, silently discarding the rest — so forking a conversation pinned to a non-default provider quietly reverted it to the app default, and a fork could land in the wrong workspace, on a different account, executor or tool filter than the conversation it claimed to continue. Forks now inherit the parent's full run configuration, and `startNewSession` can seed the Squad (executor) and workspace directly instead of going through the UI-active pointer.

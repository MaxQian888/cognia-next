---
"cognia-next": minor
---

Add DeepSeek Harness as an external agent backend over its stdio JSON-RPC SDK transport (experimental). Ships a Cognia-owned host composition and launcher in an isolated runtime home, with a read-only profile by default: the model can read and search but cannot write or run commands, and its attempt to self-escalate to workspace-write fails closed because no approval provider is composed. The SDK channel streams full tool, reasoning, usage, and subagent events, but cannot ask for approval mid-turn or cancel a single turn — cancelling closes the runtime.

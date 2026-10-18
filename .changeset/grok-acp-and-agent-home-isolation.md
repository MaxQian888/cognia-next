---
"cognia-next": minor
---

Add Grok Build as an ACP external agent, including its structured user questions and token usage. Grok, Kimi and other native agents keep their state in their own home directory, and gateway tasks no longer inherit the host's login. The DeepSeek harness moves to 0.2.1-rc.2: a turn now waits for managed sub-agents to finish, the working directory can be read and changed, and file access always goes through the sandboxed filesystem provider.

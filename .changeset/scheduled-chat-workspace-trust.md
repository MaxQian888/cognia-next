---
"cognia-next": patch
---

Scheduled chat, agent and skill runs now honour Workspace Trust on the desktop and the headless brain. A run in a workspace with an untrusted root runs in Restricted Mode like an interactive turn, with no disk or host-mutating tools, and ends as "needs approval" naming the roots to trust. A run in a trusted workspace now carries its trust grant onto its worktree, so native SDK skills and plugins load there.

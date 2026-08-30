---
"cognia-next": minor
---

Adds `project_history_search`, a read-only deep-path tool that lets a chat search its own workspace's earlier conversations — both what was said and what tools returned — and re-read a named message with its neighbouring turns as citable evidence. It is offered only when project continuity is enabled and the chat is bound to a workspace, is scoped to that workspace on both legs, refuses embedded and subagent transcripts, withholds hits that would carry PII (reported as a count rather than failing the call), and reports honest coverage when the search index is still catching up.

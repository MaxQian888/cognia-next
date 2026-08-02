---
"cognia-next": patch
---

Groundwork for the unified IDE dock: a layout kernel that resolves panels, tracks open instances, and persists arrangements per account, host and context. It reuses the Context Workbench's panel contract unchanged, so existing panels move into a dock tab without being rewritten. Nothing is wired into a visible surface yet — the chat dock is the first host to adopt it.

---
"cognia-next": patch
---

A turn dispatched to an external agent is now described as one. The frozen execution spec that every chat send carries named a sidecar runtime for every turn, including the ones routed to Codex or Claude Code, because the send path never told the resolver which lane it was on. The agent trace and the execution fingerprint both named a runtime that was not running, and two turns on different runtimes could share one fingerprint.

Scope worth naming: this makes the spec honest about the lane. The external-agent manager still does not gate on the spec's capability set, so capability enforcement for external turns remains future work rather than something this quietly claims.

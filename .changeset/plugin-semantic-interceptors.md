---
"cognia-next": minor
---

Plugin interceptors (ADR-0189): one registry and one dispatcher for observe / transform / guard / around, fixing a chat-middleware path that could send a turn's model request twice, a plugin message write that ignored its addressed session, and a transport that guessed retry-safety from method names.

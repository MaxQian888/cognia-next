---
"cognia-next": minor
---

Faster builds and dev startup (ADR-0068): `next build` no longer duplicates the CI typecheck, CI restores incremental typecheck state, sidecar prebuilds skip when fresh, and heavy boot runtimes (workflow/gateway/connector/scheduler/agent-team) load after first paint on all shells. Five subsystems are extracted to reusable source packages: @cognia/redact, @cognia/web-search, @cognia/tts, @cognia/logging, @cognia/agent-config-types.

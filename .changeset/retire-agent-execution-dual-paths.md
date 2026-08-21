---
"cognia-next": minor
---

Retire four "new implementation behind a default-off flag, legacy path kept alive" splits so each subsystem has exactly one implementation.

The unified Agent execution resolver (ADR-0090) is now the only execution path — `executeAgent` delegates to it, the duplicate `requireTools` precheck in `action.agent.turn` is gone, and every send stamps its resolved execution spec instead of leaving the sidecar on the legacy provider branch. Durable work submission (ADR-0125) is always on, so a crash can no longer leave a visible chat message that nothing will answer. Task Workspace isolation is GA: agents run in an isolated execution root rather than directly in the repository, and the developer toggle that disabled isolation is removed. Host-authoritative session state (ADR-0116) is likewise unconditional — its six-stage `migrationStage` ladder is deleted, along with the `host_state_not_authoritative` refusal.

Two behaviour changes are worth knowing about. Agent execution is now fail-closed: a run that requires tools with no host, an explicit execution policy that forbids fallback, a headless host, or an unsatisfied hard capability all fail before spending a turn instead of silently degrading. The one case that _did_ degrade silently still does — legacy `toolsEnabled` with no `requireTools` falls back to the text rail — but the result now says so via `degradedReason: "legacy-completion-fallback"`. Separately, HostState was structurally unreachable before this change: nothing in production ever advanced `migrationStage` past `legacy-authoritative`, so all four client shells permanently took the legacy path while the host advertised `session.state-sync@1` regardless.

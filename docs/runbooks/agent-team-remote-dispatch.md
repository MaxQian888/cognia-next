# AgentTeam Remote Dispatch Rollout Runbook

Date: 2026-08-12

## Preconditions

- The brain and every worker run a build containing `worker-dispatch-v1`.
- Companion pairing is enabled and the owner can create and revoke `agent.worker` grants.
- `developer.taskWorkspace` and `agentExecutionResolverV2` are enabled before `agentTeamRemoteDispatch`.
- Every worker has a trusted, pre-bound repository and a locally resolvable credential profile.
- Fleet reports the worker online, its capacity, runtime, and workspace binding readiness.

## Enroll and bind a worker

1. In Settings → Fleet → Execution Workers, create a one-time enrollment.
2. Run the displayed `cognia-agent worker enroll` command on the worker. Treat the enrollment as a secret until consumed.
3. Bind the repository locally:

   ```bash
   cognia-agent worker bind --repository-ref repository:<projectId>:<repositoryId> --path <local-git-root>
   ```

4. Start the worker:

   ```bash
   cognia-agent worker connect
   ```

5. Confirm that Settings and Fleet show the authenticated `device:<id>`, expected slot count, runtime, and binding readiness. Never copy an absolute worker path into the brain.

## Rollout phases

### Phase A — dark launch

- Keep `agentTeamRemoteDispatch` off.
- Enroll workers and verify reconnect, heartbeat, revocation, and Fleet projection.
- Confirm local AgentTeam behavior and old snapshots are unchanged.

### Phase B — single pinned canary

- Enable `NEXT_PUBLIC_AGENT_TEAM_REMOTE_DISPATCH` only on the canary brain deployment for the
  opt-in tenant. P0 flag scope is process/deployment-wide; do not share that brain process with
  non-opt-in tenants during the canary.
- Pin one teammate to one worker.
- Verify session creation, event progression, usage/evidence settlement, steer, pause/checkpoint, resume, and terminate.
- Stop if any task falls back to local execution, if one `commandId` creates more than one session, or if a repository path appears over the wire.

### Phase C — two-worker auto canary

- Connect two workers with `maxActiveTurns=1` and identical compatible manifests.
- Admit two independent children and verify they land on different authenticated host references.
- Fill one host and verify the next child selects the other. Fill both and verify the child stays queued with an actionable waiting reason.
- Inject disconnects after a safe checkpoint and after an unknown side effect. Only the safe case may migrate.

### Phase D — opt-in availability

- Expose Local, Auto, and Pinned selectors to the tenant.
- Monitor dispatch lease age, duplicate-event rejection, recovery-required count, worker last-seen age, and terminal settlement latency.
- Keep real Claude Code and Codex worker smoke tests in release validation; do not require external credentials in CI.

## Incident actions

### Stop new remote work

Disable `agentTeamRemoteDispatch`. This blocks new remote dispatch but does not discard events from existing sessions. Continue accepting controls and terminal receipts until every active lease is settled or explicitly recovered.

### Revoke a worker

Revoke `agent.worker` in Settings. The socket must close immediately and no new child may select that host. Inspect each active child:

- safe checkpoint: retry the same host when it returns, or choose a compatible host for `auto`;
- unknown effect, non-idempotent intent, or pending input: keep `recovery_required` and require an operator decision;
- terminal receipt already present: run the idempotent settlement path instead of redispatching.

### Suspected duplicate execution

Do not manually edit Dexie. Inspect the child `dispatchLeaseId`, remote `commandId`, `remoteSessionId`, and `lastRemoteEventId`. Re-send only through the AgentTeam manager. A repeated `commandId` must resolve to the original session, and duplicate event or terminal IDs must not change usage, evidence, or delivery totals.

### Full rollback

1. Disable `agentTeamRemoteDispatch`.
2. Let active sessions settle or move them through checkpoint-gated recovery.
3. Revoke worker grants if an emergency stop is required.
4. Roll back application binaries. Do not delete child remote fields, Task Workspace bindings, or device records; older builds ignore optional fields and preserving them keeps audit and recovery evidence intact.

## Release evidence

Archive the output of focused Jest tests, Agent SDK conformance and pack tests, focused Companion/SecurityStore/Task Workspace Rust tests, the deterministic two-worker integration test, web-headless and mobile E2E, static export/i18n/co-located-test checks, build, and the real-worker smoke checklist. Record any repository-wide pre-existing failure separately from failures introduced by this rollout.

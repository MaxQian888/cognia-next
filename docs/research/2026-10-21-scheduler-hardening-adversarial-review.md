# Scheduler follow-up research and adversarial review

Date: 2026-10-21 (Asia/Shanghai). Status: research and reviewed recommendations;
not implemented. Production code, account data and running schedules were not
modified in this round. The current shared checkout is the implementation source.

## Recommendation: strengthen existing owners before adding more recurring jobs

The next work should prioritize backup correctness, the complete quiet-notification
boundary, singleton identity, and truthful maintenance diagnostics. Add rolling
usage retention to an existing daily owner. Idle memory maintenance and recurring
backup verification are conditional enhancements, not unconditional new timers.

The detailed inventory and primary-source evidence are in
[the gap research](2026-10-21-scheduled-task-gap-research.md). This document records
the decisions after independent adversarial checking, including rejected claims.

| Priority    | Work                                                                           | Trigger/owner                                                         | Default user-visible behavior                                                                   |
| ----------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| P1          | Correct backup cadence identity and serialize conflicting writers              | Existing interval backup owner plus cron-local write boundary         | Quiet; user-requested backup result settings remain intact                                      |
| P1          | Complete maintenance silence across badges and titles                          | Existing scheduler attention/badge consumers                          | No new toast, notification-center row, IM, pet cue, navigation badge, OS badge, or title change |
| P1          | Prevent retired singleton reentry and unsafe ID collision adoption             | Existing scheduler lifecycle and maintenance installer                | Stable diagnostics reason; retain history and manual intent                                     |
| P2          | Show accurate per-target maintenance health                                    | Existing provider states, retention executors, diagnostics/detail     | Passive on-demand inspection only                                                               |
| P2          | Enforce the existing usage-retention policy during long uptime                 | Existing daily storage retention and usage domain owner               | Silent; no new provider poll or counter rebuild                                                 |
| Conditional | Enqueue eligible memory consistency work without a chat turn                   | Existing memory worker, durable day keys                              | Off unless existing effective configuration permits the exact operation                         |
| Conditional | Verify backups safely before commit/rotation; optionally reverify periodically | Existing backup writer/decoder; optional due check under backup owner | No restore, no plaintext cache, no routine alerts                                               |

## 1. Backup cadence needs durable producer and destination identity

The local interval path asks for the most recent successful data backup and only
then checks `type === scheduled` ([backup-scheduler.ts:112](../../lib/data/backup-scheduler.ts#L112),
[history query:113](../../lib/db/backup-history.ts#L113)). A newer manual row masks
a recent scheduled-local row; a newer remote scheduled row can postpone a due
local backup. The actual due policy has no `config.lastRunAt` fallback
([scheduler.ts:13](../../lib/data/scheduler.ts#L13)). An offline source-level probe
reproduced both decisions. This is not evidence of a production data-loss incident.

Filtering before limiting is necessary but insufficient: the shared history has
a 50-row cap and can lose the relevant success record
([backup-history.ts:4](../../lib/db/backup-history.ts#L4)). Define whether history
is presentation or cadence authority. Prefer a durable owner-scoped completion
watermark, using existing owner settings/metadata where their semantics fit;
specify producer, payload kind, destination/path and compatible content scope.
Explicitly define migration for legacy rows and for missing/cleared history.

The asynchronous interval has no in-flight guard
([backup-scheduler.ts:283](../../lib/data/backup-scheduler.ts#L283)). Serialize
conflicting writes; do not collapse different user requests. A cron task may
request different content or a different destination directory. Only truly
equivalent requests may share a result; distinct requests must execute separately.
Use a host/account-scoped lease only if the deployment has multiple local writers;
do not invent a global cross-host lock. Actual overlap/corruption was not reproduced.

**Acceptance:** mixed manual/local/remote/subscription history; history cap/clear;
legacy destination metadata; concurrent interval and cron with same versus
different content/path; ownership expiry only if a lease is introduced. Keep
existing opt-in, pause, cancellation and destination authorization.

## 2. Quiet includes badges and task identity, not only notification channels

`deriveAttention` already covers failed runs, consecutive failures, auto-pause,
unsupported types and suspended hosts. It also feeds the navigation badge
([nav-badge-probes.tsx:106](../../components/shell/nav-badge-probes.tsx#L106)), which
feeds OS and tab-title badges ([use-app-badge.ts:57](../../hooks/desktop/use-app-badge.ts#L57)).
Adding maintenance degradation there would breach passive-only diagnostics even
without an explicit push. The badge caller currently supplies `hostSuspended: false`.

New maintenance health belongs first in user-opened diagnostics/detail views.
Any shared attention integration must make notification/badge eligibility explicit
and use the real host/authority context. Existing explicit opt-ins and meaningful
user-authored reports, sends and approvals remain separate. Do not send a digest
of routine maintenance errors by default.

Retired duplicates are currently filtered from later reconciliation
([managed-tasks.ts:64](../../lib/scheduler/managed-tasks.ts#L64)). After a lifecycle
write reactivates such a row, it can remain active beside the canonical row. The
offline probe reproduces this in memory. Direct Resume rejects disabled tasks;
however `updateTask(status: active)` and the UI's disabled → Pause → Resume path
can bypass retirement. This is source-reachable, not a real-clock double-run proof.

Do not simply remove the retired-tag filter: the current non-active-first sort
could select a system-retired row and retire the healthy canonical. Define
retirement before status: with a surviving canonical, reject or explicitly
redirect reactivation of its retired copy; if the canonical disappeared, resolve
restoration/recreation explicitly without erasing execution history or a manual
pause. Check identity/ownership again on a unique-ID collision: a reserved ID's
mere existence does not make a wrong-type, plugin-owned or remote-host row a valid
concurrent winner ([managed-tasks.ts:79](../../lib/scheduler/managed-tasks.ts#L79)).

**Acceptance:** all quiet surfaces above; genuine user tasks unaffected; retired
reactivation through each lifecycle route; canonical removal; remote/plugin/wrong-
type collisions; overlapping installers; history and intentional pauses preserved.

## 3. Maintenance health must distinguish attempts, effective work and eligibility

The diagnostic probe produced `refreshed: 1, paused: 0` while the source became
`paused-auth`. The correct interpretation is that `refreshed` counts attempts;
it does not prove the source was marked successful. Existing source state already
has `lastAttemptAt`, `lastSuccessAt`, failure count and authentication pause
([refresh.ts:75](../../lib/provider-diagnostics/refresh.ts#L75)). Reuse these fields;
improve aggregate names/counts and their diagnostics projection rather than adding
a second health ledger or equating outer clock completion with target health.

Storage retention has a different limitation: exceptions become the same
`removed: 0` result as an empty healthy sweep
([retention.ts:252](../../lib/storage/retention.ts#L252)), and some file/deletion
substeps swallow errors before returning. Extend owner results with stable codes
and statuses such as completed-no-work, partial, blocked, off, failed and unknown.
A successful row prune must not hide a failed file sweep. Avoid raw exception
payloads, transcript/path contents, secrets, and extra validation scans.

Define clock liveness, source freshness and retention completion separately.
Provider due times include explicit backoff/auth pauses; some maintenance targets
are event-triggered; retention is an independent boot/interval loop. A universal
"N ticks since success" rule would create false alarms. Disabled, temporary,
locked, offline, remote-owned, intentionally paused or deadline-less event work
must retain an appropriate off/blocked/unknown state. Use existing indexed
schedule/due-state queries; a scheduled watchdog cannot independently detect the
death of the scheduler that runs it. No claim of complete process monitoring.

**Acceptance:** source failure with successful clock processing; mixed substep
outcomes; empty success; blocked key/vault; recovery clearing degradation; no
duplicate outer-failure signals or badge/title side effects; bounded content-free
summaries rather than a new unbounded event history.

## 4. Rolling usage retention is a missing trigger, not a new cleanup subsystem

Existing usage/cost pruning runs at boot, including on the brain
([initializers.ts:378](../../lib/headless/runtimes/initializers.ts#L378)). A row that
ages past the window during long uptime waits for another initializer run. Extend
the existing daily owner and catalog enforcement with the existing 90-day policy.
No disk/performance gain was measured and no new polling worker is justified.

Define cutoff semantics before wiring the helpers together. Raw usage uses an
epoch cutoff ([session-usage.ts:895](../../lib/db/session-usage.ts#L895)); rollups
use a local-day cutoff ([provider-cost-daily.ts:193](../../lib/db/provider-cost-daily.ts#L193)).
Midday boundary behavior and partial-failure/retry behavior must be explicit.
This observation alone does not establish a current financial-corruption bug or
an existing contract of exact equality across differently retained views. Keep
ledger/idempotency receipts, current budgets, today's totals and reporting
semantics intact; coordinate changes through the usage owner rather than adding
daily full projection rebuilds.

**Acceptance:** an 89-day row ages past policy without restart; boundary-day
records; two deletion steps with one failing; safe retry; current budget and
recent usage unchanged. State which records may be deleted versus retained for
idempotency/reconciliation.

## 5. Two conditional additions require stricter execution contracts

**Idle memory consistency.** Daily enqueue is opportunistic after eligible chat
activity; the worker only drains queued jobs. Extend its cheap due check if the
product wants eligible maintenance during idle uptime. Reuse durable UTC day keys
and scope/account isolation. The configuration must be checked when queued AND
when executed: the current lifecycle handler checks enabled but not temporary
([job-worker.ts:758](../../lib/memory/lifecycle/job-worker.ts#L758)). A job queued
before switching temporary mode must not compact/deduplicate persistent memory
afterward. Do not introduce learning, distillation, embeddings or model spend
without the effective operation-specific authorization. Existing failure-triggered
vector reconciliation is already present; do not replace it with unconditional
daily scans. This is a product enhancement, not proof that memory repair is absent.

**Backup verification.** Existing formats already validate checksums/authentication;
the gap is operational readback and safe commit ordering. "Write, then verify,
then rotate" is insufficient if writing already renamed over the same day's last
verified recovery point. Validate a distinct pending artifact before commit or
use independent immutable generations; failed validation must leave the previous
verified point intact. For V4, consume `readBackupStream` record-by-record without materializing `readStreamPackage`. V3 decrypts the whole ciphertext/plaintext: enforce a pre-read size ceiling and KDF-cost ceiling before invoking it, and report blocked/unsupported-over-budget when legacy artifacts exceed them. Do not describe the existing V3 reader as bounded. Never apply restore data.
Record write completion and verification separately. Optional periodic reverification
needs an explicit I/O budget, cadence and key-availability policy under the existing
backup owner. Do not perform automatic restore drills or cache decrypted snapshots.

**Acceptance:** queued → temporary/disabled before execution; two idle workers and
one daily key; no existing source changes needed when off. For backups: same-day
last verified file survives a corrupt new artifact; missing footer, wrong key,
read failure, oversized/KDF-over-budget V3 input and large V4 input without full-package materialization; no account-data writes; distinct requests
retain their content/destination semantics.

## Adversarial review record and decisions

Research was completed before two independent fresh-context read-only reviews:
`adversarial_backlog` and `adversarial_governance`, followed by a fresh-context revision pass (`adversarial_revision_check`). Findings were checked against
the owning source, not accepted solely on reviewer confidence.

| Finding                                                   | Classification and revision                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Verify after overwriting can destroy last verified backup | Valid/actionable: require pending artifact or immutable generation before commit                 |
| Single-flight can swallow distinct user backup requests   | Valid/actionable: separate write serialization from equivalence-based deduplication              |
| History filter alone fails after cap/clear                | Valid/actionable: specify durable cadence authority and legacy migration                         |
| Usage epoch/day boundary and partial failure              | Valid design concern: specify policy/coordination; reject unsupported corruption/equality claims |
| Memory authorization only checked at enqueue              | Valid/actionable: require execution-time checks and queued-mode-transition tests                 |
| `refreshed` means failed source was marked successful     | Contract misread: it counts attempts; persisted source state already tracks failure              |
| Top-level retention success proves file cleanup success   | Valid/actionable: report partial/blocked substeps without validation scans                       |
| Attention is passive-only                                 | Incorrect: badges/title consume it; isolate health or add explicit eligibility                   |
| Remove retired filter to fix reentry                      | Unsafe simplification: define canonical/retirement precedence and collision checks               |
| Disabled task directly resumes                            | Narrowed: direct Resume rejects; update/Pause→Resume routes remain reachable                     |

The revision pass also found stale serialization/verification advice in the companion note and an unsupported assumption that V3 reads were bounded. Both documents now use the same corrected contracts, and the reviewer confirmed those exact corrections without expanding the audit.

Rejected additions: duplicate storage/audit/GC/recovery engines, autonomous replay
of arbitrary failed side effects, a scheduler self-watch cron, automatic restore,
unconditional memory/model work, and routine maintenance notification summaries.
The alleged disabled balance-script execution was rejected: the balance owner
filters disabled sources before execution. Headless automation-audit configuration
was also not treated as a dropped setting where its API is explicitly unsupported.

Cross-model review was offered as required by `doubt-driven`; the user selected
repository-only review. No external CLI/model invocation occurred.

## Evidence and limits

Run from the repository root:

```sh
rtk proxy node docs/research/2026-10-21-scheduler-adversarial-probes.mjs
```

Three probes completed successfully: retired copy reentry left two active rows;
an authentication-failed source was counted as a processed refresh attempt; mixed
backup history produced both due-date misclassifications. These transpile current
source with injected memory-only dependencies. They are NOT production-clock,
real database, native I/O, concurrency, notification, or restore validation. Their
assertions capture current pre-fix behavior and need updating/retiring after fixes.
The probe script passed scoped ESLint with zero warnings; all three artifacts passed Prettier. Sixty local source links and line bounds were checked. No broad Jest, coverage, typecheck or build was run for this research-only change.

## Sources

- Primary implementation evidence: local links above and the companion gap research.
- [Kubernetes CronJob documentation](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/):
  approximate scheduling requires idempotent jobs; concurrency and missed-start
  policies are explicit. This supports reviewing lifecycle semantics, not adopting Kubernetes.
- [Temporal SchedulePolicies reference](https://typescript.temporal.io/api/interfaces/proto.temporal.api.schedule.v1.SchedulePolicies._Properties):
  overlap, catch-up and pause-after-retries are separate policies. Cognia already
  has corresponding mechanisms; adding these as new features would duplicate work.

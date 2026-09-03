---
title: "0167 - The schedule belongs to the account"
description: "The scheduler kept its own machine-wide unencrypted database outside data governance and backup, its permission policy had zero enforcement callers, and the only agent-facing tools were three IM-gated MCP calls. All three had the same root: the schedule was treated as a machine's property rather than the account's."
---

# ADR 0167 - The schedule belongs to the account

**Status:** Accepted
**Date:** 2026-09-04
**Related:** [ADR-0002](./0002-scheduler-agent-tool-resolution), [ADR-0026](./0026-marketplace-integrations), [ADR-0079](./0079-scheduler-extension-contract), [ADR-0128](./0128-host-neutral-scheduler)

## Context

Three complaints about the scheduler turned out to share one origin.

**The data was not the account's.** `lib/scheduler/scheduler-db.ts` opened a
Dexie database named `CogniaSchedulerDB` with a fixed name and no account
dimension. The main database has four properties this one lacked, and lacked
all four for the same reason. It was not per-account, so switching accounts
showed the same schedules. It did not carry
`createEncryptedContentMiddleware`, so prompts, goal objectives, webhook URLs
and IM conversation targets sat on disk in the clear while the equivalent
fields of a chat message did not. It was absent from `CORE_TABLE_NAMES`, so
`policyForTable` returned undefined for it and every retention, sync and
cleanup policy passed it by. And `lib/data/build-package.ts` had never heard
of it, so backup and export silently dropped every schedule a user had
configured.

`SchedulerPermissionPolicy` was worse: it lived in `localStorage` through the
store's zustand persist. A rule about what agents may do on the user's behalf
was stored in the one place that belongs to the browser profile rather than to
the person.

**The policy was decorative.** `agentAutoCreate`, `confirmationRequired`,
`maxTasksPerSource` and `scriptTasksEnabled` were editable in settings and
persisted. `useSchedulerStore.checkPermission`, the function that read them,
had zero callers anywhere in the repository. It also carried tests, which is
the worse failure mode: an unenforced policy that looks verified. Inside it,
the per-source count read `get().tasks.filter(() => true).length` behind a
comment admitting there was "no per-source tracking yet", although `createdBy`
had existed since scheduler schema v3.

Two other write paths made their own arrangements in the vacuum. The
agent-facing MCP tools in `lib/external-bridge/handlers/scheduling.ts`
enforced a hardcoded quota of eight per session that no setting could reach.
`lib/plugin/api/scheduler-tasks.ts` told plugin authors in a doc comment that
they "MUST consult this first" and did nothing to make that true.

**An agent could barely reach the schedule.** Those three MCP tools were the
whole agent surface, gated in `lib/claude/build-options.ts` behind
`imOverrideRow?.allowScheduleTools === true` and an IM adapter capability. A
desktop chat had no scheduler tools at all, so "remind me every morning" was
something the assistant could discuss and not do. Even in IM the tools could
create two task types on two trigger shapes, and offered no way to inspect,
amend, pause or run anything.

Meanwhile the scheduler already had executors for every kind of agent run the
product has: `chat`, `agent`, `skill`, `external-agent`, `agent-team`, `goal`,
`plan`, `workflow`. The capability was built. Nothing could ask for it.

## Decision

### 1. The two stores move into the account database

Schema v219 declares `scheduledTasks` and `scheduledTaskRuns` in
`CURRENT_SCHEMA`. They are named with a prefix because `tasks` and
`executions` are too vague among two hundred tables.

Two denormalized discriminators ride along. `eventType` existed already.
`createdBySource` is new, and is required rather than convenient: `createdBy`
is inside the encrypted payload after the fold, so a per-source quota could
not be answered without decrypting every row on every agent write.

Encryption and indexes do not conflict.
`lib/db/encrypted-content-middleware.ts` keeps every indexed property root in
plaintext metadata and encrypts the rest, so `[status+nextRunAt]` and its
siblings stay queryable while the payload does not.

**Host placement is unchanged.** ADR-0128 decision 6 says every host keeps its
own schedule and nothing hands tasks between hosts. That is a statement about
placement, and the account database is still local to its host.
`scheduler-host-target.ts` still routes a client to a paired host over
`scheduled_task_*` RPCs. Account scoping and host placement are different axes,
and this ADR moves only the first.

`SchedulerDatabase` survives as a facade so its call sites keep their method
surface, but it is deliberately no longer a Dexie subclass: the table getters
are private, so anything needing raw Dexie behaviour has to ask for it in that
module. That constraint immediately surfaced four callers that had been
reaching past the methods, including `lib/boot/startup-probe.ts` reading
`.tasks` directly and `cli/src/serve/durability.ts` registering the scheduler
as a second named database with its own flush hooks.

### 2. The legacy database is adopted once, and says where it went

`lib/scheduler/legacy-db-migration.ts` runs at scheduler init, before anything
reads the schedule. The honest limitation is stated in the module and logged at
runtime: the legacy database cannot say which account its rows belonged to,
because it never knew. They land in whichever account is active the first time
this runs, and the log names that account so a user with several can move what
belongs elsewhere. Guessing per row would be worse.

A legacy database that cannot be read is left in place and not marked done. The
rows inside are the user's only copy, so a fixed build has to be able to retry.

### 3. The policy is enforced on every non-user write

`lib/scheduler/write-authority.ts` is the one gate, and the store, the built-in
skills, the MCP tools and the plugin API all call it. It reads `AppSettings` at
check time rather than a store snapshot, so a long-lived tab cannot enforce a
policy the user has since tightened, and it works headless with no store
mounted. The per-source count uses the `[createdBySource+status]` index.

Two orderings are load-bearing.

The host gate runs first. Telling an agent "quota reached" for a task type this
host could never run is a misleading answer that sends it looking for the wrong
fix.

`confirmationRequired` is checked before `agentAutoCreate`, because the two
settings answer different questions: one is "may they act unattended", the
other is "which kinds always need me". In the other order the second list is
unreachable, because a type on it would be refused before anyone was asked.

A caller with no confirmation surface treats "needs confirmation" as a refusal
and names the scheduler panel instead. Deciding on the user's behalf is exactly
what the setting exists to prevent.

The policy moves to `AppSettings.schedulerPermissionPolicy`, classified
`device-local` in the settings-sync catalog: a schedule is host-owned, so the
rule governing it is legitimately per-host, and a phone creating a task on a
paired desktop is checked against the desktop's policy over the RPCs.

### 4. Agents get the whole verb set, as built-in skills

The `schedule.*` family under `lib/skills/built-in/scheduler/` follows ADR-0026:
`list`, `inspect`, `create`, `update`, `set_status`, `run_now`, `delete`. Built
as built-in skills rather than as more external-bridge tools because that tier
already carries the Zod schema, the PII gate, the A2UI confirmation card, the
audit trail and the per-channel allowlist, and because
`buildBuiltInSkillManifest` exposes the tier to non-IM sessions. That last
point is the one that mattered: it is what lets a desktop conversation reach
the schedule at all.

Two tier assignments are deliberate. `run_now` is `write` despite storing no
row of its own, because it causes the task's effects: an `im-push` task sends a
message, a `background-command` task runs a command. Classifying it `read`
because it writes nothing would be exactly the wrong reading. `delete` is
`destructive` and channel-opt-in because it is the only irreversible verb, and
the family routes anything phrased as "stop" or "pause" to `set_status`.

The three legacy tools keep their names and their gate, because IM
conversations are configured against them. They are not widened to match the
family: two write surfaces with the same reach means a second schema to keep in
step, and the family already reaches IM.

## Consequences

A schedule now behaves like the rest of the user's data. It is isolated per
account, encrypted at rest, governed, exported with a backup, and adopted from
the old machine-wide store on first launch.

The four permission settings do something. A user who turns off agent
auto-creation gets a refusal with a reason instead of a task appearing anyway,
and the per-source limit no longer counts the user's own schedules against an
agent's allowance.

An assistant in any conversation can put work on the schedule and read back
what is there, subject to two independent gates. One caveat is worth stating
plainly, because it is the difference between shipped and reachable: built-in
skills reach a non-IM session only when the active character has
`enableBuiltInSkills` turned on. That is a per-character switch and not a
per-family one, so the family is present and unusable for a character that has
it off.

Not done, and deliberately: `monitor`, `backup`, `plugin` and `custom` still
use the raw JSON payload editor. `monitor` needs a builder for a condition
union type, and the other three have their own authoring surfaces elsewhere.

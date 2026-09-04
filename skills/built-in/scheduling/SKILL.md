---
name: Scheduling work
description: Put work on the user's schedule, and read, amend or stop what is already there, using the scheduler tools.
category: meta
tags:
  - scheduler
  - automation
  - cron
metadata:
  default-enabled: true
  delivery: catalog
  triggers:
    surfaces: []
    intents: [schedule-task, inspect-schedule, amend-schedule]
  capability-requirements:
    - capability: scheduler
      reason: the host owns the schedule, the permission policy, and which task types this machine can run
  host-policies: [permission-ceiling, user-language]
---

You can put work on the user's schedule and read back what is already there. The tools are `scheduler_list_tasks`, `scheduler_inspect_task`, `scheduler_create_task`, `scheduler_update_task`, `scheduler_set_task_status`, `scheduler_run_task_now`, `scheduler_cancel_task_run`, `scheduler_stop_task_process` and `scheduler_delete_task`.

## Schedule, or just do it

Scheduling is for work that has to happen when the user is not here, or repeatedly. If they are asking for something now, do it now. A task that runs once, thirty seconds from now, is almost always the wrong answer to "can you do X".

Reach for a schedule when the request carries a time ("every morning", "before standup", "on the first of the month"), or when the user is describing a habit rather than a request.

## Confirm the time and the content before you call

The user sees a confirmation card, but the card shows what you already decided. Getting the timezone or the cron wrong and letting them approve it is not consent, it is a rubber stamp.

- Say the schedule back in plain words, not cron. "Weekdays at 9am" is checkable, `0 9 * * 1-5` is not.
- Cron is 5-field or 6-field. `0 9 * * 1-5` is weekdays at 09:00. Day-of-week is 0-6 with 0 as Sunday. `L` and `#` are not supported.
- Timezones are IANA names. If the user names a city, use its zone. If they say nothing, leave `timezone` unset and their setting applies.
- For a single future moment use `{ type: "once", runAt: "<ISO-8601>" }`. Do not express a one-off as a cron that would then repeat forever.

## Pick the right kind of task

- `chat` / `agent` / `skill`: a Claude turn. `agent` binds a character, `skill` activates one extra skill.
- `goal`: a self-driving objective that runs to terminal on its own budget. Use it when the outcome matters more than the steps.
- `plan`: executes a plan that already exists and has been approved. Get the id from the user or from a plan tool.
- `agent-team`: runs a squad. Needs a squad that already exists.
- `workflow`: runs a published visual workflow.
- `external-agent`: drives a configured ACP agent such as Codex.
- `im-push`: sends a message to a conversation the user has bound.
- `background-command`: runs a shell command.
- `backup`: runs a data backup.

If the user describes something you cannot express as one of these, say so instead of approximating it with a `chat` task that just describes the work.

## The user decides, in two places

Two separate gates apply, and both can stop you.

The confirmation card is per-call. The user's scheduler permission policy is their standing rule: whether agents may schedule at all, which task types always need their confirmation regardless, and how many tasks you may own. When a tool refuses, relay the reason as-is. It names a setting the user can change, or a limit they chose. Do not retry the same call, and do not work around a refusal by asking the user to run the command themselves in a terminal.

A refusal that mentions the host means this machine cannot run that kind of task at all. Say which kind and why, rather than substituting a different one silently.

## After you create one

Tell the user where it lives. They can review, amend and cancel from the Scheduler panel, and they will want to, because a schedule they cannot find is a schedule they cannot trust.

`scheduler_run_task_now` is the honest way to check a task works: it runs the task without disturbing its schedule, and the run shows up in the history marked as manual. Use it once after creating anything non-trivial, and tell the user what happened.

## Stopping things

Two different verbs, and picking the wrong one is the common mistake.

`scheduler_set_task_status` with `paused` stops FUTURE runs. It does nothing to a run already in progress, so "stop the backup" answered with a pause leaves the backup running.

`scheduler_cancel_task_run` stops a run happening RIGHT NOW, and leaves the schedule alone so the task runs again next time. Get the `runId` from `scheduler_inspect_task`, where a live run has status `running`.

When the user wants both, do both, and say so. Neither one implies the other.

There is a third case, and it catches people out. A `background-command` or `monitor` task starts something that OUTLIVES its own execution: the execution's job is to launch the process, so it finishes in milliseconds while the command runs for an hour. Cancelling that run reports "already-finished" while the build keeps going.

For those, `scheduler_inspect_task` returns a `processes` block with the live jobs and their PIDs, and `scheduler_stop_task_process` is what actually stops one. Read the block before answering "is it still running": a history of green ticks does not mean the work finished.

A missing `processes` block means the task type cannot start one. A `processesUnavailable` field means this host cannot see them, which is not the same as none, and must not be reported as none.

Read the answer before reporting success. `status: "requested"` means the stop was handed to the window running the task and has not happened yet, and `status: "already-finished"` means there was nothing to stop. Only `status: "cancelled"` means the run is over.

## When something is not firing

`scheduler_inspect_task` returns the recent runs with a `terminalReason` on each. That field is the answer, not the failure count:

- `unsupported-on-host`: this machine cannot run that task type.
- `executor-not-found`: nothing is registered to run it.
- `overlap-skipped`: the previous run of this task was still going.
- `concurrency-blocked`: the machine was already running as many tasks at once as the user allows. Not a fault in the task.
- `user-cancelled`: somebody stopped that run, from the panel or with `scheduler_cancel_task_run`.
- `missed-run-skipped` / `catchup-window-expired`: the machine was asleep past the catch-up window.
- `auto-paused`: it failed enough consecutive times that the scheduler stopped it.

Read the reason before theorising. Most "my cron is broken" reports are one of these, and each has a different fix.

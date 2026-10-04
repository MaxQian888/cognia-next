---
title: "0179 — The schedule answers one question"
description: "The scheduler repeated each count four times but did not show what required attention. Selection had no link, and mobile detail was empty. Adds one list, one detail composition for six kinds, an overview of items needing attention, and a URL for the open selection."
---

# ADR 0179 — The schedule answers one question

**Status:** Accepted
**Date:** 2026-09-13
**Related:** [ADR-0079](./0079-scheduler-extension-contract), [ADR-0128](./0128-scheduler-host-neutral), [ADR-0167](./0167-the-schedule-belongs-to-the-account), [ADR-0174](./0174-the-bot-control-plane)

## Context

Two audits on 2026-09-13 read every pane of `/scheduler` and `/me/scheduler`
against the data they render. The findings share a shape: the page repeats what
is cheap and omits what matters.

**Repetition.** Per-kind counts appeared in the sidebar groups, the filter
menu, the footer and the overview rail. "Upcoming" and "recent" appeared in the
overview, the right rail, the calendar and the timeline. The right rail existed
only while a detail was open and showed the two blocks the overview had just
scrolled away. Three detail compositions (app task, five other kinds, a
system-task sheet) carried three header idioms and three "recent runs" row
layouts, each with its own literal green/amber/red.

**Omission.** `ScheduledTask` carries `lastError`, `consecutiveFailures`, the
auto-pause outcome and the promotion record. `useSystemScheduler` carries the
pending OS confirmation. The host target knows when the local schedule is
suspended. The write-authority policy has a per-source quota. The unified hook
reports which source failed to load. None of these reached a pane. A user
opening the page could count their tasks four ways and could not see which one
had failed last night.

**Unaddressable.** No route under `app/scheduler/` or `app/me/scheduler/` read
a query parameter, while four emitters sent one (`?taskId=` from two sources,
`?task=` from ⌘K, `?systemTaskId=` from the OS source) and three more (the job
center, the workspace environment list, the composer's schedule suggestion)
navigated to the bare route with the intent lost. The composer hand-off stashed
a draft that only the desktop page consumed; on a phone the desktop route
redirects first, so the draft expired unread.

**Two schedulers.** The phone page shared the data layer and nothing else. Its
detail was mounted without `executions`, so every app task showed zero stats,
an empty chart and "no executions yet". Its stat strip summed app tasks under a
unified list. Its counts ignored the workspace scope. Its delete did not
confirm. The desktop page still carried a full mobile overlay of its own, built
with the complete prop set, that a compact viewport could never reach because
the same viewport was redirected away one line earlier.

## Decision

### 1. One detail composition for six kinds

`ItemDetail` renders every `UnifiedScheduledItem` the same way: a masthead
outside the scroller, alerts, then `ConsoleSection` cards in a container-query
grid, the composition `/bots` and `/devices` already use. A kind contributes a
`FactList` and, where it has one, extra sections; it does not contribute a
layout. The system-task inspect sheet is deleted, and OS tasks state plainly
that the OS keeps no run history rather than rendering an empty list.

A capability the source declares false renders a disabled control with a
reason. Hiding it collapsed three answers ("never existed", "one fix away",
"broken") into one, and the audit found each of the three behind a missing
button.

### 2. Selection is a URL; filters are a store

`?item=<unifiedId>` is the only way anything becomes selected, on both routes.
`?run=<unifiedId>` opens the run sheet. The three legacy parameters are
translated once by `lib/scheduler/page-query.ts` and replaced in the address
bar, so the emitters keep working without a coordinated change. A dynamic
`[id]` segment is not used because it breaks the Tauri static export, the same
reason `/bots` chose `?bot=`.

Search, status, kinds and loop-only move into the persisted scheduler store.
Two pages keeping two copies of the same filter is how the phone came to count
differently from the desktop.

### 3. The overview says what needs you

The first block is `AttentionBlock`, fed by a pure `deriveAttention` over the
unified items, the app tasks, the running runs and processes, the pending
confirmations, the host target, the source errors and the per-source counts
against `maxTasksPerSource`. Severity determines the order. Failure states and failed
sources come first. Confirmations, suspended hosts, unsupported types and
quotas above 80 % come next. Running work comes last, with a Stop control for
live processes. Below it one agenda replaces the calendar, the timeline and the upcoming
list, all of which were the same occurrences grouped three ways. The kind
summary appears once. The recharts bar chart, with its literal hex fills, is
replaced by a CSS outcome strip the detail shares.

### 4. The list is flat and the rail is gone

Rows are no longer grouped by kind. Order is attention, then running, then
soonest next run, then name. The per-row hover menu goes; actions belong to the
detail, the keyboard and the bulk toolbar, which now mounts inside the list
pane it claims to sit above. The right rail is not rendered; the shell keeps
the slot.

### 5. Host and authority live in the header

The host bar and the authority control become a Popover behind the header's
host summary. The header's `summary` names the host being managed and its
`status` says suspended or only-while-open. The sidebar host badge, which read
`getSchedulerDataSource().host` once per render and never noticed a switch, is
removed.

### 6. The phone is the same page, narrower

`/me/scheduler` renders the same `StatStrip` over unified statistics, the same
faceted counts, the same `ItemDetail`, the same run sheet and the same delete
confirmation, and consumes the composer draft. Creation there stays app-only;
bulk, templates, import/export and non-app creation remain desktop, because
each needs a surface the phone shell does not have.

### 7. Dead code leaves in its own commit

The desktop page's unreachable mobile overlay, the uncalled store actions and
hook returns, the two superseded plugin-cancel entry points and the components
the new panes replace are removed in one chore commit. Unused `scheduler.*`
keys are deleted only where this change confirms no consumer; the aggregates
are regenerated from the split sources.

## Consequences

One question has one answer on the page. A failed schedule is the first thing
on the overview, the first row in the list and the first alert in its detail,
computed once by one function with a test.

Every emitter that meant "open this task" now does. A run is a link.

The phone and the desktop cannot disagree about a count, a filter or a detail,
because they render the same components over the same store.

The form is deliberately not redesigned. Three fixes ride along because the
audit found them: the event-type preset picker whose copy existed for nine
presets while the form showed a bare text input; the dependency pickers that
shrank whenever the search box had text; and the progress-notification switch
that is labelled inert for every type but `plugin`, the only one with a
reporter (Working Rule 7).

Not done: a `listRuns` for OS tasks, which the platforms do not expose; task
hand-off between hosts (ADR-0128 decision 6 stands); non-app creation on the
phone.

## Amendment (2026-10-03)

A second audit read the panes against the same data and found what the first
left out.

**The detail did not say what a task does.** It showed when an item fires and
how it ended, never the prompt, command, workflow or handler it runs. A
"What it runs" section now renders `summarizeTaskPayload`
(`lib/scheduler/payload-summary.ts`) for every app-table row, resolving
referenced characters, workflows, plans, teams, agents and sessions by name
and saying when one no longer exists, with the stored JSON behind a toggle.
The outcomes section leads with `summarizeItemRuns`
(`lib/scheduler/item-run-stats.ts`): lifetime counters from the row when it
has them, duration and last result from the runs.

**Tags were write-only.** Nothing could set or clear them and search ignored
them. The form now edits them (`task-tags-input.tsx`) and always submits the
list, and search matches tags, with `#tag` for tags only.

**§4 amended (desktop).** The list pane's floor is 280px rather than a
percentage, which had crushed it to ~170px on a laptop; the host popover sits
beside refresh instead of in a header row of its own; the keyboard highlight
scrolls into view; the agenda lists three days before "show more".

**§6 amended (phone).** What needs you stays above two tabs: Tasks (search,
the desktop filter bar, rows without the checkbox that had nothing to check)
and Activity (stat strip, outcomes, agenda, recent runs). A refresh lives in
the header. The detail gets duplicate, backfill and the dependency graph,
which are dialogs; OS promotion stays desktop-only. Bulk actions, templates,
import/export and non-app creation remain desktop, as before.

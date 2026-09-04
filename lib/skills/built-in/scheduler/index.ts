/**
 * Scheduler built-in skill family (ADR-0026 tier, ADR-0002 / 0079 / 0128 subject).
 *
 * | id                   | mutation    | imAccess | tool                        |
 * |----------------------|-------------|----------|-----------------------------|
 * | schedule.list        | read        | always   | scheduler_list_tasks        |
 * | schedule.inspect     | read        | always   | scheduler_inspect_task      |
 * | schedule.create      | write       | always   | scheduler_create_task       |
 * | schedule.update      | write       | always   | scheduler_update_task       |
 * | schedule.set_status  | write       | always   | scheduler_set_task_status   |
 * | schedule.run_now     | write       | always   | scheduler_run_task_now      |
 * | schedule.cancel_run  | write       | always   | scheduler_cancel_task_run   |
 * | schedule.delete      | destructive | opt-in   | scheduler_delete_task       |
 *
 * Why this family exists: the only agent-facing scheduler surface was three
 * MCP tools in `lib/external-bridge/handlers/scheduling.ts`, gated behind an
 * IM adapter capability plus a per-conversation switch. A desktop chat had no
 * scheduler tools at all, and even in IM the tools could create two task types
 * on two trigger shapes, with no way to inspect, amend, pause or run one.
 *
 * Those three tools still exist under their original names and gate, because
 * IM conversations are configured against them. They now share this family's
 * policy gate rather than a hardcoded quota of their own.
 *
 * Two gates apply to every write, and they answer different questions. The
 * dispatcher's HITL card asks "do you want THIS one". The user's
 * `SchedulerPermissionPolicy`, checked in `_core.ts`, is their standing rule
 * about whether agents may schedule at all, which kinds always need them, and
 * how many an agent may own.
 *
 * NOTE for anyone wondering why the assistant cannot see these on the desktop:
 * built-in skills reach a non-IM session only when the active character has
 * `enableBuiltInSkills` turned on (`lib/claude/build-options.ts`). That is a
 * per-character switch, not a per-family one.
 */

import "./list"
import "./inspect"
import "./create"
import "./update"
import "./set-status"
import "./run-now"
import "./cancel-run"
import "./delete"

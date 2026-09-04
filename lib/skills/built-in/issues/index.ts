/**
 * Issue tracker built-in skill family (ADR-0132 slice ③).
 *
 * | id                        | mutation    | imAccess | requires |
 * |---------------------------|-------------|----------|----------|
 * | issue.list                | read        | always   | []       |
 * | issue.get                 | read        | always   | []       |
 * | issue.list_projects       | read        | always   | []       |
 * | issue.create              | write       | always   | []       |
 * | issue.update              | write       | always   | []       |
 * | issue.comment             | write       | always   | []       |
 * | issue.run                 | write       | always   | []       |
 * | issue.cancel_run          | write       | always   | []       |
 * | issue.create_project      | write       | always   | []       |
 * | issue.update_project      | write       | always   | []       |
 * | issue.delete              | destructive | opt-in   | []       |
 * | issue.delete_project      | destructive | opt-in   | []       |
 *
 * The family started as `create` plus `list_projects`, which made the tracker
 * write-only from a model's point of view: an assistant could file an issue
 * and then never read it, edit it, assign it, run it or close it. The rest of
 * the table closes that gap against the same data layer the board uses, with
 * `_core.ts` holding the one write path so the board's capability bits and its
 * run-active guard apply to an agent exactly as they apply to a drag.
 *
 * Platform-neutral: every write goes through the local Dexie tracker and
 * answers over the governed outbound queue. Nothing here touches an adapter.
 */

import "./list"
import "./get"
import "./list-projects"
import "./create"
import "./update"
import "./comment"
import "./run"
import "./cancel-run"
import "./create-project"
import "./update-project"
import "./delete"
import "./delete-project"

/**
 * Issue tracker built-in skill family (ADR-0132 slice ③).
 *
 * | id                  | mutation | imAccess | requires |
 * |---------------------|----------|----------|----------|
 * | issue.create        | write    | always   | []       |
 * | issue.list_projects | read     | always   | []       |
 *
 * Platform-neutral: the write path goes through the local Dexie tracker and
 * answers over the governed outbound queue; nothing here touches an adapter.
 */

import "./create"
import "./list-projects"

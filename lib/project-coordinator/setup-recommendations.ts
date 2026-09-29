import type { Project } from "@/types"
import type { ScheduledTask } from "@/types/scheduler"
import { primaryRootOf } from "@/lib/workspace/roots"

/**
 * The one-off setup offer on a new project's first coordinator turn
 * (ADR-0204). Built from what the workspace already has — its roots and its
 * schedules — and asked for as `propose_threads`, so it arrives as a card the
 * person starts from rather than work that simply begins.
 *
 * Offered once: the caller records `coordinator.setupOfferedAt` when it
 * includes the section. A send that then fails loses the offer, which is the
 * right side to err on for a suggestion.
 */

export const SETUP_MAX_SCHEDULES = 8

export interface SetupFacts {
  project: Partial<Pick<Project, "roots">>
  schedules: ReadonlyArray<Pick<ScheduledTask, "name" | "status">>
}

/** Whether to offer setup: never offered, and nothing has been started yet. */
export function shouldOfferSetup(input: {
  setupOfferedAt: number | undefined
  threadCount: number
}): boolean {
  return input.setupOfferedAt === undefined && input.threadCount === 0
}

export function buildSetupRecommendationsSection(facts: SetupFacts): string {
  const roots = facts.project.roots ?? []
  const primary = primaryRootOf(facts.project)
  const others = roots.filter((root) => root.id !== primary?.id)
  const schedules = facts.schedules.slice(0, SETUP_MAX_SCHEDULES)
  const lines = [
    "## Project setup (first turn only)",
    "This project was just set up. After answering the user, offer a starting plan with propose_threads — the user starts what they want. Offer this once; do not repeat it on later turns.",
    "Suggested threads:",
    primary
      ? `- An exploration thread that maps ${primary.label?.trim() || primary.path}: layout, build and test commands, and where the work in the user's request would land.`
      : "- An exploration thread that maps the working folder: layout, build and test commands.",
    ...others.map(
      (root) =>
        `- A thread for ${root.label?.trim() || root.path} (root_id ${root.id}) if the request touches it.`
    ),
  ]
  if (schedules.length > 0) {
    lines.push(
      "",
      "Schedules already running in this workspace (they keep running; mention any that overlap the plan):",
      ...schedules.map((task) => `- ${task.name} (${task.status})`)
    )
    if (facts.schedules.length > schedules.length) {
      lines.push(`- …and ${facts.schedules.length - schedules.length} more`)
    }
  }
  return lines.join("\n")
}

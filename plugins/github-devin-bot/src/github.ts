/**
 * The Devin Bot's own work model. GitHub reading, CI selection and resource
 * ids come from `@cognia/github-bot-kit`, shared with the other GitHub Bots.
 */

/** The integration slot every GitHub read and write of this Bot binds to. */
export const GITHUB_SLOT = "github"

export interface Work {
  repository: string
  number: number
  kind: "issue" | "pr"
  mode: "implement" | "review" | "repair"
  revision: string
  workflowRunId?: number
  workflowAttempt?: number
}

export function workId(work: Work): string {
  // CI deliveries share one repair identity for a commit, even when several jobs fail.
  return `${work.repository.toLowerCase()}/${work.kind}/${work.number}/${work.mode}/${work.revision}`
}

export function parseWork(value: unknown, repository: string): Work {
  if (!value || typeof value !== "object") throw new Error("Invalid work event")
  const work = value as Work
  if (
    work.repository?.toLowerCase() !== repository.toLowerCase() ||
    !Number.isSafeInteger(work.number) ||
    work.number < 1 ||
    !["issue", "pr"].includes(work.kind) ||
    !["implement", "review", "repair"].includes(work.mode) ||
    typeof work.revision !== "string" ||
    !work.revision ||
    (work.kind === "issue" && work.mode !== "implement") ||
    (work.kind === "pr" && work.mode === "implement")
  ) {
    throw new Error("Invalid or out-of-scope work event")
  }
  return work
}

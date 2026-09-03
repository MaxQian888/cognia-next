/**
 * Where a finished run's work actually landed.
 *
 * Executors have always recorded this. A `chat` / `agent` / `skill` run writes
 * `output.sessionId`, a `goal` run writes `goalId` and `sessionId`, a `plan`
 * run writes `planId`, a squad run writes `teamId`, a workflow run writes
 * `runId`. None of it was ever rendered: the run detail sheet showed the
 * output as a JSON blob, so a user whose scheduled agent had produced a whole
 * conversation overnight could see that it succeeded and had no way to reach
 * what it said.
 *
 * Pure on purpose. The derivation is the part worth pinning in a test, and
 * keeping navigation out of it means the sheet, the history list and anything
 * later can render the same answer differently.
 */

/** Where a run's product can be opened. */
export interface RunArtifactLink {
  /** Which surface owns it. Drives the label and the icon. */
  kind: "session" | "goal" | "plan" | "squad" | "workflow-run"
  /** The owning record's id. */
  id: string
  /**
   * Route to open. A session has no route of its own (the chat pane is the
   * root), so it is `null` and the caller focuses the session instead.
   */
  href: string | null
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Derive every reachable product of one run, most specific first.
 *
 * Order matters: a goal run carries BOTH `goalId` and the `sessionId` the loop
 * ran in, and the goal is the thing the user asked for. Listing the session
 * first would bury it.
 */
export function runArtifactLinks(output: unknown): RunArtifactLink[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return []
  const source = output as Record<string, unknown>
  const links: RunArtifactLink[] = []

  const goalId = readString(source, "goalId")
  if (goalId) links.push({ kind: "goal", id: goalId, href: "/goals" })

  const planId = readString(source, "planId")
  if (planId) links.push({ kind: "plan", id: planId, href: "/agent-runs" })

  const teamId = readString(source, "teamId")
  if (teamId) links.push({ kind: "squad", id: teamId, href: "/squads" })

  const sessionId = readString(source, "sessionId")
  if (sessionId) links.push({ kind: "session", id: sessionId, href: null })

  // Only when nothing more specific was found: a workflow run id is the least
  // useful of these on its own, and several executors carry a `runId` that
  // means something else entirely.
  if (links.length === 0) {
    const runId = readString(source, "runId")
    if (runId) links.push({ kind: "workflow-run", id: runId, href: "/workflows" })
  }

  return links
}

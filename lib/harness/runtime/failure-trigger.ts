/**
 * Background-mode reaction to a failed turn (ADR-0237): queue a run that
 * replays the failed request. Nothing runs here; the scheduled sweep starts
 * queued background runs within its interval and per-sweep cap, so a burst of
 * failures never turns into a burst of spending.
 *
 * Only failures `decideFailureOffer` classifies as harness failures qualify,
 * with the same cooldown and per-conversation dedupe the chat's offer uses.
 */

import type { AppSettings, Character } from "@cognia/agent-config-types"
import type { CogniaDiagnostic } from "@cognia/diagnostics"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import {
  decideFailureOffer,
  taskDraftFromFailedTurn,
  type FailureOfferDecision,
} from "../failure-offer"
import { harnessEvolutionSettingsOf } from "../settings"
import type { StartHarnessRunInput } from "./start"

export interface FailureTriggerDeps {
  getSettings(): Promise<AppSettings | null>
  resolveCharacter(id: string): Promise<Character | undefined>
  listRuns(characterId: string): Promise<HarnessEvolutionRun[]>
  start(input: StartHarnessRunInput): Promise<{ created: boolean; run: HarnessEvolutionRun }>
  now(): number
}

export interface FailedTurnContext {
  sessionId: string
  characterId?: string
  projectId?: string
  workingDirectory?: string | null
  diagnostic: Pick<CogniaDiagnostic, "code">
  /** The failed turn's request. */
  prompt: string
  messageId?: string
}

export type FailureTriggerOutcome =
  | { kind: "enqueued"; runId: string; created: boolean }
  | { kind: "skipped"; reason: Exclude<FailureOfferDecision, { kind: "enqueue" }>["kind"] | string }

/** Queue a background run for a failed turn, when the settings and the failure call for one. */
export async function enqueueRunForFailure(
  turn: FailedTurnContext,
  deps: FailureTriggerDeps
): Promise<FailureTriggerOutcome> {
  const settings = harnessEvolutionSettingsOf(await deps.getSettings())
  const agent = turn.characterId ? await deps.resolveCharacter(turn.characterId) : undefined
  const decision = decideFailureOffer({
    settings,
    diagnostic: turn.diagnostic,
    agent: agent ?? null,
    prompt: turn.prompt,
    runs: agent ? await deps.listRuns(agent.id) : [],
    sessionId: turn.sessionId,
    now: deps.now(),
  })
  if (decision.kind !== "enqueue") {
    return { kind: "skipped", reason: decision.kind === "none" ? decision.reason : decision.kind }
  }
  const draft = taskDraftFromFailedTurn({
    sessionId: turn.sessionId,
    prompt: turn.prompt,
    ...(turn.messageId ? { messageId: turn.messageId } : {}),
    ...(turn.workingDirectory !== undefined ? { workingDirectory: turn.workingDirectory } : {}),
    ...(turn.projectId ? { projectId: turn.projectId } : {}),
  })
  const input = (task: StartHarnessRunInput["task"]): StartHarnessRunInput => ({
    characterId: (agent as Character).id,
    trigger: "background",
    task,
    sessionId: turn.sessionId,
    ...(turn.projectId ? { projectId: turn.projectId } : {}),
  })
  try {
    const { created, run } = await deps.start(input(draft))
    return { kind: "enqueued", runId: run.id, created }
  } catch (error) {
    // A working directory that is not a repository (or has no commit yet):
    // replay in a fresh scratch directory instead of giving up. Refusals
    // about the run itself (off, no model, no agent) are not retried.
    const name = (error as { name?: unknown })?.name
    const code = (error as { code?: unknown })?.code
    const notARepo =
      code === "no-commit" || (name !== "HarnessStartError" && name !== "HarnessCaptureError")
    if (draft.isolation === "git" && notARepo) {
      const scratch = { ...draft, isolation: "files" as const }
      delete scratch.git
      const { created, run } = await deps.start(input(scratch))
      return { kind: "enqueued", runId: run.id, created }
    }
    throw error
  }
}

/** Production dependencies. */
export async function defaultFailureTriggerDeps(): Promise<FailureTriggerDeps> {
  const [settings, characters, store, start] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/lib/db/characters"),
    import("@/lib/db/harness-evolution"),
    import("./start"),
  ])
  const startDeps = await start.defaultStartDeps()
  return {
    getSettings: async () => (await settings.getSettings()) ?? null,
    resolveCharacter: characters.resolveCharacterById,
    listRuns: (characterId) => store.listHarnessRuns({ characterId, limit: 100 }),
    start: (input) => start.startHarnessRun(input, startDeps),
    now: Date.now,
  }
}

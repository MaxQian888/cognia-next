/**
 * Auto-orchestration pipeline (pure, platform-agnostic).
 *
 * `planAutoOrchestration` turns a single objective into an
 * `AutoOrchestrationProposal` by chaining the three stages:
 *
 *   redact → assessRouting → composeRoster → decomposeTasks
 *
 * PII is redacted up-front via `redactText` and re-checked with
 * `hasNoLeakingPii` — a HARD, fail-CLOSED gate: if anything still looks like a
 * secret after redaction, the pipeline throws rather than send it to a model.
 * Every downstream stage is fail-OPEN, so a flaky model degrades to a
 * deterministic heuristic instead of wedging.
 *
 * The proposal uses index-based references and creates no store rows — see
 * `materialize.ts` for turning an approved proposal into a runnable team.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import type { TeamExecutionPattern } from "@/types/agent/agent-team"
import { assessRouting } from "./assess-routing"
import { composeRoster } from "./compose-roster"
import { decomposeTasks } from "./decompose-tasks"
import { gatherCapabilityCatalog, EMPTY_CAPABILITY_CATALOG } from "./capability-catalog"
import { gatherTwinRoster } from "./twin-roster"
import { chooseExecutor, type ConsensusSignal } from "./dispatch-executor"
import type { AutoOrchestrationProposal, CapabilityCatalog, TwinRosterEntry } from "./types"

export class AutoOrchestrationPiiError extends Error {
  constructor() {
    super("auto-orchestration: objective still contains PII after redaction — refusing to send")
    this.name = "AutoOrchestrationPiiError"
  }
}

/** Result of the PII gate: the safe text plus whether anything still leaked. */
export interface PiiGateResult {
  redacted: string
  leaked: boolean
}

/** Default PII gate — structural redaction then a residual-leak re-check. */
export function defaultPiiGate(objective: string): PiiGateResult {
  const { redacted } = redactText(objective)
  return { redacted, leaked: !hasNoLeakingPii(redacted) }
}

export interface PlanAutoOrchestrationInput {
  /** Raw operator objective. Redacted internally before any model call. */
  objective: string
  client: LlmClient
  /** Pre-built catalog; gathered live when omitted. */
  catalog?: CapabilityCatalog
  /**
   * Pre-built digital-employee (twin) roster; gathered live when omitted. Pass
   * `[]` to explicitly disable twin binding for this run.
   */
  twinRoster?: TwinRosterEntry[]
  /** Cap on roster size (incl. lead). */
  maxRoster?: number
  /**
   * Force the execution pattern instead of the routing-assessed one. When set,
   * it overrides `assessment.recommendedPattern` *before* roster composition so
   * the roster and the materialized team both honor the operator's choice.
   */
  preferredPattern?: TeamExecutionPattern
  signal?: AbortSignal
  /** Injected clock for deterministic timestamps in tests. */
  now?: () => Date
  /** Injectable PII gate (default {@link defaultPiiGate}). */
  piiGate?: (objective: string) => PiiGateResult
  /**
   * Operator consensus/verification signal. Opts into a council/ensemble
   * executor, which the router can't recommend on its own. Threaded into
   * `chooseExecutor` to populate `proposal.executor`.
   */
  consensusSignal?: ConsensusSignal
}

/**
 * Plan an auto-orchestration proposal for `objective`. Throws
 * {@link AutoOrchestrationPiiError} if redaction can't fully clear the
 * objective; otherwise always resolves with a complete proposal (stages fail
 * open to heuristics).
 */
export async function planAutoOrchestration(
  input: PlanAutoOrchestrationInput
): Promise<AutoOrchestrationProposal> {
  // 1. PII gate — fail closed.
  const gate = (input.piiGate ?? defaultPiiGate)(input.objective)
  if (gate.leaked) throw new AutoOrchestrationPiiError()
  const objective = gate.redacted

  // 2. Catalog + digital-employee roster (both fail open to empty so
  // enumeration never wedges the pipeline).
  let catalog = input.catalog
  if (!catalog) {
    try {
      catalog = await gatherCapabilityCatalog()
    } catch {
      catalog = EMPTY_CAPABILITY_CATALOG
    }
  }
  let twinRoster = input.twinRoster
  if (!twinRoster) {
    try {
      twinRoster = await gatherTwinRoster()
    } catch {
      twinRoster = []
    }
  }

  // 3. Stages.
  const assessed = await assessRouting({
    objective,
    catalog,
    client: input.client,
    signal: input.signal,
    now: input.now,
  })
  // Operator pattern override wins over the routing assessment, so roster
  // composition + materialization both plan for the chosen pattern.
  const assessment = input.preferredPattern
    ? { ...assessed, recommendedPattern: input.preferredPattern }
    : assessed
  const roster = await composeRoster({
    objective,
    assessment,
    catalog,
    client: input.client,
    maxRoster: input.maxRoster,
    twinRoster,
    signal: input.signal,
  })
  const tasks = await decomposeTasks({
    objective,
    roster,
    assessment,
    client: input.client,
    signal: input.signal,
  })

  // Choose the concrete executor from the (possibly operator-overridden)
  // assessment + consensus signal. Pure — no model call.
  const executor = chooseExecutor(assessment, input.consensusSignal)

  return {
    objective,
    assessment,
    roster,
    tasks,
    executor,
    ...(twinRoster.length > 0 ? { twinRoster } : {}),
  }
}

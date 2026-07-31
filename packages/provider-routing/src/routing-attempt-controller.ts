import type {
  RouteCandidate,
  RoutingAttemptState,
  RoutingPlan,
} from "@cognia/provider-types/auto-router"

/**
 * Attempt state machine shared by routed execution surfaces. It owns the
 * pre-commit-only replay invariant and indexes the plan's complete candidate
 * list, where the primary is index zero.
 */
export class RoutingAttemptController {
  readonly state: RoutingAttemptState
  private readonly maxTotalAttempts: number
  private wasCommitted = false

  constructor(
    private readonly plan: RoutingPlan,
    maxFallbackAttempts: number,
    private readonly now: () => number = () => Date.now(),
    initialState?: Pick<RoutingAttemptState, "phase" | "candidateIndex" | "committedAt">
  ) {
    this.maxTotalAttempts = Math.max(1, 1 + Math.max(0, maxFallbackAttempts))
    this.state = {
      decisionId: plan.decisionId,
      phase: initialState?.phase ?? "planned",
      candidateIndex: initialState?.candidateIndex ?? 0,
      ...(initialState?.committedAt !== undefined ? { committedAt: initialState.committedAt } : {}),
    }
    this.wasCommitted = initialState?.phase === "committed"
  }

  begin(): RouteCandidate | null {
    const candidate = this.current()
    if (!candidate) {
      this.state.phase = "failed"
      return null
    }
    this.state.phase = "inFlight"
    return candidate
  }

  current(): RouteCandidate | null {
    if (this.state.candidateIndex >= this.maxTotalAttempts) return null
    return this.plan.orderedCandidates[this.state.candidateIndex] ?? null
  }

  commit(): void {
    if (this.state.phase !== "inFlight") return
    this.wasCommitted = true
    this.state.phase = "committed"
    this.state.committedAt = this.now()
  }

  complete(): void {
    this.state.phase = "completed"
  }

  cancel(): void {
    this.state.phase = "cancelled"
  }

  failAndAdvance(): RouteCandidate | null {
    if (this.wasCommitted || this.state.phase === "cancelled") {
      this.state.phase = "failed"
      return null
    }
    const nextIndex = this.state.candidateIndex + 1
    if (nextIndex >= this.maxTotalAttempts || nextIndex >= this.plan.orderedCandidates.length) {
      this.state.phase = "failed"
      return null
    }
    this.state.candidateIndex = nextIndex
    this.state.phase = "inFlight"
    return this.current()
  }
}

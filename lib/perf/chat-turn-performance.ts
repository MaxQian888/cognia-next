import { measureRange } from "./perf-marker"

export type ChatTurnPerformanceOutcome = "completed" | "failed" | "cancelled"

export interface ChatTurnPerformanceMeasure {
  name: string
  startTime: number
  endTime: number
}

interface ChatTurnPerformanceDependencies {
  now: () => number
  measure: (measure: ChatTurnPerformanceMeasure) => void
}

interface ActiveChatTurn {
  startedAt: number
  dispatchedAt?: number
  firstResponseAt?: number
  finalPersistenceStartedAt?: number
}

const DEFAULT_DEPENDENCIES: ChatTurnPerformanceDependencies = {
  now: () => (typeof performance === "undefined" ? 0 : performance.now()),
  measure: ({ name, startTime, endTime }) => measureRange(name, startTime, endTime),
}

/**
 * Coordinates the renderer-visible chat latency lifecycle.
 *
 * The lower-level `perf-marker` module only writes individual User Timing
 * entries. This recorder owns the cross-callback state needed by chat turns:
 * sends and SDK events happen in different async callbacks, multiple sessions
 * may stream concurrently, and a provider fallback can re-enter `send` without
 * starting a new user-visible turn.
 */
export class ChatTurnPerformanceRecorder {
  private readonly activeTurns = new Map<string, ActiveChatTurn>()

  constructor(
    private readonly dependencies: ChatTurnPerformanceDependencies = DEFAULT_DEPENDENCIES
  ) {}

  /** Begin a user-visible turn. Re-entry keeps the original start timestamp. */
  begin(sessionId: string): void {
    if (!sessionId || this.activeTurns.has(sessionId)) return
    this.activeTurns.set(sessionId, { startedAt: this.dependencies.now() })
  }

  /** Record the first provider/agent dispatch for this turn. */
  markDispatched(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId)
    if (!turn || turn.dispatchedAt !== undefined) return
    turn.dispatchedAt = this.atOrAfter(turn.startedAt)
    this.write("chat:dispatch-latency", turn.startedAt, turn.dispatchedAt)
  }

  /**
   * Record that the host dropped a retried command as a duplicate
   * (`command_ack { duplicate: true }`, ADR-0127). Written as a zero-length
   * `chat:command-dedupe` range so the PerfHud / renderer collector count how
   * often at-least-once retries actually collide, without needing an active
   * turn — an interrupt or approval can be retried after the turn sealed.
   */
  markCommandDeduped(sessionId: string): void {
    if (!sessionId) return
    const at = this.dependencies.now()
    this.write("chat:command-dedupe", at, at)
  }

  /** Record the first assistant-visible frame, whether text or a tool call. */
  markFirstResponse(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId)
    if (!turn || turn.firstResponseAt !== undefined) return
    turn.firstResponseAt = this.atOrAfter(turn.startedAt)
    this.write("chat:time-to-first-response", turn.startedAt, turn.firstResponseAt)
  }

  /** Begin the terminal durable write that makes the rendered turn reload-safe. */
  beginFinalPersistence(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId)
    if (!turn || turn.finalPersistenceStartedAt !== undefined) return
    turn.finalPersistenceStartedAt = this.atOrAfter(turn.startedAt)
  }

  /** Finish the terminal durable write without ending the turn itself. */
  endFinalPersistence(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId)
    if (!turn || turn.finalPersistenceStartedAt === undefined) return
    const endedAt = this.atOrAfter(turn.finalPersistenceStartedAt)
    this.write("chat:final-persistence", turn.finalPersistenceStartedAt, endedAt)
    turn.finalPersistenceStartedAt = undefined
  }

  /** Finish the turn exactly once and emit total plus outcome-specific latency. */
  finish(sessionId: string, outcome: ChatTurnPerformanceOutcome): void {
    const turn = this.activeTurns.get(sessionId)
    if (!turn) return
    const endedAt = this.atOrAfter(turn.startedAt)

    if (turn.finalPersistenceStartedAt !== undefined) {
      this.write("chat:final-persistence", turn.finalPersistenceStartedAt, endedAt)
    }
    if (turn.firstResponseAt !== undefined) {
      this.write("chat:response-stream", turn.firstResponseAt, endedAt)
    }
    this.write("chat:turn", turn.startedAt, endedAt)
    this.write(`chat:turn:${outcome}`, turn.startedAt, endedAt)
    this.activeTurns.delete(sessionId)
  }

  private atOrAfter(startTime: number): number {
    return Math.max(startTime, this.dependencies.now())
  }

  private write(name: string, startTime: number, endTime: number): void {
    this.dependencies.measure({ name, startTime, endTime })
  }
}

export const chatTurnPerformance = new ChatTurnPerformanceRecorder()

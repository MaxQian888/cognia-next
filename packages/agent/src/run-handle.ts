import type { AgentEventEnvelope, AgentTurnOutcome, CommandReceipt } from "./types"

export interface RunEventOptions {
  signal?: AbortSignal
  /** Bounded queue capacity for this subscriber alone. */
  capacity?: number
}

/**
 * A turn that is already running.
 *
 * `session.run()` remains the blocking convenience call. This is what you reach
 * for when the caller has to react to the turn while it happens — settle a
 * permission, forward deltas to a UI, cancel on a deadline — because with only
 * a blocking call, consuming events and awaiting the result are the same
 * `await`, and the caller deadlocks. (The README used to show exactly that.)
 */
export interface AgentRunHandle {
  readonly sessionId: string
  /** Stable id of the `turn/run` command. Reuse it to retry idempotently. */
  readonly commandId: string
  /**
   * Newest event id delivered to any stream from this handle, or the session
   * head captured before the turn started when nothing has arrived yet. This is
   * the resume point after a `BackpressureError` or a reconnect.
   */
  readonly cursor: string | undefined
  events(options?: RunEventOptions): AsyncIterable<AgentEventEnvelope>
  /** Resolves with the terminal outcome, or rejects with a typed error. */
  readonly result: Promise<AgentTurnOutcome>
  abort(reason?: string): Promise<CommandReceipt>
}

export interface RunHandleDeps {
  sessionId: string
  commandId: string
  /** Session head captured before `turn/run` was written. */
  startCursor: string | undefined
  subscribe: (
    afterEventId: string | undefined,
    options: RunEventOptions
  ) => AsyncIterable<AgentEventEnvelope>
  result: Promise<AgentTurnOutcome>
  abort: (reason?: string) => Promise<CommandReceipt>
}

class RunHandle implements AgentRunHandle {
  #cursor: string | undefined

  constructor(private readonly deps: RunHandleDeps) {
    this.#cursor = deps.startCursor
    // The caller may never touch `result`; an unobserved rejection must not
    // take the process down before they do.
    void deps.result.catch(() => undefined)
  }

  get sessionId(): string {
    return this.deps.sessionId
  }

  get commandId(): string {
    return this.deps.commandId
  }

  get cursor(): string | undefined {
    return this.#cursor
  }

  get result(): Promise<AgentTurnOutcome> {
    return this.deps.result
  }

  events(options: RunEventOptions = {}): AsyncIterable<AgentEventEnvelope> {
    // Replay from the pre-run head, so a stream opened late still sees the
    // whole turn and two independent streams see identical sequences.
    const upstream = this.deps.subscribe(this.deps.startCursor, options)
    const track = (envelope: AgentEventEnvelope) => {
      this.#cursor = envelope.eventId
    }
    return {
      async *[Symbol.asyncIterator]() {
        for await (const envelope of upstream) {
          track(envelope)
          yield envelope
        }
      },
    }
  }

  abort(reason?: string): Promise<CommandReceipt> {
    return this.deps.abort(reason)
  }
}

export function createRunHandle(deps: RunHandleDeps): AgentRunHandle {
  return new RunHandle(deps)
}

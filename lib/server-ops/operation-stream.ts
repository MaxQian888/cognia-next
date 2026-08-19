import type { Operation, OperationEvent } from "./client"

interface OperationStreamClient {
  streamEvents(options: {
    lastEventId?: number
    signal?: AbortSignal
  }): AsyncGenerator<OperationEvent>
  getOperation(id: string): Promise<Operation>
}

export interface FollowOperationStreamOptions {
  signal: AbortSignal
  onOperation: (operation: Operation, event: OperationEvent) => void
  onError?: (error: unknown) => void
  sleep?: (milliseconds: number) => Promise<void>
}

export async function followOperationStream(
  client: OperationStreamClient,
  options: FollowOperationStreamOptions
): Promise<void> {
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let lastEventId: number | undefined
  let retryDelay = 1000

  while (!options.signal.aborted) {
    try {
      for await (const event of client.streamEvents({
        lastEventId,
        signal: options.signal,
      })) {
        lastEventId = event.id
        const operation = await client.getOperation(event.operationId)
        options.onOperation(operation, event)
        retryDelay = 1000
        if (options.signal.aborted) return
      }
    } catch (error) {
      if (options.signal.aborted) return
      options.onError?.(error)
    }

    if (options.signal.aborted) return
    await sleep(retryDelay)
    retryDelay = Math.min(retryDelay * 2, 30000)
  }
}

/** Operation states past which the controller sends no further updates. */
const TERMINAL_STATES: ReadonlySet<Operation["state"]> = new Set([
  "succeeded",
  "failed",
  "rolled_back",
  "rollback_failed",
  "cancelled",
])

export function isTerminalOperation(operation: Operation): boolean {
  return TERMINAL_STATES.has(operation.state)
}

export interface PollOperationUpdatesOptions {
  signal: AbortSignal
  /**
   * The operations still worth re-reading, evaluated fresh on every tick so
   * newly queued work joins the loop without restarting it — and so finished
   * work leaves it.
   */
  pending: () => readonly string[]
  onOperation: (operation: Operation) => void
  onError?: (error: unknown) => void
  /** Default 5s: the controller's own event poll runs on a 2s interval. */
  intervalMs?: number
  sleep?: (milliseconds: number) => Promise<void>
}

/**
 * Track operation progress by re-reading each unfinished operation.
 *
 * The fallback for shells that cannot hold the SSE stream open — the mobile and
 * web transports are both buffered, and a body that never ends never resolves
 * there. It is strictly worse than the stream (it only ever learns about
 * operations this client already knows the id of, so work started from another
 * device stays invisible until a manual refresh), which is exactly why desktop
 * gets the native stream instead of everyone getting this.
 *
 * A failed read is reported and retried on the next tick rather than ending the
 * loop: one unreachable operation must not stop the others from updating.
 */
export async function pollOperationUpdates(
  client: Pick<OperationStreamClient, "getOperation">,
  options: PollOperationUpdatesOptions
): Promise<void> {
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const interval = options.intervalMs ?? 5000

  while (!options.signal.aborted) {
    await sleep(interval)
    if (options.signal.aborted) return
    for (const id of options.pending()) {
      if (options.signal.aborted) return
      try {
        options.onOperation(await client.getOperation(id))
      } catch (error) {
        if (options.signal.aborted) return
        options.onError?.(error)
      }
    }
  }
}

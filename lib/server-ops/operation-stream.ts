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

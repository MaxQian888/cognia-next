/**
 * A push → async-iterable bridge. React re-renders push text deltas in; the TTS
 * orchestrator's `speakStream` pulls them out as an `AsyncIterable<string>`.
 * Values pushed before the consumer asks for them are buffered in order.
 */
export interface PushableStream {
  /** Feed the next chunk. No-op after close. */
  push(chunk: string): void
  /** Signal end-of-stream; a pending/next pull resolves as done. */
  close(): void
  /** The pull side handed to `speakStream`. */
  readonly stream: AsyncIterable<string>
}

export function createPushableStream(): PushableStream {
  const queue: string[] = []
  let pending: ((r: IteratorResult<string>) => void) | null = null
  let closed = false

  const push = (chunk: string): void => {
    if (closed) return
    if (pending) {
      const resolve = pending
      pending = null
      resolve({ value: chunk, done: false })
    } else {
      queue.push(chunk)
    }
  }

  const close = (): void => {
    if (closed) return
    closed = true
    if (pending) {
      const resolve = pending
      pending = null
      resolve({ value: undefined as unknown as string, done: true })
    }
  }

  const stream: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as string, done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as string, done: true })
          }
          return new Promise((resolve) => {
            pending = resolve
          })
        },
      }
    },
  }

  return { push, close, stream }
}

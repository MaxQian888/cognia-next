// Streaming input async-iterable used by both dispatch paths to push
// user-turn messages into the underlying SDK / streamText call.
//
// Extracted from `claude-host.mjs` so the same primitive is shared between
// the Anthropic dispatcher and the AI-SDK dispatcher.

export interface InputStream<T> {
  /** Consumed once by the SDK; ends when the stream closes. */
  readonly iterable: AsyncIterable<T>
  /** Queue an item. `false` once the stream is closed (the item is dropped). */
  push(item: T): boolean
  /** End the stream: pending and future reads resolve `done`. */
  close(): void
}

export function makeInputStream<T = unknown>(): InputStream<T> {
  const queue: T[] = []
  const waiters: Array<(result: IteratorResult<T, undefined>) => void> = []
  let closed = false

  const push = (item: T): boolean => {
    if (closed) return false
    const waiter = waiters.shift()
    if (waiter) {
      waiter({ value: item, done: false })
    } else {
      queue.push(item)
    }
    return true
  }

  const close = (): void => {
    closed = true
    for (let waiter = waiters.shift(); waiter; waiter = waiters.shift()) {
      waiter({ value: undefined, done: true })
    }
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as T, done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true })
          }
          return new Promise((resolve) => waiters.push(resolve))
        },
        return(): Promise<IteratorResult<T, undefined>> {
          close()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }

  return { iterable, push, close }
}

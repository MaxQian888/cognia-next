// Streaming input async-iterable used by both dispatch paths to push
// user-turn messages into the underlying SDK / streamText call.
//
// Extracted from `claude-host.mjs` so the same primitive is shared between
// the Anthropic dispatcher and the AI-SDK dispatcher.

export function makeInputStream() {
  /** @type {Array<any>} */
  const queue = []
  /** @type {Array<{resolve: (v: any) => void}>} */
  const waiters = []
  let closed = false

  const push = (item) => {
    if (closed) return false
    if (waiters.length > 0) {
      waiters.shift().resolve({ value: item, done: false })
    } else {
      queue.push(item)
    }
    return true
  }

  const close = () => {
    closed = true
    while (waiters.length > 0) {
      waiters.shift().resolve({ value: undefined, done: true })
    }
  }

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true })
          }
          return new Promise((resolve) => waiters.push({ resolve }))
        },
        return() {
          close()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }

  return { iterable, push, close }
}

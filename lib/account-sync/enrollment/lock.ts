/**
 * One registry change at a time per space, across tabs and windows of this
 * profile: two appends built on the same head would make one of them fail
 * with `head_moved` after the person already confirmed it. Uses the Web Locks
 * API where the shell has it, and an in-process queue otherwise.
 */

const queues = new Map<string, Promise<unknown>>()

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

function lockManager(): LockManagerLike | null {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks
  return locks && typeof locks.request === "function" ? locks : null
}

export function withSpaceLock<T>(spaceId: string, operation: () => Promise<T>): Promise<T> {
  const name = `cognia-account-sync:${spaceId}`
  const locks = lockManager()
  if (locks) return locks.request(name, operation)
  const previous = queues.get(name) ?? Promise.resolve()
  const result = previous.then(operation)
  queues.set(
    name,
    result.catch(() => {})
  )
  return result
}

/** Shared by scheduler producers and the manual/native file sink without importing either runtime. */
const queues = new Map<string, Promise<unknown>>()

export function normalizedBackupPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

/** A queue, not single-flight: each distinct request executes, including after a failure. */
export async function withBackupLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const name = `cognia:backup:${key}`
  const previous = queues.get(name) ?? Promise.resolve()
  const enter = () => {
    const locks = globalThis.navigator?.locks
    return locks?.request ? locks.request(name, work) : work()
  }
  const run = previous.then(enter, enter)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  queues.set(name, settled)
  void settled.then(() => {
    if (queues.get(name) === settled) queues.delete(name)
  })
  return run
}

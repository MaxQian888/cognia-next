/** Pending picker writes, including runtime controls, ordered per conversation.
 * The welcome lane uses null so session creation can wait before reading defaults.
 */
interface PendingSelection {
  promise: Promise<void>
  signal?: AbortSignal
}

const pendingSelections = new Map<string | null, PendingSelection[]>()

function latestSelection(sessionId: string | null): PendingSelection | undefined {
  const selections = pendingSelections.get(sessionId) ?? []
  for (let index = selections.length - 1; index >= 0; index--) {
    const selection = selections[index]
    if (!selection.signal?.aborted) return selection
  }
}

export function persistModelSelection(
  sessionId: string | null,
  operation: () => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const previous = latestSelection(sessionId)?.promise
  const run = async () => {
    signal?.throwIfAborted()
    await operation()
  }
  const scheduled = previous ? previous.catch(() => undefined).then(run) : run()
  const next = signal
    ? new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
        void scheduled
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort))
      })
    : scheduled
  const selection = { promise: next, signal }
  const selections = pendingSelections.get(sessionId) ?? []
  selections.push(selection)
  pendingSelections.set(sessionId, selections)
  const clear = () => {
    const index = selections.indexOf(selection)
    if (index >= 0) selections.splice(index, 1)
    if (selections.length === 0 && pendingSelections.get(sessionId) === selections) {
      pendingSelections.delete(sessionId)
    }
  }
  void next.then(clear, clear)
  return next
}

/** Read model state only after the latest selection has finished saving. */
export async function waitForModelSelection(sessionId: string | null): Promise<void> {
  let pending = latestSelection(sessionId)
  while (pending) {
    try {
      await pending.promise
    } catch (error) {
      const newer = latestSelection(sessionId)
      if ((!newer || newer === pending) && !pending.signal?.aborted) throw error
    }
    pending = latestSelection(sessionId)
  }
}

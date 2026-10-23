/** Pending picker writes, including runtime controls, ordered per conversation.
 * The welcome lane uses null so session creation can wait before reading defaults.
 */
const pendingSelections = new Map<string | null, Promise<void>>()

export function persistModelSelection(
  sessionId: string | null,
  operation: () => Promise<void>
): Promise<void> {
  const previous = pendingSelections.get(sessionId)
  const next = previous
    ? previous.catch(() => undefined).then(operation)
    : (async () => operation())()
  pendingSelections.set(sessionId, next)
  const clear = () => {
    if (pendingSelections.get(sessionId) === next) pendingSelections.delete(sessionId)
  }
  void next.then(clear, clear)
  return next
}

/** Read model state only after the latest selection has finished saving. */
export async function waitForModelSelection(sessionId: string | null): Promise<void> {
  let pending = pendingSelections.get(sessionId)
  while (pending) {
    try {
      await pending
    } catch (error) {
      const newer = pendingSelections.get(sessionId)
      if (!newer || newer === pending) throw error
    }
    pending = pendingSelections.get(sessionId)
  }
}

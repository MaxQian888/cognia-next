/**
 * Shared "pre-tool seam": a single dispatch point fired before any mutating
 * tool executes. Observers subscribe to inspect the pending tool call and may
 * veto it; `dispatch` aggregates those votes into the first deny decision (or
 * `undefined` when nothing objects). Kept pure + side-effect free so the
 * ordering/aggregation contract is verifiable without driving a live turn.
 */

/**
 * Tool names treated as mutating (state-changing on disk/notebook). Observers
 * that only care about destructive operations can gate on `ev.isMutating`.
 */
export const MUTATING_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "str_replace",
  "create",
])

/** The pending tool invocation handed to a pre-tool observer. */
export interface PreToolEvent {
  toolName: string
  args: Record<string, unknown>
}

/** An observer's verdict on a pending tool call. */
export interface PreToolDecision {
  deny: boolean
  reason?: string
}

/**
 * A pre-tool observer. Receives the event enriched with `isMutating`; returning
 * a deny decision vetoes the call. Returning `void`/`undefined` abstains. May
 * be sync or async.
 */
export type PreToolObserver = (
  ev: PreToolEvent & { isMutating: boolean }
) => Promise<PreToolDecision | void> | PreToolDecision | void

/** The seam handle: classify, subscribe observers, and dispatch events. */
export interface PreToolSeam {
  isMutating: (tool: string) => boolean
  subscribe: (obs: PreToolObserver) => () => void
  dispatch: (ev: PreToolEvent) => Promise<PreToolDecision | undefined>
}

/**
 * Create a pre-tool seam. Pass a custom `mutating` set to override the default
 * {@link MUTATING_TOOLS} classification (e.g. for tests or restricted profiles).
 */
export function createPreToolSeam(mutating: Set<string> = MUTATING_TOOLS): PreToolSeam {
  const observers: PreToolObserver[] = []

  const isMutating = (tool: string): boolean => mutating.has(tool)

  const subscribe = (obs: PreToolObserver): (() => void) => {
    observers.push(obs)
    return () => {
      const i = observers.indexOf(obs)
      if (i >= 0) observers.splice(i, 1)
    }
  }

  const dispatch = async (ev: PreToolEvent): Promise<PreToolDecision | undefined> => {
    const enriched = { ...ev, isMutating: isMutating(ev.toolName) }
    for (const obs of [...observers]) {
      const decision = await obs(enriched)
      if (decision && decision.deny) return decision
    }
    return undefined
  }

  return { isMutating, subscribe, dispatch }
}

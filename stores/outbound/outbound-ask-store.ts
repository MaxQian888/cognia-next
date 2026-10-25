/**
 * The host's outbound ask dialog queue (ADR-0239 phase 2b).
 *
 * Something an agent is about to send that a person at this computer must
 * decide (a browser submission to a site nothing authorized) waits here
 * until `OutboundAskDialog` answers it: allow once, allow for this request,
 * or refuse. The dialog shows the oldest question first.
 *
 * {@link requestOutboundAsk} returns `null` when no dialog is mounted (a
 * headless Host, a shell that renders no UI), so the caller can ask some
 * other way instead of waiting on a question nobody can see. Nobody answering
 * within the ttl expires the question; the caller's signal withdraws it.
 */

import { create } from "zustand"

export type OutboundAskAnswer = "once" | "request" | "refuse"

export type OutboundAskResult = OutboundAskAnswer | "expired" | "withdrawn"

export interface OutboundAskEntry {
  id: string
  /** The site's origin, or `null` for a page with no site. */
  site: string | null
  /** `request`: a submission is held; `possible`: an action may submit. */
  basis: "request" | "possible"
  /** The request method (`POST`, `WS`), or the action (`click`). */
  operation: string
  /** Who drives the action, for the dialog's caption. */
  asker: "chat" | "external-bridge"
  /** "Allow for this request" is offered. */
  forRequestOffered: boolean
  createdAt: number
  expiresAt: number
}

interface OutboundAskState {
  entries: OutboundAskEntry[]
  /** How many dialogs are mounted; a question is asked only when one is. */
  hosts: number
  mountHost: () => () => void
  answer: (id: string, answer: OutboundAskAnswer) => void
}

interface Waiter {
  settle: (result: OutboundAskResult) => void
}

const waiters = new Map<string, Waiter>()

export const useOutboundAskStore = create<OutboundAskState>()((set) => ({
  entries: [],
  hosts: 0,
  mountHost: () => {
    set((state) => ({ hosts: state.hosts + 1 }))
    let mounted = true
    return () => {
      if (!mounted) return
      mounted = false
      set((state) => ({ hosts: Math.max(0, state.hosts - 1) }))
    }
  },
  answer: (id, answer) => settle(id, answer),
}))

function settle(id: string, result: OutboundAskResult): void {
  const waiter = waiters.get(id)
  if (!waiter) return
  waiters.delete(id)
  useOutboundAskStore.setState((state) => ({
    entries: state.entries.filter((entry) => entry.id !== id),
  }))
  waiter.settle(result)
}

export interface RequestOutboundAskOptions {
  ttlMs: number
  signal?: AbortSignal
  now?: () => number
  newId?: () => string
}

/** Ask the person at this computer; `null` when no dialog can show the question. */
export function requestOutboundAsk(
  question: Omit<OutboundAskEntry, "id" | "createdAt" | "expiresAt">,
  options: RequestOutboundAskOptions
): Promise<OutboundAskResult> | null {
  if (useOutboundAskStore.getState().hosts === 0) return null
  if (options.signal?.aborted) return Promise.resolve("withdrawn")
  const now = options.now?.() ?? Date.now()
  const id = options.newId?.() ?? crypto.randomUUID()
  const entry: OutboundAskEntry = {
    ...question,
    id,
    createdAt: now,
    expiresAt: now + options.ttlMs,
  }
  return new Promise<OutboundAskResult>((resolve) => {
    const timer = setTimeout(() => settle(id, "expired"), options.ttlMs)
    const onAbort = () => settle(id, "withdrawn")
    options.signal?.addEventListener("abort", onAbort, { once: true })
    waiters.set(id, {
      settle: (result) => {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        resolve(result)
      },
    })
    useOutboundAskStore.setState((state) => ({ entries: [...state.entries, entry] }))
  })
}

export function __resetOutboundAskStoreForTesting(): void {
  for (const id of [...waiters.keys()]) settle(id, "withdrawn")
  useOutboundAskStore.setState({ entries: [], hosts: 0 })
}

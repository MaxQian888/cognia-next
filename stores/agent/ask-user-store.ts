// Promise-resolving controller for the `ask_user` tool. The renderer-side
// `handlePluginToolExec` branch calls `runAskUser(args)`, which enqueues a
// request and returns a promise that settles when the AskUserDialog submits
// or cancels. One prompt shows at a time; concurrent calls (e.g. team runs)
// queue behind the active one.

import { create } from "zustand"

import {
  parseAskUserArgs,
  formatAskUserAnswer,
  type AskUserAnswer,
  type AskUserRequest,
} from "@/lib/claude/ask-user-tool"

interface PendingAsk {
  id: string
  request: AskUserRequest
  sessionId?: string
  resolve: (answer: AskUserAnswer) => void
}

interface AskUserState {
  active: PendingAsk | null
  queue: PendingAsk[]
  /** Enqueue a prompt; returns the promise the tool call awaits. */
  enqueue: (request: AskUserRequest, sessionId?: string) => Promise<AskUserAnswer>
  /** Resolve the active prompt and promote the next queued one. */
  resolveActive: (answer: AskUserAnswer) => void
}

export const useAskUserStore = create<AskUserState>((set, get) => ({
  active: null,
  queue: [],
  enqueue: (request, sessionId) =>
    new Promise<AskUserAnswer>((resolve) => {
      const pending: PendingAsk = { id: crypto.randomUUID(), request, sessionId, resolve }
      set((s) => (s.active ? { queue: [...s.queue, pending] } : { active: pending }))
    }),
  resolveActive: (answer) => {
    const { active, queue } = get()
    if (!active) return
    active.resolve(answer)
    const [next, ...rest] = queue
    set({ active: next ?? null, queue: rest })
  },
}))

/**
 * Tool entry point used by `handlePluginToolExec`. Parses the model args,
 * shows the dialog, and returns the formatted answer string the model reads.
 */
export async function runAskUser(
  args: Record<string, unknown>,
  ctx: { sessionId?: string } = {}
): Promise<string> {
  const request = parseAskUserArgs(args)
  const answer = await useAskUserStore.getState().enqueue(request, ctx.sessionId)
  return formatAskUserAnswer(request, answer)
}

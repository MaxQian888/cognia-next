import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Which session, run and attempt the currently-executing code belongs to.
 *
 * Client hooks are registered globally with the plugin hooks manager, so the
 * callback the manager invokes carries only the hook's own payload — nothing
 * that says which session triggered it. The previous implementation guessed
 * with `[...sessions.values()].find(s => s.busy)`, which returns the *first*
 * busy session; with two turns in flight, hook payloads were stamped with
 * another session's `sessionId`, `runId` and `attemptId`.
 *
 * An `AsyncLocalStorage` established around the turn propagates through every
 * `await` inside it, so a hook fired anywhere in the turn's call graph reads
 * the identity of the turn that actually fired it — including when several
 * turns are interleaved on the event loop.
 */
export interface RpcTurnContext {
  sessionId: string
  runId: string
  attemptId: string
}

const storage = new AsyncLocalStorage<RpcTurnContext>()

/** Run `fn` with `context` visible to everything it awaits. */
export function runInTurnContext<T>(context: RpcTurnContext, fn: () => T): T {
  return storage.run(context, fn)
}

/** The enclosing turn, or undefined outside any turn (a lifecycle hook). */
export function currentTurnContext(): RpcTurnContext | undefined {
  return storage.getStore()
}

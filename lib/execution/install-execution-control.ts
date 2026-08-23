/**
 * Host-neutral installation of the run-control dispatch table.
 *
 * The registration used to live inside `installConnectorRuntime`, which made
 * every run control in the product depend on the connector runtime being
 * alive. It is not: `ConnectorBusProvider` disposes that runtime whenever
 * `isRemoteHostActive()` is true, and the runtime holds a Web Lock lease so
 * only ONE browser context ever owns it. In both states
 * `executeRunControlCommand` found no handler for any kind and answered
 * `unsupported` — indistinguishable, at the card, from "this kind can never be
 * controlled".
 *
 * The dispatch table is a per-context in-memory Map. Registering it in every
 * context is safe precisely because it performs no writes of its own: the
 * handlers fail closed per kind when the run is not controllable here (an
 * `agent-turn` whose `AbortController` lives in another process reports
 * `source_rejected`, which is the honest answer). That is strictly better than
 * having no handler at all.
 *
 * Deliberately refcounted rather than "install once and never release": the
 * renderer initializer and the connector runtime (which the headless brain
 * boots, and which has no React tree to mount an initializer in) both hold a
 * reference. The table survives until the last owner lets go, so a connector
 * lease loss no longer takes the control plane with it.
 */

import {
  installExecutionRunControlHandlers,
  type ExecutionRunControlHandlerDeps,
} from "./control-handlers"

let disposeActive: (() => void) | null = null
let activeDeps: ExecutionRunControlHandlerDeps = {}
let refCount = 0

/**
 * Fold a new owner's deps into the live set, first writer wins.
 *
 * Returns true when the merge actually added something, which is the only case
 * that justifies rebuilding the table. Two owners take references here — the
 * renderer initializer and the connector runtime — and which one arrives first
 * depends on React mount order versus Web Lock acquisition, i.e. it is not
 * deterministic. Taking `deps` only from whoever happened to be first meant an
 * injected `resumeAgentRun` was silently dropped half the time; keeping the
 * first-set value for a key that IS set keeps the merge from ping-ponging
 * between owners on every remount.
 */
function mergeActiveDeps(deps: ExecutionRunControlHandlerDeps): boolean {
  let changed = false
  for (const key of Object.keys(deps) as (keyof ExecutionRunControlHandlerDeps)[]) {
    if (deps[key] === undefined || activeDeps[key] !== undefined) continue
    activeDeps = { ...activeDeps, [key]: deps[key] }
    changed = true
  }
  return changed
}

/**
 * Install the run-control handlers if they are not already installed, and take
 * one reference on them. The returned release is idempotent — calling it twice
 * drops one reference, not two — because React's StrictMode double-invokes
 * effect cleanups in development.
 *
 * A later owner's `deps` are honoured rather than discarded: registration is
 * the table's only side effect, so rebuilding it in place costs nothing and
 * cannot be observed by a caller mid-command.
 */
export function installExecutionControlPlane(
  deps: ExecutionRunControlHandlerDeps = {}
): () => void {
  const contributed = mergeActiveDeps(deps)
  if (!disposeActive) {
    disposeActive = installExecutionRunControlHandlers(activeDeps).dispose
    refCount = 0
  } else if (contributed) {
    // Rebuild so the new dependency is actually reachable. The reference count
    // is deliberately untouched — the owners have not changed, only the deps.
    disposeActive()
    disposeActive = installExecutionRunControlHandlers(activeDeps).dispose
  }
  refCount += 1

  let released = false
  return () => {
    if (released) return
    released = true
    refCount -= 1
    if (refCount <= 0 && disposeActive) {
      disposeActive()
      disposeActive = null
      activeDeps = {}
      refCount = 0
    }
  }
}

/** Whether the dispatch table is installed in THIS context. */
export function isExecutionControlPlaneInstalled(): boolean {
  return disposeActive !== null
}

/** Test-only: drop the installation so suites do not leak into each other. */
export function __resetExecutionControlPlaneForTesting(): void {
  disposeActive?.()
  disposeActive = null
  activeDeps = {}
  refCount = 0
}

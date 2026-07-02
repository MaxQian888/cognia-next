/**
 * Headless smoke for the desktop-sync-source runtime (ADR-0059 T-A2): the
 * runtime must start in a pure-Node process (no DOM) and wire the sync-pull
 * request/respond loop through the injected bridge.
 *
 * @jest-environment node
 */
import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext, RuntimeBridge } from "../types"

type Handler = (e: { payload: unknown }) => void

function makeBridge() {
  const listeners = new Map<string, Handler>()
  const invocations: Array<{ name: string; args: Record<string, unknown> }> = []
  const bridge: RuntimeBridge = {
    listen: async (event, handler) => {
      listeners.set(event, handler as Handler)
      return () => listeners.delete(event)
    },
    invoke: async (name, args) => {
      invocations.push({ name, args })
      return null
    },
  }
  return { bridge, listeners, invocations }
}

function makeCtx(bridge: RuntimeBridge): HeadlessRuntimeContext {
  return {
    host: "brain",
    accountId: "local_acct_a",
    bridge,
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => key,
    log: () => undefined,
  }
}

/** Trip on ANY `document` access — surfaces residual DOM assumptions. */
function installDocumentTripwire(): () => void {
  const g = globalThis as Record<string, unknown>
  const prev = g.document
  g.document = new Proxy(
    {},
    {
      get(_target, prop) {
        // Jest's own global bookkeeping probes symbol-keyed properties;
        // Dexie feature-detects `document.compatMode`. Neither is a real
        // DOM dependency — everything else trips.
        if (typeof prop === "symbol" || prop === "compatMode") return undefined
        throw new Error(`headless runtime touched document.${String(prop)}`)
      },
    }
  )
  return () => {
    if (prev === undefined) delete g.document
    else g.document = prev
  }
}

describe("desktop-sync-source headless smoke", () => {
  it("starts without DOM and answers a sync-pull over the bridge", async () => {
    const restore = installDocumentTripwire()
    try {
      __resetHeadlessRuntimesForTesting()
      await import("./desktop-sync-source")

      const { bridge, listeners, invocations } = makeBridge()
      const result = await bootstrapHeadlessRuntimes(makeCtx(bridge))
      expect(result.failed).toEqual([])
      expect(result.started).toContain("desktop-sync-source")
      expect(listeners.has("companion://sync-pull-request")).toBe(true)

      // Fire a request. No account is unlocked in this bare process, so the
      // handler must respond with the account error — proving the FULL
      // request→respond loop ran headless (and never touched the DOM).
      listeners.get("companion://sync-pull-request")!({
        payload: {
          request_id: "rid-headless-1",
          table: "sessions",
          since: 0,
          account_id: "local_acct_a",
        },
      })
      await new Promise((r) => setTimeout(r, 20))

      expect(invocations).toHaveLength(1)
      expect(invocations[0].name).toBe("companion_sync_pull_response")
      expect(invocations[0].args.requestId).toBe("rid-headless-1")
      expect(String(invocations[0].args.error)).toContain("no unlocked local account")

      await result.stop()
      expect(listeners.size).toBe(0)
    } finally {
      restore()
    }
  })
})

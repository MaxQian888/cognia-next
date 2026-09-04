/**
 * Headless smoke for the desktop message+write sources (ADR-0059 T-A3).
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
    respondMedia: async () => {},
  }
  return { bridge, listeners, invocations }
}

function makeCtx(bridge: RuntimeBridge): HeadlessRuntimeContext {
  return {
    host: "brain",
    localAccountId: "local_acct_a",
    bridge,
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => key,
    log: () => undefined,
  }
}

describe("desktop-message-source headless smoke", () => {
  it("installs message, write, and orchestration listeners in a pure-Node process", async () => {
    __resetHeadlessRuntimesForTesting()
    await import("./desktop-message-source")

    const { bridge, listeners, invocations } = makeBridge()
    const result = await bootstrapHeadlessRuntimes(makeCtx(bridge))
    expect(result.failed).toEqual([])
    expect(result.started).toContain("desktop-message-source")

    // The five message/session channels + the generic write channel.
    for (const channel of [
      "companion://message-update-request",
      "companion://message-delete-request",
      "companion://session-list-request",
      "companion://message-get-by-session-request",
      "companion://message-send-request",
      "companion://desktop-write-request",
      "orchestration-proxy:exec",
    ]) {
      expect(listeners.has(channel)).toBe(true)
    }

    // Drive one write request end-to-end: the db isn't open in this bare
    // process, so the dispatcher must respond with an error envelope —
    // proving the request→respond loop is wired headless.
    listeners.get("companion://desktop-write-request")!({
      payload: { requestId: "rid-w1", command: "character_upsert", payload: {} },
    })
    await new Promise((r) => setTimeout(r, 30))
    const writeResponse = invocations.find((i) => i.name === "companion_desktop_write_response")
    expect(writeResponse).toBeDefined()
    expect(writeResponse!.args.requestId).toBe("rid-w1")

    await result.stop()
    expect(listeners.size).toBe(0)
  })
})

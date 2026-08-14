/**
 * Tests for the renderer-side RPC dispatcher.
 *
 * The dispatcher is the gluing point between Tauri events and every
 * VS Code namespace handler. The contract under test:
 *   - notification frames (`method`, no `id`) → handler invoked, no
 *     response emitted
 *   - request frames (`method` + `id`) → handler invoked, result emitted
 *     via the injected sendResponse transport
 *   - missing handler for a request → JSON-RPC -32601 error emitted
 *   - throwing handler for a request → JSON-RPC -32000 error emitted
 *   - subscription/unsubscription idempotency
 */

import {
  configureRpcDispatcher,
  handleInboundFrame,
  listRegisteredMethods,
  registerMethod,
  resetRegistry,
  subscribeToVscodeEvents,
  vscodeRpcEventName,
} from "./rpc-dispatcher"

describe("rpc-dispatcher", () => {
  let sentResponses: Array<{ pluginId: string; generation?: string; frame: unknown }>
  let listenCalls: Array<{ event: string }>
  let unlistenSpies: jest.Mock[]
  let eventCallbacks: Array<(payload: { payload: string }) => void>

  beforeEach(() => {
    sentResponses = []
    listenCalls = []
    unlistenSpies = []
    eventCallbacks = []
    resetRegistry()
    configureRpcDispatcher({
      sendResponse: async (pluginId, generation, frame) => {
        sentResponses.push({ pluginId, generation, frame: JSON.parse(frame) })
      },
      listen: async (event, cb) => {
        listenCalls.push({ event })
        eventCallbacks.push(cb)
        const spy = jest.fn()
        unlistenSpies.push(spy)
        return spy
      },
    })
  })

  afterEach(() => {
    configureRpcDispatcher(null)
    resetRegistry()
  })

  describe("registerMethod", () => {
    it("registers a handler and returns a disposer", () => {
      const dispose = registerMethod("test:echo", (p) => p)
      expect(listRegisteredMethods()).toContain("test:echo")
      dispose()
      expect(listRegisteredMethods()).not.toContain("test:echo")
    })

    it("disposer is idempotent and only drops the original handler", () => {
      const dispose = registerMethod("test:echo", () => "first")
      registerMethod("test:echo", () => "second")
      dispose() // should NOT remove the replacement
      expect(listRegisteredMethods()).toContain("test:echo")
    })
  })

  describe("handleInboundFrame — notifications", () => {
    it("invokes the handler with parsed params and pluginId", async () => {
      const calls: Array<{ payload: unknown; pluginId: string }> = []
      registerMethod("languages:setDiagnostics", (payload, ctx) => {
        calls.push({ payload, pluginId: ctx.pluginId })
      })

      await handleInboundFrame(
        "publisher.ext",
        JSON.stringify({
          jsonrpc: "2.0",
          method: "languages:setDiagnostics",
          params: { uri: "file://a", diagnostics: [] },
        })
      )

      expect(calls).toEqual([
        { pluginId: "publisher.ext", payload: { uri: "file://a", diagnostics: [] } },
      ])
      expect(sentResponses).toEqual([])
    })

    it("swallows handler throws on notifications without crashing", async () => {
      registerMethod("noisy:event", () => {
        throw new Error("boom")
      })
      await expect(
        handleInboundFrame(
          "pub.ext",
          JSON.stringify({ jsonrpc: "2.0", method: "noisy:event", params: {} })
        )
      ).resolves.toBeUndefined()
      expect(sentResponses).toEqual([])
    })

    it("ignores notifications with no registered handler", async () => {
      await expect(
        handleInboundFrame(
          "pub.ext",
          JSON.stringify({ jsonrpc: "2.0", method: "no:handler", params: null })
        )
      ).resolves.toBeUndefined()
      expect(sentResponses).toEqual([])
    })
  })

  describe("handleInboundFrame — requests", () => {
    it("emits a result frame on success", async () => {
      registerMethod("lm:selectChatModels", (_p, ctx) => ({
        echoedFor: ctx.pluginId,
        models: ["claude-opus-4-7"],
      }))

      await handleInboundFrame(
        "pub.ext",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "lm:selectChatModels",
          params: { vendor: "cognia" },
        })
      )

      expect(sentResponses).toHaveLength(1)
      expect(sentResponses[0]).toEqual({
        pluginId: "pub.ext",
        generation: undefined,
        frame: {
          jsonrpc: "2.0",
          id: 42,
          result: { echoedFor: "pub.ext", models: ["claude-opus-4-7"] },
        },
      })
    })

    it("emits -32601 when no handler matches", async () => {
      await handleInboundFrame(
        "pub.ext",
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "no:such", params: {} })
      )
      expect(sentResponses).toHaveLength(1)
      const frame = sentResponses[0]!.frame as {
        error: { code: number; message: string }
      }
      expect(frame.error.code).toBe(-32601)
      expect(frame.error.message).toMatch(/no:such/)
    })

    it("emits -32000 when the handler throws", async () => {
      registerMethod("fragile:op", () => {
        throw new Error("kaboom")
      })
      await handleInboundFrame(
        "pub.ext",
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "fragile:op", params: null })
      )
      expect(sentResponses).toHaveLength(1)
      const frame = sentResponses[0]!.frame as {
        error: { code: number; message: string }
      }
      expect(frame.error.code).toBe(-32000)
      expect(frame.error.message).toBe("kaboom")
    })

    it("awaits async handlers", async () => {
      registerMethod("slow:op", async () => {
        await new Promise((r) => setTimeout(r, 5))
        return "done"
      })
      await handleInboundFrame(
        "pub.ext",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slow:op" })
      )
      expect(sentResponses[0]!.frame).toMatchObject({ id: 1, result: "done" })
    })

    it("treats null result as null in the response frame", async () => {
      registerMethod("nulled:op", () => undefined)
      await handleInboundFrame(
        "pub.ext",
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "nulled:op" })
      )
      expect(sentResponses[0]!.frame).toMatchObject({ id: 2, result: null })
    })
  })

  describe("handleInboundFrame — malformed frames", () => {
    it("drops unparseable JSON without throwing", async () => {
      await expect(handleInboundFrame("pub.ext", "not json{{")).resolves.toBeUndefined()
      expect(sentResponses).toEqual([])
    })

    it("ignores frames with no method (pure responses)", async () => {
      await handleInboundFrame("pub.ext", JSON.stringify({ jsonrpc: "2.0", id: 3, result: "ok" }))
      expect(sentResponses).toEqual([])
    })
  })

  describe("subscribeToVscodeEvents", () => {
    it("listens once per pluginId and reuses the disposer", async () => {
      const a1 = await subscribeToVscodeEvents("pub.a")
      const a2 = await subscribeToVscodeEvents("pub.a")
      expect(a1).toBe(a2)
      expect(listenCalls).toEqual([{ event: "vscode://rpc/pub_a" }])
    })

    it("listens separately per pluginId", async () => {
      await subscribeToVscodeEvents("pub.a")
      await subscribeToVscodeEvents("pub.b")
      expect(listenCalls).toEqual([
        { event: "vscode://rpc/pub_a" },
        { event: "vscode://rpc/pub_b" },
      ])
    })

    it("disposer drops the subscription and unlistens", async () => {
      const dispose = await subscribeToVscodeEvents("pub.x")
      dispose()
      // Calling dispose again should be safe (no double unlisten on the
      // same spy: subscription was already cleared).
      dispose()
      expect(unlistenSpies[0]).toHaveBeenCalledTimes(1)
      // Re-subscribing creates a fresh listen.
      await subscribeToVscodeEvents("pub.x")
      expect(listenCalls).toHaveLength(2)
    })

    it("drops events from an older runtime generation", async () => {
      const handler = jest.fn()
      registerMethod("test:event", handler)
      await subscribeToVscodeEvents("pub.x", "generation-2")

      eventCallbacks[0]?.({
        payload: JSON.stringify({
          generation: "generation-1",
          rawFrame: JSON.stringify({ jsonrpc: "2.0", method: "test:event" }),
        }),
      })
      await Promise.resolve()
      expect(handler).not.toHaveBeenCalled()

      eventCallbacks[0]?.({
        payload: JSON.stringify({
          generation: "generation-2",
          rawFrame: JSON.stringify({ jsonrpc: "2.0", method: "test:event" }),
        }),
      })
      await Promise.resolve()
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it("throws if not configured", async () => {
      configureRpcDispatcher(null)
      await expect(subscribeToVscodeEvents("pub.y")).rejects.toThrow(/configureRpcDispatcher/)
    })
  })

  describe("vscodeRpcEventName", () => {
    // Tauri rejects listen/emit for names outside [a-zA-Z0-9-/:_] ("Event name
    // must include only alphanumeric characters, `-`, `/`, `:` and `_`.").
    // Extension ids are `publisher.name`, so the dot must be mapped away.
    it("produces a Tauri-valid event name for dotted extension ids", () => {
      expect(vscodeRpcEventName("publisher.ext")).toBe("vscode://rpc/publisher_ext")
      expect(vscodeRpcEventName("publisher.ext")).toMatch(/^[a-zA-Z0-9\-/:_]+$/)
    })

    it("maps the system LSP channel id to the name the Rust host emits", () => {
      // Pins the TS↔Rust contract with `inbound_event_name` in
      // crates/cognia-plugin-runtime/src/vscode/commands.rs.
      expect(vscodeRpcEventName("cognia.lsp-service")).toBe("vscode://rpc/cognia_lsp-service")
    })

    it("keeps already-valid characters untouched", () => {
      expect(vscodeRpcEventName("plain_id-1:x/y")).toBe("vscode://rpc/plain_id-1:x/y")
    })
  })

  describe("configureRpcDispatcher(null)", () => {
    it("tears down all subscriptions", async () => {
      await subscribeToVscodeEvents("pub.a")
      await subscribeToVscodeEvents("pub.b")
      configureRpcDispatcher(null)
      expect(unlistenSpies[0]).toHaveBeenCalled()
      expect(unlistenSpies[1]).toHaveBeenCalled()
    })

    it("emitResult silently drops when transport is gone", async () => {
      registerMethod("orphan:op", () => "ok")
      // Hook a handler that fires sendResponse after teardown — the
      // dispatcher should just log+drop instead of crashing.
      const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "orphan:op" })
      configureRpcDispatcher(null)
      await expect(handleInboundFrame("pub.x", frame)).resolves.toBeUndefined()
    })
  })
})

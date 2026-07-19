/**
 * @jest-environment jsdom
 *
 * Web-mode behavior of the workflow Tauri bridge. Without the Tauri globals
 * `isTauri()` is false, so every wrapper degrades gracefully instead of
 * throwing — the orchestrator must run end-to-end in the browser shell.
 */
import {
  respondToWebhook,
  registerTrigger,
  reloadInFlightRuns,
  getWebhookUrl,
  unregisterTrigger,
} from "./tauri-bridge"

describe("tauri-bridge (web mode, no Tauri globals)", () => {
  it("respondToWebhook resolves to false (no receiver to answer)", async () => {
    await expect(
      respondToWebhook("whr_1", { status: 200, body: "ok", headers: { "x-a": "b" } })
    ).resolves.toBe(false)
  })

  it("respondToWebhook tolerates an omitted headers map", async () => {
    await expect(respondToWebhook("whr_2", { status: 204, body: "" })).resolves.toBe(false)
  })

  it("registerTrigger resolves without throwing", async () => {
    await expect(
      registerTrigger({
        workflowId: "wf",
        triggerId: "trg",
        kind: "trigger.webhook",
        enabled: true,
        webhookPath: "x",
        webhookAwaitResponse: true,
      })
    ).resolves.toBeUndefined()
  })

  it("reloadInFlightRuns returns an empty list in web mode", async () => {
    await expect(reloadInFlightRuns()).resolves.toEqual([])
  })

  it("unregisterTrigger resolves with workflow-scoped identity in web mode", async () => {
    await expect(unregisterTrigger("wf", "trg")).resolves.toBeUndefined()
  })

  it("getWebhookUrl returns null in web mode", async () => {
    await expect(getWebhookUrl("wf", "trg")).resolves.toBeNull()
  })

  it("listenTriggerEvents returns a no-op unsubscribe in web mode", async () => {
    const { listenTriggerEvents } = await import("./tauri-bridge")
    const stop = await listenTriggerEvents(() => {})
    expect(stop()).toBeUndefined()
  })

  it("listenResumeEvents returns a no-op unsubscribe in web mode", async () => {
    const { listenResumeEvents } = await import("./tauri-bridge")
    const stop = await listenResumeEvents(() => {})
    expect(stop()).toBeUndefined()
  })
})

describe("tauri-bridge listeners (Tauri mode)", () => {
  afterEach(() => {
    jest.resetModules()
    jest.dontMock("@tauri-apps/api/event")
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  /**
   * Loads a fresh copy of the bridge with Tauri globals present and
   * `@tauri-apps/api/event` mocked. `_isTauri` is cached at module scope,
   * so the module must be re-required after the global is stubbed.
   */
  async function loadBridgeWithMockedListen(unlisten: () => void | Promise<void>) {
    jest.resetModules()
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    const listen = jest.fn().mockResolvedValue(unlisten)
    jest.doMock("@tauri-apps/api/event", () => ({ listen }))
    const bridge = await import("./tauri-bridge")
    return { bridge, listen }
  }

  it("wraps the trigger unlisten in safeUnlisten so a StrictMode-race rejection is swallowed", async () => {
    // Tauri's injected unregisterListener throws "undefined is not an object
    // (evaluating 'listeners[eventId].handlerId')" as an async rejection when
    // the registration eval hasn't landed yet — the disposer must not rethrow.
    const rejecting = jest
      .fn()
      .mockRejectedValue(
        new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')")
      )
    const { bridge, listen } = await loadBridgeWithMockedListen(rejecting)
    const stop = await bridge.listenTriggerEvents(() => {})
    expect(listen).toHaveBeenCalledWith("workflow:trigger", expect.any(Function))
    expect(() => stop()).not.toThrow()
    expect(rejecting).toHaveBeenCalledTimes(1)
    // Drain microtasks — an unhandled rejection here would fail the suite.
    await Promise.resolve()
    await Promise.resolve()
  })

  it("wraps the resume unlisten and swallows synchronous throws too", async () => {
    const throwing = jest.fn(() => {
      throw new TypeError("listeners[eventId] is undefined")
    })
    const { bridge, listen } = await loadBridgeWithMockedListen(throwing)
    const stop = await bridge.listenResumeEvents(() => {})
    expect(listen).toHaveBeenCalledWith("workflow:resume", expect.any(Function))
    expect(() => stop()).not.toThrow()
    expect(throwing).toHaveBeenCalledTimes(1)
  })

  it("still delivers event payloads to the handler", async () => {
    const { bridge, listen } = await loadBridgeWithMockedListen(() => {})
    const handler = jest.fn()
    await bridge.listenTriggerEvents(handler)
    const cb = listen.mock.calls[0][1] as (e: { payload: unknown }) => void
    cb({ payload: { workflowId: "wf", kind: "trigger.cron", originAt: 1 } })
    expect(handler).toHaveBeenCalledWith({ workflowId: "wf", kind: "trigger.cron", originAt: 1 })
  })
})

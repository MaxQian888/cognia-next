/**
 * @jest-environment jsdom
 *
 * Web-mode behavior of the workflow Tauri bridge. Without the Tauri globals
 * `isTauri()` is false, so every wrapper degrades gracefully instead of
 * throwing — the orchestrator must run end-to-end in the browser shell.
 *
 * The native-call suites below pin the two things the bridge got wrong for a
 * long time: which hosts have a workflow state to talk to (the desktop AND
 * the headless brain, never a companion), and the argument shape the Rust
 * commands read (`{ input }`, not the bare object).
 */
import {
  respondToWebhook,
  registerTrigger,
  reloadInFlightRuns,
  getWebhookUrl,
  unregisterTrigger,
  createNativeWorkflowWaitpoint,
  getNativeWorkflowWaitpoint,
  listNativePendingWorkflowWaitpoints,
  decideNativeWorkflowWaitpoint,
  persistNativeWorkflowWaitEvent,
  pruneNativeWorkflowWaitEvents,
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

  it("durable waitpoint mirror degrades to the web repository outside Tauri", async () => {
    const waitpoint = {
      id: "wait_1",
      kind: "approval" as const,
      status: "pending" as const,
      runId: "run_1",
      workflowId: "wf_1",
      stepId: "gate",
      key: "approval:wait_1",
      createdAt: 1,
      notBefore: 1,
      updatedAt: 1,
    }
    await expect(createNativeWorkflowWaitpoint(waitpoint)).resolves.toBeNull()
    await expect(getNativeWorkflowWaitpoint("wait_1")).resolves.toBeNull()
    await expect(listNativePendingWorkflowWaitpoints()).resolves.toBeNull()
    await expect(
      decideNativeWorkflowWaitpoint("wait_1", {
        outcome: "approved",
        respondedBy: "test",
        resolvedAt: 2,
      })
    ).resolves.toBeNull()
    await expect(
      persistNativeWorkflowWaitEvent({
        id: "event_1",
        key: "ready",
        source: "test",
        emittedAt: 1,
        expiresAt: 2,
      })
    ).resolves.toBeUndefined()
    await expect(pruneNativeWorkflowWaitEvents(2)).resolves.toBeNull()
  })

  it("listenTriggerEvents returns a no-op unsubscribe in web mode (stub transport)", async () => {
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

describe("tauri-bridge listeners (non-Tauri host with an events plane)", () => {
  afterEach(() => {
    jest.resetModules()
    jest.dontMock("@/lib/tauri")
  })

  it("listenTriggerEvents subscribes to workflow:trigger through the active transport", async () => {
    const unsubscribe = jest.fn()
    const subscribe = jest.fn(
      (_channel: string, _handler: (payload: unknown) => void) => unsubscribe
    )
    jest.doMock("@/lib/tauri", () => ({ transport: { subscribe } }))
    const { listenTriggerEvents, listenResumeEvents } = await import("./tauri-bridge")
    const handler = jest.fn()
    const stop = await listenTriggerEvents(handler)
    expect(subscribe).toHaveBeenCalledWith("workflow:trigger", expect.any(Function))
    // Frames are handed to the handler as-is (already the payload).
    subscribe.mock.calls[0][1]({ workflowId: "wf", kind: "trigger.cron" })
    expect(handler).toHaveBeenCalledWith({ workflowId: "wf", kind: "trigger.cron" })
    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    await listenResumeEvents(() => {})
    expect(subscribe).toHaveBeenLastCalledWith("workflow:resume", expect.any(Function))
  })

  it("degrades to a no-op when the transport cannot subscribe", async () => {
    jest.doMock("@/lib/tauri", () => ({
      transport: {
        subscribe: () => {
          throw new Error("no events plane")
        },
      },
    }))
    const { listenTriggerEvents } = await import("./tauri-bridge")
    const stop = await listenTriggerEvents(() => {})
    expect(stop()).toBeUndefined()
    jest.resetModules()
    jest.doMock("@/lib/tauri", () => ({ transport: {} }))
    const mod = await import("./tauri-bridge")
    const stop2 = await mod.listenTriggerEvents(() => {})
    expect(stop2()).toBeUndefined()
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

describe("tauri-bridge native calls (headless brain)", () => {
  afterEach(() => {
    jest.resetModules()
    jest.dontMock("@/lib/tauri")
    jest.dontMock("./companion-run-events")
    delete (globalThis as { __COGNIA_HEADLESS__?: unknown }).__COGNIA_HEADLESS__
  })

  /**
   * The brain marks itself with `__COGNIA_HEADLESS__` before anything else
   * boots (`cli/src/serve/serve-command.ts`), and `detectHostProfile` reads
   * that marker ahead of every browser check. The transport is the brain's
   * `CompanionTransport`; here it is a recording stub.
   */
  async function loadHeadlessBridge(call: jest.Mock) {
    jest.resetModules()
    ;(globalThis as { __COGNIA_HEADLESS__?: unknown }).__COGNIA_HEADLESS__ = true
    jest.doMock("@/lib/tauri", () => ({ transport: { call } }))
    jest.doMock("./companion-run-events", () => ({
      notifyCompanionsOfRunState: jest.fn(async () => undefined),
    }))
    return import("./tauri-bridge")
  }

  it("routes mirror writes through the shared transport, wrapped the way the Rust commands read them", async () => {
    const call = jest.fn(async () => null)
    const bridge = await loadHeadlessBridge(call)
    await bridge.persistRunState({ runId: "run_1", workflowId: "wf_1", status: "running" })
    expect(call).toHaveBeenCalledWith("workflow_persist_run_state", {
      input: { runId: "run_1", workflowId: "wf_1", status: "running" },
    })
    await bridge.registerTrigger({
      workflowId: "wf_1",
      triggerId: "trg_1",
      kind: "trigger.cron",
      enabled: true,
      cron: "0 9 * * *",
    })
    expect(call).toHaveBeenLastCalledWith("workflow_register_trigger", {
      input: expect.objectContaining({ triggerId: "trg_1", cron: "0 9 * * *" }),
    })
    await bridge.unregisterTrigger("wf_1", "trg_1")
    expect(call).toHaveBeenLastCalledWith("workflow_unregister_trigger", {
      workflowId: "wf_1",
      triggerId: "trg_1",
    })
    await bridge.ackRunCompleted("run_1")
    expect(call).toHaveBeenLastCalledWith("workflow_ack_completed", { runId: "run_1" })
  })

  it("reads the in-flight rows back from the host's mirror", async () => {
    const rows = [{ runId: "run_1", workflowId: "wf_1", snapshot: {}, startedAt: 1 }]
    const call = jest.fn(async () => rows)
    const bridge = await loadHeadlessBridge(call)
    await expect(bridge.reloadInFlightRuns()).resolves.toEqual(rows)
    expect(call).toHaveBeenCalledWith("workflow_reload_in_flight_runs", undefined)
    await expect(bridge.getWebhookUrl("wf_1", "trg_1")).resolves.toEqual(rows)
  })

  it("degrades to null and reports a failing host once per command", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const call = jest.fn(async () => {
      throw new Error("unknown command")
    })
    const bridge = await loadHeadlessBridge(call)
    await expect(bridge.getWebhookUrl("wf", "trg")).resolves.toBeNull()
    await expect(bridge.getWebhookUrl("wf", "trg")).resolves.toBeNull()
    await expect(bridge.reloadInFlightRuns()).resolves.toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toContain("workflow_get_webhook_url")
    expect(warn.mock.calls[1][0]).toContain("workflow_reload_in_flight_runs")
    warn.mockRestore()
  })
})

describe("tauri-bridge native calls (Tauri desktop and companions)", () => {
  afterEach(() => {
    jest.resetModules()
    jest.dontMock("@/lib/tauri")
    jest.dontMock("./companion-run-events")
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it("wraps persist and register under `input` on the desktop too", async () => {
    jest.resetModules()
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    const call = jest.fn(async () => null)
    jest.doMock("@/lib/tauri", () => ({ transport: { call } }))
    jest.doMock("./companion-run-events", () => ({
      notifyCompanionsOfRunState: jest.fn(async () => undefined),
    }))
    const bridge = await import("./tauri-bridge")
    await bridge.persistRunState({ runId: "run_1", workflowId: "wf_1", status: "succeeded" })
    expect(call).toHaveBeenCalledWith("workflow_persist_run_state", {
      input: { runId: "run_1", workflowId: "wf_1", status: "succeeded" },
    })
  })

  it("never puts a mirror write on the wire from a shell with no workflow state", async () => {
    jest.resetModules()
    const call = jest.fn(async () => null)
    jest.doMock("@/lib/tauri", () => ({ transport: { call } }))
    jest.doMock("./companion-run-events", () => ({
      notifyCompanionsOfRunState: jest.fn(async () => undefined),
    }))
    const bridge = await import("./tauri-bridge")
    await bridge.persistRunState({ runId: "run_1", workflowId: "wf_1", status: "running" })
    await expect(bridge.reloadInFlightRuns()).resolves.toEqual([])
    expect(call).not.toHaveBeenCalled()
  })
})

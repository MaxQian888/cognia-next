/**
 * Headless smoke for the desktop message+write sources (ADR-0059 T-A3).
 *
 * @jest-environment node
 */
import type { RouterFusionHost } from "@/lib/router-fusion/gate/load-engine"

import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext, RuntimeBridge } from "../types"

type Handler = (e: { payload: unknown }) => void

// The brain reads the account's settings row, never a settings store.
const mockGateSettings = jest.fn()
jest.mock("@/lib/router-fusion/gate/current-settings", () => ({
  currentRouterFusionGateSettings: () => mockGateSettings(),
}))
const mockHost = {
  runApiDeps: jest.fn(() => ({})),
  isRunApiScope: (scope: string) => scope.startsWith("runs:"),
  getRunFromApi: jest.fn(),
  reservePassthroughCall: jest.fn(),
  settlePassthroughCall: jest.fn(),
}
jest.mock("@/lib/router-fusion/gate/load-engine", () => ({
  loadRouterFusionHost: async () => mockHost as unknown as RouterFusionHost,
}))

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

  it("answers the gateway's Run API and passthrough commands from the brain", async () => {
    // A fresh module graph: the registration above is cached with its module.
    jest.resetModules()
    const registry = await import("../registry")
    registry.__resetHeadlessRuntimesForTesting()
    await import("./desktop-message-source")
    const { bootstrapHeadlessRuntimes: bootstrap } = await import("../bootstrap")
    const { bridge, listeners, invocations } = makeBridge()
    const result = await bootstrap(makeCtx(bridge))
    expect(result.failed).toEqual([])
    const write = listeners.get("companion://desktop-write-request")!

    async function ask(requestId: string, command: string, payload: Record<string, unknown>) {
      write({ payload: { requestId, command, payload } })
      for (let i = 0; i < 100; i++) {
        const answer = invocations.find(
          (i) => i.name === "companion_desktop_write_response" && i.args.requestId === requestId
        )
        if (answer) return answer.args
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error(`no answer to ${command}`)
    }

    // Switched off on the account: the Run API refuses, passthrough bypasses —
    // both as `{ ok }` envelopes the gateway's bridge reads.
    mockGateSettings.mockResolvedValue(null)
    expect(await ask("rf-1", "router_fusion_run_get", { runId: "run-1" })).toMatchObject({
      error: null,
      result: { ok: false, error: { status: 403, code: "ROUTER_FUSION_DISABLED" } },
    })
    expect(
      await ask("rf-2", "router_fusion_passthrough_reserve", { requestId: "req-1", attempt: 0 })
    ).toMatchObject({
      error: null,
      result: { ok: true, value: { status: "bypassed", code: "surface_off" } },
    })

    // Switched on: the same commands reach the ledger and the Run API.
    mockGateSettings.mockResolvedValue({
      routerFusion: {
        enabled: true,
        surfaces: { gatewayRuns: true, gatewayPassthroughLedger: true },
      },
    })
    mockHost.getRunFromApi.mockResolvedValue({ ok: true, value: { run_id: "run-1" } })
    mockHost.reservePassthroughCall.mockResolvedValue({
      kind: "reserved",
      runId: "gwpt:req-1",
      attemptId: "a1",
    })
    mockHost.settlePassthroughCall.mockResolvedValue({ sealed: true })
    expect(
      await ask("rf-3", "router_fusion_run_get", {
        runId: "run-1",
        actor: { keyId: "k", keyName: "robot", scopes: ["runs:read"] },
      })
    ).toMatchObject({ error: null, result: { ok: true, value: { run_id: "run-1" } } })
    expect(
      await ask("rf-4", "router_fusion_passthrough_reserve", {
        kind: "embeddings",
        requestId: "req-1",
        attempt: 0,
      })
    ).toMatchObject({
      error: null,
      result: { ok: true, value: { status: "ledgered", runId: "gwpt:req-1", attemptId: "a1" } },
    })
    expect(mockHost.reservePassthroughCall.mock.calls[0][0]).toMatchObject({ kind: "embeddings" })
    expect(
      await ask("rf-5", "router_fusion_passthrough_settle", {
        runId: "gwpt:req-1",
        attemptId: "a1",
        outcome: "succeeded",
        usage: { inputTokens: 7, outputTokens: 0 },
        final: true,
      })
    ).toMatchObject({
      error: null,
      result: { ok: true, value: { status: "ledgered", sealed: true } },
    })

    await result.stop()
  })
})

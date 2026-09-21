/**
 * @jest-environment jsdom
 *
 * The companion's Router + Fusion commands through their real entry points
 * (ADR-0188 D25): a run queued on the phone by the run client, drained by the
 * mobile outbound runner, answered by `dispatchCommand` — the arm every host
 * installs behind `rpc/data_sync.rs` — and read back, followed and stopped the
 * same way. The dispatcher below stands in for Rust only in what Rust adds: it
 * stamps the authenticated `callerDeviceId` on the payload.
 *
 * The Run API host itself is replaced (its own suite runs it against a real
 * fusion database); what this file pins is that every command reaches it, as
 * the right device, only while the companion switch is on — and that with the
 * switch off nothing loads it, so nothing can open the fusion database.
 */

import "fake-indexeddb/auto"

let mockSettings: unknown = null
jest.mock("@/lib/router-fusion/gate/current-settings", () => ({
  currentRouterFusionGateSettings: async () => mockSettings,
}))

let mockHostLoads = 0
const mockRuns = new Map<string, { runId: string; text: string }>()
const mockHost = {
  companionActor: jest.fn(async (deviceId: string) => ({
    keyId: `device:${deviceId}`,
    keyName: "Max's phone",
    scopes: [],
  })),
  createCompanionRun: jest.fn(
    async (_settings: unknown, input: { idempotencyKey: string; text: string }) => {
      const existing = mockRuns.get(input.idempotencyKey)
      if (existing) {
        return existing.text === input.text
          ? { ok: true, value: { accepted: { run_id: existing.runId }, replayed: true } }
          : { ok: false, error: { status: 409, code: "IDEMPOTENCY_CONFLICT", message: "x" } }
      }
      const run = { runId: `run-${mockRuns.size + 1}`, text: input.text }
      mockRuns.set(input.idempotencyKey, run)
      return { ok: true, value: { accepted: { run_id: run.runId }, replayed: false } }
    }
  ),
  getCompanionRun: jest.fn(async () => ({
    ok: true,
    value: { snapshot: {}, resultExpired: false },
  })),
  listCompanionRunEvents: jest.fn(async () => ({
    ok: true,
    value: { events: [], lastSeq: 0, terminal: false },
  })),
  resumeCompanionRun: jest.fn(async () => ({ ok: true, value: {} })),
  isCompanionRun: jest.fn(async (_settings: unknown, runId: string) => runId.startsWith("run-")),
  controlCompanionRun: jest.fn(async () => ({ accepted: true, currentRevision: 5 })),
}
jest.mock("@/lib/router-fusion/api/companion-run-host", () => {
  mockHostLoads += 1
  return mockHost
})

const mockCockpitControl = jest.fn(async (_payload?: unknown) => ({
  accepted: true,
  cockpit: true,
}))
jest.mock("@/lib/companion/execution-run-control-handler", () => ({
  handleExecutionRunControl: (payload: unknown) => mockCockpitControl(payload),
  handleLegacyTeamRunControl: jest.fn(),
}))

jest.mock("@/lib/capacitor/network", () => ({ subscribe: jest.fn(async () => () => {}) }))

import { dispatchCommand } from "./desktop-write-source"
import { __resetDbForTesting, activateAccountDatabase, getDb } from "@/lib/db/schema"
import { createOutboundRunner } from "@/lib/queue/outbound-queue"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { __resetBreakerForTesting } from "@/lib/router-fusion/gate/breaker"
import { __resetCompanionRunHostForTesting } from "@/lib/router-fusion/gate/companion-bridge"
import {
  enqueueCompanionFusionRun,
  followCompanionFusionRun,
  readBackCompanionFusionRun,
  cancelCompanionFusionRun,
  type CompanionRunIo,
} from "@/lib/router-fusion/api/companion-run-client"

const ON = { routerFusion: { enabled: true, surfaces: { companion: true } } }
const scope = { accountId: "acct_companion", targetId: "desktop-host", routingGeneration: 1 }

/** What Rust adds to every companion command before the brain sees it. */
function asDevice(command: string, payload: Record<string, unknown>) {
  return dispatchCommand(command, { ...payload, callerDeviceId: "phone-1" })
}

const hostIo: Partial<CompanionRunIo> = {
  call: ((command: string, args: Record<string, unknown>) =>
    asDevice(command, args)) as CompanionRunIo["call"],
  issueLease: async () => ({ token: "lease" }),
  sleep: async () => undefined,
}

async function queueAndDrain(text: string) {
  const pending = await enqueueCompanionFusionRun(
    { sessionId: "desktop-session", text, mode: "panel", label: "Panel run" },
    { newId: () => `id-${text}` }
  )
  const runner = createOutboundRunner({
    dispatcher: { call: (command, payload) => asDevice(command, payload) },
    enforceMobile: false,
    scope,
  })
  await runner.kick()
  await runner.stop()
  return pending
}

beforeEach(async () => {
  activateAccountDatabase(scope.accountId, scope.targetId)
  await getDb().delete()
  __resetDbForTesting()
  activateAccountDatabase(scope.accountId, scope.targetId)
  setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
  __resetBreakerForTesting()
  __resetCompanionRunHostForTesting()
  mockRuns.clear()
  mockSettings = null
  jest.clearAllMocks()
})

afterEach(async () => {
  clearActiveRuntimeTargetContext()
  await getDb().delete()
  __resetDbForTesting()
})

describe("companion Router + Fusion — switch off", () => {
  it("[ACC:OFF-03] delivers a queued run to a refusal, and loads nothing that could open the fusion database", async () => {
    const pending = await queueAndDrain("hello")
    // The queue delivered it: the refusal is an answer, not a failed delivery.
    await expect(getDb().mobileOutboundQueue.get(pending.rowId)).resolves.toMatchObject({
      command: "execution_run_create",
      status: "sent",
    })
    await expect(readBackCompanionFusionRun(pending, hostIo)).resolves.toMatchObject({
      ok: false,
      error: { status: 403, code: "ROUTER_FUSION_DISABLED" },
    })
    for (const [command, payload] of [
      ["execution_run_get", { runId: "run-1" }],
      ["execution_run_events", { runId: "run-1", afterSeq: 0 }],
      ["execution_run_resume", { runId: "run-1", body: {} }],
      ["claude_call_reserve_respond", { sessionId: "s", requestId: "q", decision: "granted" }],
    ] as const) {
      await expect(asDevice(command, payload)).resolves.toMatchObject({
        ok: false,
        error: { code: "ROUTER_FUSION_DISABLED" },
      })
    }
    // Run control is the cockpit's, exactly as before.
    await expect(
      asDevice("execution_run_control", {
        runId: "run-1",
        action: "stop",
        idempotencyKey: "k",
        expectedRevision: 1,
      })
    ).resolves.toEqual({ accepted: true, cockpit: true })
    expect(mockHostLoads).toBe(0)
  })
})

describe("companion Router + Fusion — switch on", () => {
  beforeEach(() => {
    mockSettings = ON
  })

  it("starts the queued run as the paired device, reads it back without starting another, and follows it", async () => {
    const pending = await queueAndDrain("compare the designs")
    expect(mockHost.createCompanionRun).toHaveBeenCalledTimes(1)
    expect(mockHost.createCompanionRun).toHaveBeenCalledWith(ON, {
      actor: expect.objectContaining({ keyId: "device:phone-1" }),
      mode: "panel",
      text: "compare the designs",
      sessionId: "desktop-session",
      idempotencyKey: pending.idempotencyKey,
    })

    const readBack = await readBackCompanionFusionRun(pending, hostIo)
    expect(readBack).toEqual({ ok: true, value: { run_id: "run-1" } })
    expect(mockRuns.size).toBe(1)

    const controller = new AbortController()
    await followCompanionFusionRun("run-1", {
      io: { ...hostIo, sleep: async () => controller.abort() },
      signal: controller.signal,
      onUpdate: () => undefined,
    })
    expect(mockHost.getCompanionRun).toHaveBeenCalledWith(ON, {
      actor: expect.objectContaining({ keyId: "device:phone-1" }),
      runId: "run-1",
    })
    expect(mockHost.listCompanionRunEvents).toHaveBeenCalledWith(ON, {
      actor: expect.objectContaining({ keyId: "device:phone-1" }),
      runId: "run-1",
      afterSeq: 0,
      limit: 200,
    })
  })

  it("stops a companion run through execution_run_control, and leaves every other run to the cockpit", async () => {
    await expect(cancelCompanionFusionRun("run-7", 3, hostIo)).resolves.toEqual({
      accepted: true,
      currentRevision: 5,
    })
    expect(mockHost.controlCompanionRun).toHaveBeenCalledWith(ON, {
      actor: expect.objectContaining({ keyId: "device:phone-1" }),
      command: { runId: "run-7", action: "stop", expectedRevision: 3 },
    })
    expect(mockCockpitControl).not.toHaveBeenCalled()

    await expect(
      asDevice("execution_run_control", {
        runId: "team-run-1",
        action: "stop",
        idempotencyKey: "k",
        expectedRevision: 1,
      })
    ).resolves.toEqual({ accepted: true, cockpit: true })
  })

  it("answers the relay verdict for a companion's reservation answer", async () => {
    await expect(
      asDevice("claude_call_reserve_respond", {
        sessionId: "s1",
        requestId: "req-1",
        decision: "refused",
        code: "RUN_BUDGET_EXHAUSTED",
      })
    ).resolves.toEqual({
      ok: true,
      value: { relay: true, sessionId: "s1", requestId: "req-1", decision: "refused" },
    })
  })
})

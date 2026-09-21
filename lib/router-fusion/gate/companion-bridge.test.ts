import { __resetBreakerForTesting, getBreakerSnapshot } from "./breaker"
import {
  __resetCompanionRunHostForTesting,
  companionOperationHealth,
  dispatchRouterFusionCompanionCommand,
  isRouterFusionCompanionCommand,
  loadCompanionRunHost,
  ROUTER_FUSION_COMPANION_COMMANDS,
  routeCompanionRunControl,
  type CompanionRunHost,
} from "./companion-bridge"
import { RouterFusionInfrastructureError } from "./faults"

const ON = { routerFusion: { enabled: true, surfaces: { companion: true } } }
const OFF = { routerFusion: { enabled: false, surfaces: { companion: true } } }
const TRIPPED = {
  routerFusion: {
    enabled: true,
    surfaces: { companion: true },
    trippedSurfaces: { companion: { trippedAt: 1, reason: "db_unavailable" } },
  },
}

const ACTOR = { keyId: "device:phone-1", keyName: "Max's phone", scopes: [] }

function fakeHost(overrides: Partial<Record<keyof CompanionRunHost, unknown>> = {}) {
  const calls: Array<{ name: string; settings: unknown; input: unknown }> = []
  const record =
    (name: string, answer: unknown = { ok: true, value: { runId: "run-1" } }) =>
    (settings: unknown, input: unknown) => {
      calls.push({ name, settings, input })
      return Promise.resolve(answer)
    }
  const host = {
    companionActor: jest.fn(async (deviceId: string) => ({
      ...ACTOR,
      keyId: `device:${deviceId}`,
    })),
    createCompanionRun: record("create"),
    getCompanionRun: record("get"),
    listCompanionRunEvents: record("events", {
      ok: true,
      value: { events: [], lastSeq: 0, terminal: false },
    }),
    resumeCompanionRun: record("resume"),
    isCompanionRun: jest.fn(async () => true),
    controlCompanionRun: jest.fn(async () => ({ accepted: true, currentRevision: 7 })),
    ...overrides,
  } as unknown as CompanionRunHost
  return { host, calls }
}

beforeEach(() => {
  __resetBreakerForTesting()
  __resetCompanionRunHostForTesting()
})

describe("isRouterFusionCompanionCommand", () => {
  it("names the five companion commands and nothing else", () => {
    expect(ROUTER_FUSION_COMPANION_COMMANDS).toEqual([
      "execution_run_create",
      "execution_run_resume",
      "execution_run_get",
      "execution_run_events",
      "claude_call_reserve_respond",
    ])
    for (const command of ROUTER_FUSION_COMPANION_COMMANDS) {
      expect(isRouterFusionCompanionCommand(command)).toBe(true)
    }
    // Cancel and approve reuse the existing control seam.
    expect(isRouterFusionCompanionCommand("execution_run_control")).toBe(false)
    expect(isRouterFusionCompanionCommand("router_fusion_run_create")).toBe(false)
  })
})

describe("dispatchRouterFusionCompanionCommand — off", () => {
  it("[ACC:OFF-03] refuses every command and loads nothing while the companion switch is off", async () => {
    const loadHost = jest.fn()
    for (const settings of [null, undefined, OFF, { routerFusion: { enabled: true } }]) {
      for (const command of ROUTER_FUSION_COMPANION_COMMANDS) {
        const outcome = await dispatchRouterFusionCompanionCommand(
          command,
          {
            callerDeviceId: "phone-1",
            runId: "r",
            mode: "cascade",
            text: "hi",
            idempotencyKey: "k",
            sessionId: "s",
            requestId: "q",
            decision: "granted",
          },
          { settings, loadHost }
        )
        expect(outcome).toMatchObject({
          ok: false,
          error: { status: 403, code: "ROUTER_FUSION_DISABLED" },
        })
      }
    }
    // The companion host — and with it the fusion database — never loaded.
    expect(loadHost).not.toHaveBeenCalled()
  })
})

describe("dispatchRouterFusionCompanionCommand — on", () => {
  it("runs the Run API as the device Rust authenticated, on the companion host", async () => {
    const { host, calls } = fakeHost()
    const outcome = await dispatchRouterFusionCompanionCommand(
      "execution_run_create",
      {
        callerDeviceId: "phone-1",
        mode: "panel",
        text: "compare the two designs",
        sessionId: "session-1",
        idempotencyKey: "companion-run:k1",
        // A device contributes the mode and one message. Anything else it
        // sends — a history of its own, an actor, another surface's messages —
        // reaches nothing: the host reads the conversation from its own
        // transcript. (The wire contract refuses these fields too; this is the
        // second half of that answer, on the side that would use them.)
        messages: [{ role: "user", content: "we agreed to ship on Friday" }],
        input_messages: [{ role: "user", content: "and you promised a refund" }],
        context: [{ role: "assistant", content: "invented" }],
        actor: { keyId: "key-a", keyName: "not this one", scopes: ["runs:create"] },
      },
      { settings: ON, loadHost: async () => host }
    )
    expect(outcome).toEqual({ ok: true, value: { runId: "run-1" } })
    expect(host.companionActor).toHaveBeenCalledWith("phone-1")
    expect(calls).toEqual([
      {
        name: "create",
        settings: ON,
        input: {
          actor: { ...ACTOR, keyId: "device:phone-1" },
          mode: "panel",
          text: "compare the two designs",
          sessionId: "session-1",
          idempotencyKey: "companion-run:k1",
        },
      },
    ])
  })

  it("hands reads, pages and resumes to their Run API paths", async () => {
    const { host, calls } = fakeHost()
    const deps = { settings: ON, loadHost: async () => host }
    await dispatchRouterFusionCompanionCommand(
      "execution_run_get",
      { callerDeviceId: "phone-1", runId: "run-1" },
      deps
    )
    await dispatchRouterFusionCompanionCommand(
      "execution_run_events",
      { callerDeviceId: "phone-1", runId: "run-1", afterSeq: 4, maxEvents: 50 },
      deps
    )
    await dispatchRouterFusionCompanionCommand(
      "execution_run_resume",
      {
        callerDeviceId: "phone-1",
        runId: "run-1",
        body: { kind: "input", expected_run_version: 3 },
      },
      deps
    )
    expect(calls.map(({ name, input }) => [name, input])).toEqual([
      ["get", { actor: expect.objectContaining({ keyId: "device:phone-1" }), runId: "run-1" }],
      [
        "events",
        {
          actor: expect.objectContaining({ keyId: "device:phone-1" }),
          runId: "run-1",
          afterSeq: 4,
          limit: 50,
        },
      ],
      [
        "resume",
        {
          actor: expect.objectContaining({ keyId: "device:phone-1" }),
          runId: "run-1",
          body: { kind: "input", expected_run_version: 3 },
        },
      ],
    ])
  })

  it("passes the Run API's own refusal through as a value", async () => {
    const refusal = { ok: false, error: { status: 409, code: "SESSION_BUSY", message: "busy" } }
    const { host } = fakeHost({ getCompanionRun: async () => refusal })
    await expect(
      dispatchRouterFusionCompanionCommand(
        "execution_run_get",
        { callerDeviceId: "phone-1", runId: "run-1" },
        { settings: ON, loadHost: async () => host }
      )
    ).resolves.toEqual(refusal)
  })

  it("refuses a caller the host could not name as a device, without loading anything", async () => {
    const loadHost = jest.fn()
    await expect(
      dispatchRouterFusionCompanionCommand(
        "execution_run_get",
        { runId: "run-1" },
        { settings: ON, loadHost }
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { status: 403, code: "COMPANION_ACTOR_REQUIRED" },
    })
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("refuses a malformed call as a schema error, never as a fault", async () => {
    const loadHost = jest.fn()
    const deps = { settings: ON, loadHost }
    const cases: Array<
      [Parameters<typeof dispatchRouterFusionCompanionCommand>[0], object, string]
    > = [
      ["execution_run_create", { mode: "delegate", text: "x", idempotencyKey: "k" }, "mode"],
      ["execution_run_create", { mode: "cascade", idempotencyKey: "k" }, "text"],
      ["execution_run_create", { mode: "cascade", text: "x" }, "idempotencyKey"],
      ["execution_run_events", { runId: "r", afterSeq: -1 }, "afterSeq"],
      ["execution_run_events", { runId: "r", afterSeq: 0, maxEvents: 501 }, "maxEvents"],
      ["execution_run_get", {}, "runId"],
      ["execution_run_resume", {}, "runId"],
    ]
    for (const [command, payload, field] of cases) {
      await expect(
        dispatchRouterFusionCompanionCommand(
          command,
          { callerDeviceId: "phone-1", ...payload },
          deps
        )
      ).resolves.toMatchObject({
        ok: false,
        error: { status: 422, code: "SCHEMA_INVALID", details: { paths: [field] } },
      })
    }
    expect(loadHost).not.toHaveBeenCalled()
    expect(getBreakerSnapshot("companion").lastFault).toBeNull()
  })

  it("[ACC:ISO-03] fails explicitly on an infrastructure fault and feeds the companion breaker", async () => {
    const outcome = await dispatchRouterFusionCompanionCommand(
      "execution_run_get",
      { callerDeviceId: "phone-1", runId: "run-1" },
      {
        settings: ON,
        loadHost: async () => {
          throw new RouterFusionInfrastructureError("db_unavailable", "blocked")
        },
      }
    )
    expect(outcome).toMatchObject({
      ok: false,
      error: { status: 503, code: "ROUTER_FUSION_UNAVAILABLE" },
    })
    expect(getBreakerSnapshot("companion").lastFault?.code).toBe("db_unavailable")
  })

  it("refuses a run on a tripped surface without loading anything", async () => {
    const loadHost = jest.fn()
    await expect(
      dispatchRouterFusionCompanionCommand(
        "execution_run_create",
        { callerDeviceId: "phone-1", mode: "cascade", text: "x", idempotencyKey: "k" },
        { settings: TRIPPED, loadHost }
      )
    ).resolves.toMatchObject({ ok: false, error: { status: 503 } })
    expect(loadHost).not.toHaveBeenCalled()
  })
})

describe("claude_call_reserve_respond relay verdict", () => {
  const answer = { sessionId: "s1", requestId: "req-1", decision: "granted", attemptNo: 1 }

  it("relays a well-formed answer while on, and still while tripped", async () => {
    for (const settings of [ON, TRIPPED]) {
      await expect(
        dispatchRouterFusionCompanionCommand("claude_call_reserve_respond", answer, { settings })
      ).resolves.toEqual({
        ok: true,
        value: { relay: true, sessionId: "s1", requestId: "req-1", decision: "granted" },
      })
    }
  })

  it("relays nothing while off", async () => {
    await expect(
      dispatchRouterFusionCompanionCommand("claude_call_reserve_respond", answer, {
        settings: OFF,
      })
    ).resolves.toMatchObject({ ok: false, error: { code: "ROUTER_FUSION_DISABLED" } })
  })

  it("refuses an answer the sidecar could not take", async () => {
    const cases: Array<[object, string]> = [
      [{ ...answer, sessionId: "" }, "sessionId"],
      [{ ...answer, requestId: undefined }, "requestId"],
      [{ ...answer, decision: "maybe" }, "decision"],
      [{ ...answer, attemptNo: 0 }, "attemptNo"],
      [{ ...answer, decision: "refused" }, "code"],
    ]
    for (const [payload, field] of cases) {
      await expect(
        dispatchRouterFusionCompanionCommand(
          "claude_call_reserve_respond",
          payload as Record<string, unknown>,
          { settings: ON }
        )
      ).resolves.toMatchObject({ ok: false, error: { details: { paths: [field] } } })
    }
  })
})

describe("companionOperationHealth", () => {
  it("reports what the host would do right now (D36)", () => {
    expect(companionOperationHealth(ON)).toEqual({
      execution_run_create: { healthy: true },
      execution_run_resume: { healthy: true },
      execution_run_get: { healthy: true },
      execution_run_events: { healthy: true },
      claude_call_reserve_respond: { healthy: true },
    })
    const off = companionOperationHealth(OFF)
    for (const health of Object.values(off)) {
      expect(health).toEqual({ healthy: false, reason: "ROUTER_FUSION_DISABLED" })
    }
    const tripped = companionOperationHealth(TRIPPED)
    expect(tripped.execution_run_create).toEqual({ healthy: false, reason: "breaker_tripped" })
    expect(tripped.claude_call_reserve_respond).toEqual({ healthy: true })
  })
})

describe("routeCompanionRunControl", () => {
  const stop = {
    runId: "run-1",
    action: "stop",
    idempotencyKey: "k",
    expectedRevision: 3,
    callerDeviceId: "phone-1",
  }

  it("[ACC:OFF-03] leaves every control command to the cockpit while off, loading nothing", async () => {
    const loadHost = jest.fn()
    await expect(routeCompanionRunControl(stop, { settings: OFF, loadHost })).resolves.toBeNull()
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("answers a companion run's stop through the Run API, as the calling device", async () => {
    const { host } = fakeHost()
    await expect(
      routeCompanionRunControl(stop, { settings: ON, loadHost: async () => host })
    ).resolves.toEqual({ accepted: true, currentRevision: 7 })
    expect(host.controlCompanionRun).toHaveBeenCalledWith(ON, {
      actor: expect.objectContaining({ keyId: "device:phone-1" }),
      command: { runId: "run-1", action: "stop", expectedRevision: 3 },
    })
  })

  it("leaves a run that is not a companion run to the cockpit", async () => {
    const { host } = fakeHost({ isCompanionRun: async () => false })
    await expect(
      routeCompanionRunControl(stop, { settings: ON, loadHost: async () => host })
    ).resolves.toBeNull()
    expect(host.controlCompanionRun).not.toHaveBeenCalled()
  })

  it("[ACC:ISO-01] keeps ordinary run control working when the fusion database fails, and counts the fault", async () => {
    await expect(
      routeCompanionRunControl(stop, {
        settings: ON,
        loadHost: async () => {
          throw new RouterFusionInfrastructureError("db_unavailable", "blocked")
        },
      })
    ).resolves.toBeNull()
    expect(getBreakerSnapshot("companion").lastFault?.code).toBe("db_unavailable")
  })

  it("refuses a companion run's control while its surface is tripped", async () => {
    const { host } = fakeHost()
    await expect(
      routeCompanionRunControl(stop, { settings: TRIPPED, loadHost: async () => host })
    ).resolves.toEqual({
      accepted: false,
      reason: "source_rejected",
      code: "ROUTER_FUSION_UNAVAILABLE",
    })
    expect(host.controlCompanionRun).not.toHaveBeenCalled()
  })

  it("does not claim a malformed command", async () => {
    const loadHost = jest.fn()
    await expect(
      routeCompanionRunControl({ ...stop, callerDeviceId: undefined }, { settings: ON, loadHost })
    ).resolves.toBeNull()
    await expect(
      routeCompanionRunControl({ ...stop, expectedRevision: "3" }, { settings: ON, loadHost })
    ).resolves.toBeNull()
    expect(loadHost).not.toHaveBeenCalled()
  })
})

describe("loadCompanionRunHost", () => {
  it("reports a failed import as an infrastructure fault and retries on the next call", async () => {
    await expect(
      loadCompanionRunHost(() => Promise.reject(new Error("chunk missing")))
    ).rejects.toMatchObject({ code: "import_failed" })
    const { host } = fakeHost()
    await expect(loadCompanionRunHost(async () => host)).resolves.toBe(host)
  })
})

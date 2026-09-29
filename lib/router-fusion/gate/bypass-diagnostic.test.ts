import type { CogniaDiagnostic } from "@cognia/diagnostics"

import { createLedgerBypassReporter, reportLedgerBypass } from "./bypass-diagnostic"

jest.mock("@/lib/diagnostics/bus", () => ({ dispatchDiagnostic: jest.fn() }))
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: jest.fn(async () => (key: string) => `routerFusion.bypass.${key}`),
}))

const FAULT = { code: "db_unavailable" as const, message: "OpenFailedError: the fusion db is gone" }

function harness() {
  const dispatched: Array<{ diagnostic: CogniaDiagnostic; origin: { kind: string; id: string } }> =
    []
  const translate = jest.fn(
    (key: string, values?: Record<string, unknown>) =>
      `${key}: ${String(values?.feature)} (${String(values?.code)})`
  )
  const reporter = createLedgerBypassReporter({
    dispatch: (diagnostic, origin) => dispatched.push({ diagnostic, origin }),
    translator: async () => translate,
    now: () => 1_000,
  })
  return { reporter, dispatched, translate }
}

describe("createLedgerBypassReporter", () => {
  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  it("raises one routerFusionBypassed notice carrying the feature and the fault", async () => {
    const { reporter, dispatched } = harness()
    await reporter.report({
      surface: "utilityLedger",
      featureId: "conversation-title",
      fault: FAULT,
    })
    expect(dispatched).toHaveLength(1)
    const [{ diagnostic, origin }] = dispatched
    expect(diagnostic).toMatchObject({
      code: "routerFusionBypassed",
      source: "provider",
      severity: "warning",
      retryable: false,
      message: "utilityLedger: conversation-title (db_unavailable)",
      detail: "db_unavailable\nOpenFailedError: the fusion db is gone",
      meta: {
        extra: {
          surface: "utilityLedger",
          featureId: "conversation-title",
          faultCode: "db_unavailable",
          bypassCount: 1,
        },
      },
    })
    expect(origin).toEqual({ kind: "background", id: "router-fusion:utilityLedger" })
  })

  it("announces a surface once per session and counts every later bypass", async () => {
    const { reporter, dispatched } = harness()
    await reporter.report({ surface: "utilityLedger", featureId: "a", fault: FAULT })
    await reporter.report({ surface: "utilityLedger", featureId: "b", fault: FAULT })
    await reporter.report({ surface: "utilityLedger", featureId: "c", fault: FAULT })
    expect(dispatched).toHaveLength(1)
    expect(reporter.count("utilityLedger")).toBe(3)
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("3 on utilityLedger"))

    // Another surface is its own incident.
    await reporter.report({ surface: "agentsWorkflows", featureId: "workflow:s1", fault: FAULT })
    expect(dispatched).toHaveLength(2)
    expect(dispatched[1].diagnostic.source).toBe("workflow")
    expect(dispatched[1].diagnostic.message).toBe("agentsWorkflows: workflow:s1 (db_unavailable)")
  })

  it("falls back to the feature and code when no sentence resolves", async () => {
    const dispatched: CogniaDiagnostic[] = []
    const reporter = createLedgerBypassReporter({
      dispatch: (diagnostic) => dispatched.push(diagnostic),
      translator: async () => (key) => `routerFusion.bypass.${key}`,
    })
    await reporter.report({ surface: "chat", featureId: "x", fault: FAULT })
    expect(dispatched[0].message).toBe("x: db_unavailable")

    const failing = createLedgerBypassReporter({
      dispatch: (diagnostic) => dispatched.push(diagnostic),
      translator: async () => {
        throw new Error("no bundle")
      },
    })
    await failing.report({ surface: "utilityLedger", featureId: "y", fault: FAULT })
    expect(dispatched[1].message).toBe("y: db_unavailable")
  })
})

describe("reportLedgerBypass", () => {
  it("dispatches through the diagnostics bus with the translated sentence", async () => {
    const { dispatchDiagnostic } = jest.requireMock("@/lib/diagnostics/bus") as {
      dispatchDiagnostic: jest.Mock
    }
    reportLedgerBypass({ surface: "agentsWorkflows", featureId: "workflow:s9", fault: FAULT })
    for (let i = 0; i < 20 && dispatchDiagnostic.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(dispatchDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: "routerFusionBypassed", source: "workflow" }),
      { kind: "background", id: "router-fusion:agentsWorkflows" }
    )
  })
})

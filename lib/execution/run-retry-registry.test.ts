import {
  __resetRunRetryHandlersForTesting,
  canRetryRunKind,
  getRunRetryHandler,
  registerRunRetryHandler,
} from "./run-retry-registry"

const handler = async () => ({ runId: "run-2" })

describe("run retry registry", () => {
  beforeEach(__resetRunRetryHandlersForTesting)

  it("reports a kind as retryable only once something can re-dispatch it", () => {
    // This predicate is the whole reason `allowedActions` can offer the button
    // honestly: a kind nothing can restart never renders a Retry.
    expect(canRetryRunKind("workflow")).toBe(false)
    registerRunRetryHandler("workflow", handler)
    expect(canRetryRunKind("workflow")).toBe(true)
  })

  it("keeps kinds independent", () => {
    registerRunRetryHandler("workflow", handler)
    expect(canRetryRunKind("team")).toBe(false)
    expect(canRetryRunKind("agent-turn")).toBe(false)
  })

  it("hands back the registered handler", async () => {
    registerRunRetryHandler("delegation", handler)
    const found = getRunRetryHandler("delegation")
    expect(found).toBeDefined()
    await expect(
      found!({
        run: {
          id: "run-1",
          kind: "delegation",
          sourceId: "s",
          title: "t",
          status: "failed",
          currentRevision: 1,
          startedAt: 0,
          updatedAt: 0,
        },
        command: {
          runId: "run-1",
          action: "retry",
          idempotencyKey: "k",
          expectedRevision: 1,
          actor: {},
        },
      })
    ).resolves.toEqual({ runId: "run-2" })
  })

  it("unregisters only its own handler, so a re-install cannot orphan the new one", () => {
    const unregisterFirst = registerRunRetryHandler("workflow", handler)
    registerRunRetryHandler("workflow", async () => ({ runId: "run-3" }))
    unregisterFirst()
    // The second registration replaced the first; disposing the first must not
    // take the live one down with it.
    expect(canRetryRunKind("workflow")).toBe(true)
  })
})

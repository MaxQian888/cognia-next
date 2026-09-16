import type { RouterFusionRunStamp } from "@cognia/agent-config-types"

import { __resetBreakerForTesting, getBreakerSnapshot } from "./breaker"
import {
  __resetRouterFusionChatRunsForTesting,
  cancelRouterFusionChatRun,
  routerFusionChatRunActive,
  runRouterFusionChatTurn,
} from "./chat-fusion-run"
import {
  RouterFusionInfrastructureError,
  RouterFusionRefusalError,
  RouterFusionUnavailableError,
} from "./faults"
import type { RouterFusionHost } from "./load-engine"

const ON = { routerFusion: { enabled: true, surfaces: { chat: true } } }
const OFF = { routerFusion: { enabled: false, surfaces: { chat: true } } }
const TRIPPED = {
  routerFusion: {
    enabled: true,
    surfaces: { chat: true },
    trippedSurfaces: { chat: { trippedAt: 1, reason: "db_unavailable" } },
  },
}

const STAMP: RouterFusionRunStamp = {
  runId: "run-1",
  decisionId: "decision-1",
  actionId: "panel_review",
  mode: "panel",
  ruleId: "R1_explicit_mode",
  requested: "panel",
  roles: { judge: "openai::gpt-5" },
  budgetMode: "tracked",
  capMicrousd: 2_000_000,
  acceptanceProfile: "evidence_review",
}

function input(settings: unknown, host: Partial<RouterFusionHost>) {
  return {
    sessionId: "session-1",
    stamp: STAMP,
    messages: [{ role: "user" as const, content: "compare" }],
    workspaceRoot: "/work",
    settings: settings as never,
    loadHost: async () => host as RouterFusionHost,
  }
}

beforeEach(() => {
  __resetBreakerForTesting()
  __resetRouterFusionChatRunsForTesting()
})

describe("runRouterFusionChatTurn", () => {
  it("runs the turn through the host, marking the session while it runs", async () => {
    let activeDuring = false
    const startChatFusionTurn = jest.fn(async () => {
      activeDuring = routerFusionChatRunActive("session-1")
      return { kind: "cancelled" as const, summary: null }
    })
    const progress = jest.fn()
    const outcome = await runRouterFusionChatTurn({
      ...input(ON, { startChatFusionTurn } as never),
      onProgress: progress,
    })
    expect(outcome).toEqual({ kind: "cancelled", summary: null })
    expect(activeDuring).toBe(true)
    expect(routerFusionChatRunActive("session-1")).toBe(false)
    expect(startChatFusionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        stamp: STAMP,
        workspaceRoot: "/work",
        appSettings: ON,
        onProgress: progress,
      })
    )
  })

  it("keeps the session marked while a later turn runs after an earlier one ends", async () => {
    const releases: Array<() => void> = []
    const startChatFusionTurn = () =>
      new Promise<{ kind: "cancelled"; summary: null }>((resolve) => {
        releases.push(() => resolve({ kind: "cancelled", summary: null }))
      })
    const first = runRouterFusionChatTurn(input(ON, { startChatFusionTurn } as never))
    const second = runRouterFusionChatTurn(input(ON, { startChatFusionTurn } as never))
    await new Promise((resolve) => setTimeout(resolve, 0))
    releases[0]?.()
    await first
    expect(routerFusionChatRunActive("session-1")).toBe(true)
    releases[1]?.()
    await second
    expect(routerFusionChatRunActive("session-1")).toBe(false)
  })

  it("[ACC:ISO-03] reports an infrastructure fault as unavailable, never as an ordinary answer", async () => {
    const startChatFusionTurn = jest.fn(async () => {
      throw new RouterFusionInfrastructureError(
        "db_unavailable",
        "the fusion database will not open"
      )
    })
    await expect(
      runRouterFusionChatTurn(input(ON, { startChatFusionTurn } as never))
    ).rejects.toBeInstanceOf(RouterFusionUnavailableError)
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(1)
    expect(routerFusionChatRunActive("session-1")).toBe(false)
  })

  it("refuses without loading anything when chat is off or paused", async () => {
    const loadHost = jest.fn()
    await expect(
      runRouterFusionChatTurn({ ...input(OFF, {}), loadHost: loadHost as never })
    ).rejects.toBeInstanceOf(RouterFusionRefusalError)
    await expect(
      runRouterFusionChatTurn({ ...input(TRIPPED, {}), loadHost: loadHost as never })
    ).rejects.toMatchObject({ code: "ROUTER_FUSION_UNAVAILABLE" })
    expect(loadHost).not.toHaveBeenCalled()
  })
})

describe("cancelRouterFusionChatRun", () => {
  it("is a no-op without loading anything for a session with no fusion turn", async () => {
    const loadHost = jest.fn()
    await cancelRouterFusionChatRun("session-1", { loadHost: loadHost as never })
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("cancels the running turn, and counts a fault instead of throwing it", async () => {
    let release: () => void = () => {}
    const cancelChatFusionTurn = jest.fn(async () => true)
    const running = runRouterFusionChatTurn(
      input(ON, {
        startChatFusionTurn: () =>
          new Promise((resolve) => {
            release = () => resolve({ kind: "cancelled", summary: null })
          }),
      } as never)
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await cancelRouterFusionChatRun("session-1", {
      loadHost: async () => ({ cancelChatFusionTurn }) as never,
    })
    expect(cancelChatFusionTurn).toHaveBeenCalledWith("session-1")

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await cancelRouterFusionChatRun("session-1", {
      loadHost: async () => {
        throw new Error("import failed")
      },
    })
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(1)
    warn.mockRestore()
    release()
    await running
  })
})

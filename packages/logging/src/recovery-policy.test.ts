import {
  createRecoveryState,
  recordChildFailure,
  recordHealthyCheckpoint,
  recordRendererFailure,
  recordSubsystemCheckpoint,
  recordUnhealthyStart,
  type RecoveryState,
} from "./recovery-policy"

describe("bounded crash recovery policy", () => {
  it("enters safe mode after two unhealthy starts for one build within ten minutes", () => {
    let state = createRecoveryState("build-a")
    state = recordUnhealthyStart(state, Date.parse("2026-08-01T10:00:00Z"))
    expect(state.mode).toBe("normal")
    state = recordUnhealthyStart(state, Date.parse("2026-08-01T10:09:00Z"))

    expect(state.mode).toBe("safe")
    expect(state.unhealthyStarts).toHaveLength(2)
  })

  it("does not carry a crash loop across builds or outside the ten-minute window", () => {
    let state = createRecoveryState("build-a")
    state = recordUnhealthyStart(state, 0)
    state = recordUnhealthyStart(state, 11 * 60_000)
    expect(state.mode).toBe("normal")

    state = recordUnhealthyStart({ ...state, buildId: "build-b" }, 12 * 60_000)
    expect(state.unhealthyStarts).toEqual([12 * 60_000])
  })

  it("allows one renderer reload per five minutes", () => {
    const state = createRecoveryState("build-a")
    const first = recordRendererFailure(state, 1_000)
    const blocked = recordRendererFailure(first.state, 2_000)
    const later = recordRendererFailure(first.state, 5 * 60_000 + 1_001)

    expect(first.action).toBe("reload")
    expect(blocked.action).toBe("open-safe-mode")
    expect(later.action).toBe("reload")
  })

  it("bounds child restarts to three exponential attempts", () => {
    let state = createRecoveryState("build-a")
    const actions = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = recordChildFailure(state, "sidecar", attempt * 10)
      state = result.state
      actions.push(result.action)
    }

    expect(actions).toEqual([
      { kind: "restart", delayMs: 1_000, attempt: 1 },
      { kind: "restart", delayMs: 2_000, attempt: 2 },
      { kind: "restart", delayMs: 4_000, attempt: 3 },
      { kind: "disable", suspectSubsystem: "sidecar" },
    ])
  })

  it("requires progressive safe-mode checkpoints and ten stable minutes to recover", () => {
    let state: RecoveryState = { ...createRecoveryState("build-a"), mode: "safe" }
    state = recordSubsystemCheckpoint(state, "storage", true, 1_000)
    state = recordSubsystemCheckpoint(state, "sidecar", false, 2_000)
    expect(state.mode).toBe("safe")
    expect(state.suspectSubsystem).toBe("sidecar")

    state = recordSubsystemCheckpoint(state, "sidecar", true, 3_000)
    state = recordHealthyCheckpoint(state, 9 * 60_000)
    expect(state.mode).toBe("recovering")
    state = recordHealthyCheckpoint(state, 10 * 60_000 + 3_000)
    expect(state.mode).toBe("normal")
    expect(state.unhealthyStarts).toEqual([])
  })
})

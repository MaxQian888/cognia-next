import { loadReplayFixture, replayAvailability } from "./fixture"
import type {
  ReplayScenarioV1,
  ReplayTapeV1,
} from "@cognia/agent-config-types/model-request-surface"

const DIGEST_A = `sha256:${"a".repeat(64)}`
const DIGEST_B = `sha256:${"b".repeat(64)}`

function scenario(overrides: Partial<ReplayScenarioV1> = {}): ReplayScenarioV1 {
  return {
    schemaVersion: 1,
    scenarioId: "sc-1",
    title: "plain turn",
    level: "runtime",
    platform: "headless",
    actors: [{ actorRef: "root", role: "root" }],
    inputSteps: [{ kind: "prompt", actorRef: "root", text: "hello" }],
    permissionScript: [],
    expectations: { assertConsumed: true, fidelity: "full" },
    ...overrides,
  }
}

function tape(overrides: Partial<ReplayTapeV1> = {}): ReplayTapeV1 {
  return {
    schemaVersion: 1,
    tapeId: "tape-1",
    match: { actorRef: "root", purpose: "turn", requestDigest: DIGEST_A },
    behavior: { kind: "stream", chunksRef: "asset-1" },
    synthetic: true,
    ...overrides,
  }
}

function errorsOf(result: ReturnType<typeof loadReplayFixture>): string[] {
  if (result.ok) throw new Error("expected the fixture to be rejected")
  return result.errors
}

describe("loadReplayFixture", () => {
  it("accepts a scenario with its tapes", () => {
    const result = loadReplayFixture({ scenario: scenario(), tapes: [tape()] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.value.tapes).toHaveLength(1)
    expect(result.value.scenario.scenarioId).toBe("sc-1")
  })

  it("accepts a scenario with no tapes at all", () => {
    // A canonical-replay scenario legitimately has none.
    expect(loadReplayFixture({ scenario: scenario({ level: "canonical" }), tapes: [] }).ok).toBe(
      true
    )
  })

  it("rejects a non-object", () => {
    expect(errorsOf(loadReplayFixture("fixture"))).toEqual(["fixture must be an object"])
  })

  it("rejects a missing tape list", () => {
    expect(errorsOf(loadReplayFixture({ scenario: scenario() }))).toContain(
      "tapes must be an array"
    )
  })

  it("prefixes scenario and tape errors with where they came from", () => {
    const errors = errorsOf(
      loadReplayFixture({
        scenario: scenario({ scenarioId: "" }),
        tapes: [tape({ tapeId: "" })],
      })
    )
    expect(errors).toContain("scenario: scenarioId must be a non-empty string")
    expect(errors).toContain("tapes[0]: tapeId must be a non-empty string")
  })

  it("catches a tape whose actor the scenario never declared", () => {
    // Without this the fixture loads, matches nothing, and reports "the model
    // was never called" — which points at the runner, not the typo.
    const errors = errorsOf(
      loadReplayFixture({
        scenario: scenario(),
        tapes: [tape({ match: { actorRef: "rooot", purpose: "turn", requestDigest: DIGEST_A } })],
      })
    )
    expect(errors).toContain("tape tape-1 names actor rooot, which the scenario does not declare")
  })

  it("accepts a tape belonging to a declared child", () => {
    const result = loadReplayFixture({
      scenario: scenario({
        actors: [
          { actorRef: "root", role: "root" },
          { actorRef: "child-1", role: "child", parentActorRef: "root" },
        ],
      }),
      tapes: [
        tape(),
        tape({
          tapeId: "tape-2",
          match: { actorRef: "child-1", purpose: "subagent", requestDigest: DIGEST_B },
        }),
      ],
    })
    expect(result.ok).toBe(true)
  })

  it("rejects two tapes that answer one match key differently", () => {
    const errors = errorsOf(
      loadReplayFixture({
        scenario: scenario(),
        tapes: [tape({ tapeId: "a" }), tape({ tapeId: "b", behavior: { kind: "cancel" } })],
      })
    )
    expect(errors.some((error) => error.startsWith("ambiguous tapes for"))).toBe(true)
  })

  it("allows a repeated question answered identically twice", () => {
    expect(
      loadReplayFixture({
        scenario: scenario(),
        tapes: [tape({ tapeId: "a" }), tape({ tapeId: "b" })],
      }).ok
    ).toBe(true)
  })

  it("admits a real recording by default", () => {
    expect(
      loadReplayFixture({ scenario: scenario(), tapes: [tape({ synthetic: false })] }).ok
    ).toBe(true)
  })

  it("refuses a real recording when synthetic is required", () => {
    const errors = errorsOf(
      loadReplayFixture(
        { scenario: scenario(), tapes: [tape({ synthetic: false })] },
        { requireSynthetic: true }
      )
    )
    expect(errors).toContain("tape tape-1 is a real recording and cannot be admitted")
  })

  it("does not cross-check when the pieces did not parse", () => {
    // Cross-referencing a broken scenario against broken tapes yields noise.
    const errors = errorsOf(
      loadReplayFixture({ scenario: { schemaVersion: 1 }, tapes: [tape({ tapeId: "" })] })
    )
    expect(errors.some((error) => error.includes("does not declare"))).toBe(false)
  })
})

describe("replayAvailability", () => {
  it("runs canonical replay anywhere, including a browser", () => {
    expect(
      replayAvailability(scenario({ level: "canonical", platform: "browser" }), {
        platform: "browser",
      })
    ).toEqual({ runnable: true })
  })

  it("explains why runtime replay cannot run in a browser", () => {
    const verdict = replayAvailability(scenario(), { platform: "browser" })
    expect(verdict.runnable).toBe(false)
    if (verdict.runnable) throw new Error("expected unavailable")
    expect(verdict.reason).toContain("desktop app")
  })

  it("runs runtime replay on the platform it was recorded for", () => {
    expect(replayAvailability(scenario({ platform: "tauri" }), { platform: "tauri" })).toEqual({
      runnable: true,
    })
  })

  it("refuses a runtime scenario recorded for a different host", () => {
    const verdict = replayAvailability(scenario({ platform: "tauri" }), { platform: "headless" })
    expect(verdict.runnable).toBe(false)
    if (verdict.runnable) throw new Error("expected unavailable")
    expect(verdict.reason).toContain("recorded for tauri")
  })
})

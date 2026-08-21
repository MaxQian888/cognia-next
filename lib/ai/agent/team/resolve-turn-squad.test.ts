import { resolveTurnSquad } from "./resolve-turn-squad"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"

function selection(partial: Partial<AgentCompositionSelectionV1>): AgentCompositionSelectionV1 {
  return { presetId: "p1", ...partial }
}

describe("resolveTurnSquad", () => {
  it("returns no Squad for a plain conversation", () => {
    expect(resolveTurnSquad({})).toEqual({ squadId: null, source: "none" })
    expect(resolveTurnSquad({ session: null })).toEqual({ squadId: null, source: "none" })
    expect(resolveTurnSquad({ session: {} })).toEqual({ squadId: null, source: "none" })
  })

  it("uses the conversation's bound Squad when the turn says nothing", () => {
    expect(resolveTurnSquad({ session: { squadId: "squad-1" } })).toEqual({
      squadId: "squad-1",
      source: "session",
    })
  })

  it("lets the turn point at a different Squad than the conversation", () => {
    expect(
      resolveTurnSquad({
        turnOverride: selection({ orchestration: "team", orchestrationRef: "squad-2" }),
        session: { squadId: "squad-1" },
      })
    ).toEqual({ squadId: "squad-2", source: "turn-override" })
  })

  it("lets the turn opt OUT of a bound Squad", () => {
    // The override has to point down as well as up, or a Squad-bound
    // conversation could never send one plain turn.
    expect(
      resolveTurnSquad({
        turnOverride: selection({ orchestration: "direct" }),
        session: { squadId: "squad-1" },
      })
    ).toEqual({ squadId: null, source: "turn-override" })
  })

  it("treats every other orchestration policy as opting out too", () => {
    for (const orchestration of ["subagent", "workflow", "verified-fresh-agent"] as const) {
      expect(
        resolveTurnSquad({
          turnOverride: selection({ orchestration }),
          session: { squadId: "squad-1" },
        })
      ).toEqual({ squadId: null, source: "turn-override" })
    }
  })

  it("inherits the session when the override names no orchestration at all", () => {
    // A selection that only pins, say, tool presentation must not disturb the
    // executor — `undefined` on this axis means inherit, not "direct".
    expect(
      resolveTurnSquad({
        turnOverride: selection({ toolPresentation: "native" }),
        session: { squadId: "squad-1" },
      })
    ).toEqual({ squadId: "squad-1", source: "session" })
  })

  it("does not fall back to the session when `team` is chosen with no target", () => {
    // A half-made selection must not silently run the conversation's Squad —
    // that would run something the user did not pick.
    expect(
      resolveTurnSquad({
        turnOverride: selection({ orchestration: "team" }),
        session: { squadId: "squad-1" },
      })
    ).toEqual({ squadId: null, source: "turn-override" })
    expect(
      resolveTurnSquad({
        turnOverride: selection({ orchestration: "team", orchestrationRef: "   " }),
        session: { squadId: "squad-1" },
      })
    ).toEqual({ squadId: null, source: "turn-override" })
  })

  it("ignores whitespace-only bindings on the session row", () => {
    expect(resolveTurnSquad({ session: { squadId: "  " } })).toEqual({
      squadId: null,
      source: "none",
    })
  })
})

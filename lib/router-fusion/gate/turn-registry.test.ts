import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  __resetFusionTurnsForTesting,
  clearFusionTurn,
  fusionTurnBypassOf,
  fusionTurnOf,
  fusionTurnSessions,
  markFusionTurn,
  noteFusionTurnBypass,
} from "./turn-registry"

describe("fusion turn registry", () => {
  afterEach(() => __resetFusionTurnsForTesting())

  it("tracks a session's ledgered turn until it ends", () => {
    expect(fusionTurnOf("s1")).toBeUndefined()
    markFusionTurn("s1", "run-1")
    markFusionTurn("s2", "run-2")
    expect(fusionTurnOf("s1")).toBe("run-1")
    expect(fusionTurnSessions()).toEqual(["s1", "s2"])
    clearFusionTurn("s1")
    expect(fusionTurnOf("s1")).toBeUndefined()
    expect(fusionTurnSessions()).toEqual(["s2"])
  })

  it("keeps the first bypass notice of a turn and forgets it with the turn", () => {
    noteFusionTurnBypass("s1", { code: "db_unavailable", justTripped: false })
    expect(fusionTurnBypassOf("s1")).toBeNull()
    markFusionTurn("s1", "run-1")
    noteFusionTurnBypass("s1", { code: "sidecar_unanswered", justTripped: false })
    noteFusionTurnBypass("s1", { code: "db_transaction", justTripped: true })
    expect(fusionTurnBypassOf("s1")).toEqual({ code: "sidecar_unanswered", justTripped: false })
    markFusionTurn("s1", "run-2")
    expect(fusionTurnBypassOf("s1")).toBeNull()
  })

  it("has no imports, so the shared event handler can load it on the off path", () => {
    const source = readFileSync(join(__dirname, "turn-registry.ts"), "utf8")
    expect(source).not.toMatch(/^\s*import\s/m)
  })
})

/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

import { createInitialState, emptyInputState } from "./initial"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

describe("createInitialState", () => {
  it("builds an idle, empty state for the session", () => {
    const s = createInitialState(config, "ses1")
    expect(s.sessionId).toBe("ses1")
    expect(s.config).toBe(config)
    expect(s.cells).toEqual([])
    expect(s.inflight).toEqual({ text: "", thinking: "" })
    expect(s.overlay).toEqual({ kind: "none" })
    expect(s.turnStatus).toBe("idle")
    expect(s.exit).toBe(false)
    expect(s.seq).toBe(0)
  })
})

describe("emptyInputState", () => {
  it("starts with a single empty line and no history", () => {
    const input = emptyInputState()
    expect(input.buffer).toEqual({ lines: [""], cursorRow: 0, cursorCol: 0 })
    expect(input.history).toEqual({ entries: [], index: -1, draft: "" })
    expect(input.pastes).toEqual({})
  })
})

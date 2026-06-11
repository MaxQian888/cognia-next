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

  it("defaults to the chat phase (trusted)", () => {
    expect(createInitialState(config, "ses1").phase).toBe("chat")
  })

  it("starts in the startup phase when the folder is untrusted", () => {
    expect(createInitialState(config, "ses1", false).phase).toBe("startup")
  })

  it("seeds the composer history from the persisted entries", () => {
    const s = createInitialState(config, "ses1", true, ["one", "two"])
    expect(s.input.history).toEqual({ entries: ["one", "two"], index: -1, draft: "" })
  })

  it("defaults to an empty history when none is provided", () => {
    expect(createInitialState(config, "ses1").input.history.entries).toEqual([])
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

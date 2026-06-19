/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

import { createInitialState } from "./initial"
import {
  canSubmit,
  hasInflight,
  hasOverlay,
  isBusy,
  lastAssistantText,
  lastUserText,
  nthAssistantText,
} from "./selectors"
import type { Cell } from "./types"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }
const base = () => createInitialState(config, "ses1")

describe("selectors", () => {
  it("isBusy reflects a non-idle turn", () => {
    expect(isBusy(base())).toBe(false)
    expect(isBusy({ ...base(), turnStatus: "streaming" })).toBe(true)
  })

  it("hasOverlay reflects an open modal", () => {
    expect(hasOverlay(base())).toBe(false)
    expect(hasOverlay({ ...base(), overlay: { kind: "help" } })).toBe(true)
  })

  it("canSubmit requires idle and no overlay", () => {
    expect(canSubmit(base())).toBe(true)
    expect(canSubmit({ ...base(), turnStatus: "streaming" })).toBe(false)
    expect(canSubmit({ ...base(), overlay: { kind: "help" } })).toBe(false)
  })

  it("hasInflight reflects pending text or reasoning", () => {
    expect(hasInflight(base())).toBe(false)
    expect(hasInflight({ ...base(), inflight: { text: "x", thinking: "", tools: [] } })).toBe(true)
    expect(hasInflight({ ...base(), inflight: { text: "", thinking: "y", tools: [] } })).toBe(true)
  })

  it("lastUserText / lastAssistantText find the most recent cell of each kind", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "first" },
      { id: "2", kind: "assistant", raw: "reply one" },
      { id: "3", kind: "user", text: "second" },
      { id: "4", kind: "assistant", raw: "reply two" },
    ]
    const s = { ...base(), cells }
    expect(lastUserText(s)).toBe("second")
    expect(lastAssistantText(s)).toBe("reply two")
  })

  it("lastUserText / lastAssistantText return null when absent", () => {
    expect(lastUserText(base())).toBeNull()
    expect(lastAssistantText(base())).toBeNull()
  })

  it("nthAssistantText walks back N assistant replies", () => {
    const cells: Cell[] = [
      { id: "1", kind: "assistant", raw: "reply one" },
      { id: "2", kind: "user", text: "q" },
      { id: "3", kind: "assistant", raw: "reply two" },
      { id: "4", kind: "assistant", raw: "reply three" },
    ]
    const s = { ...base(), cells }
    expect(nthAssistantText(s, 1)).toBe("reply three")
    expect(nthAssistantText(s, 2)).toBe("reply two")
    expect(nthAssistantText(s, 3)).toBe("reply one")
    expect(nthAssistantText(s, 4)).toBeNull()
  })

  it("nthAssistantText rejects non-positive / non-integer indices", () => {
    const s = { ...base(), cells: [{ id: "1", kind: "assistant", raw: "x" }] as Cell[] }
    expect(nthAssistantText(s, 0)).toBeNull()
    expect(nthAssistantText(s, -1)).toBeNull()
    expect(nthAssistantText(s, 1.5)).toBeNull()
  })
})

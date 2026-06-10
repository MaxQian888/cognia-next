/**
 * @jest-environment node
 */
import { historyDown, historyUp, inHistory } from "./history"
import type { HistoryState } from "../state/types"

const h = (entries: string[], index = -1, draft = ""): HistoryState => ({ entries, index, draft })

describe("historyUp", () => {
  it("stashes the draft and jumps to the newest entry", () => {
    const r = historyUp(h(["a", "b"]), "typing")
    expect(r).toEqual({ history: { entries: ["a", "b"], index: 1, draft: "typing" }, text: "b" })
  })
  it("steps to older entries", () => {
    const r = historyUp(h(["a", "b"], 1, "d"), "ignored")
    expect(r).toEqual({ history: { entries: ["a", "b"], index: 0, draft: "d" }, text: "a" })
  })
  it("stops at the oldest entry", () => {
    const start = h(["a", "b"], 0, "d")
    expect(historyUp(start, "x")).toEqual({ history: start, text: "a" })
  })
  it("no-ops with no history", () => {
    expect(historyUp(h([]), "keep")).toEqual({ history: h([]), text: "keep" })
  })
})

describe("historyDown", () => {
  it("steps to newer entries", () => {
    expect(historyDown(h(["a", "b"], 0, "d"))).toEqual({
      history: { entries: ["a", "b"], index: 1, draft: "d" },
      text: "b",
    })
  })
  it("restores the draft past the newest entry", () => {
    expect(historyDown(h(["a", "b"], 1, "draft"))).toEqual({
      history: { entries: ["a", "b"], index: -1, draft: "" },
      text: "draft",
    })
  })
  it("returns the draft when already editing it", () => {
    expect(historyDown(h(["a"], -1, "live"))).toEqual({
      history: h(["a"], -1, "live"),
      text: "live",
    })
  })
})

describe("inHistory", () => {
  it("reflects whether navigation is active", () => {
    expect(inHistory(h(["a"], -1))).toBe(false)
    expect(inHistory(h(["a"], 0))).toBe(true)
  })
})

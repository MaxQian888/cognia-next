import {
  isIMQuickCommand,
  isLegacyEventKeyRow,
  normalizeQuickCommand,
  normalizeQuickCommandList,
} from "./types"

describe("normalizeQuickCommand", () => {
  it("passes through a canonical IMQuickCommand row", () => {
    const row = {
      triggerKey: "menu.x",
      label: "X",
      action: { type: "prompt" as const, value: "do x" },
    }
    expect(normalizeQuickCommand(row)).toEqual(row)
  })

  it("upgrades a legacy eventKey row to triggerKey", () => {
    const legacy = {
      eventKey: "menu.legacy",
      action: { type: "slash" as const, value: "/legacy" },
    }
    expect(normalizeQuickCommand(legacy)).toEqual({
      triggerKey: "menu.legacy",
      label: undefined,
      action: { type: "slash", value: "/legacy" },
    })
  })

  it("preserves the label on legacy rows", () => {
    const legacy = {
      eventKey: "menu.legacy",
      label: "L",
      action: { type: "prompt" as const, value: "v" },
    }
    expect(normalizeQuickCommand(legacy)?.label).toBe("L")
  })

  it("returns null for malformed rows", () => {
    expect(normalizeQuickCommand(null)).toBeNull()
    expect(normalizeQuickCommand({})).toBeNull()
    expect(normalizeQuickCommand({ triggerKey: 1 })).toBeNull()
    expect(normalizeQuickCommand({ triggerKey: "x" })).toBeNull()
    expect(
      normalizeQuickCommand({
        triggerKey: "x",
        action: { type: "bogus", value: "v" },
      })
    ).toBeNull()
    expect(normalizeQuickCommand({ eventKey: "x" })).toBeNull()
  })

  it("does NOT treat a row carrying both fields as legacy", () => {
    const both = {
      triggerKey: "new",
      eventKey: "old",
      action: { type: "prompt" as const, value: "v" },
    }
    const out = normalizeQuickCommand(both)
    expect(out?.triggerKey).toBe("new")
  })
})

describe("isLegacyEventKeyRow / isIMQuickCommand", () => {
  it("legacy detector is true only when triggerKey is absent", () => {
    expect(isLegacyEventKeyRow({ eventKey: "x", action: { type: "prompt", value: "" } })).toBe(true)
    expect(
      isLegacyEventKeyRow({
        eventKey: "x",
        triggerKey: "x",
        action: { type: "prompt", value: "" },
      })
    ).toBe(false)
    expect(isLegacyEventKeyRow({})).toBe(false)
  })

  it("canonical detector validates action shape", () => {
    expect(
      isIMQuickCommand({
        triggerKey: "x",
        action: { type: "prompt", value: "v" },
      })
    ).toBe(true)
    expect(isIMQuickCommand({ triggerKey: "x" })).toBe(false)
    expect(isIMQuickCommand({ triggerKey: "x", action: { type: "prompt" } })).toBe(false)
  })
})

describe("normalizeQuickCommandList", () => {
  it("drops malformed entries while keeping valid ones", () => {
    const out = normalizeQuickCommandList([
      { triggerKey: "a", action: { type: "prompt", value: "v" } },
      { eventKey: "b", action: { type: "slash", value: "/b" } },
      null,
      "bogus",
      { triggerKey: "c" },
    ])
    expect(out.map((c) => c.triggerKey)).toEqual(["a", "b"])
  })

  it("returns an empty list for non-array input", () => {
    expect(normalizeQuickCommandList(undefined)).toEqual([])
    expect(normalizeQuickCommandList("oops")).toEqual([])
  })
})

import {
  emptyCustomSource,
  isCustomSourceComplete,
  newCustomSourceId,
  normalizeCustomSource,
  removeCustomSource,
  upsertCustomSource,
} from "./store"

import type { CustomLimitsSource } from "@/types/subscription"

function src(over: Partial<CustomLimitsSource> = {}): CustomLimitsSource {
  return {
    id: "a",
    name: "My Relay",
    baseUrl: "https://relay.example.com/v1",
    token: "tok",
    request: { path: "/balance" },
    extract: { kind: "balance", remainingPath: "data.balance", unit: "USD" },
    ...over,
  }
}

describe("newCustomSourceId / emptyCustomSource", () => {
  it("derives a stable id and a blank balance source", () => {
    expect(newCustomSourceId(5)).toMatch(/^cls-/)
    const empty = emptyCustomSource("x")
    expect(empty).toMatchObject({ id: "x", name: "", extract: { kind: "balance" } })
  })
})

describe("normalizeCustomSource", () => {
  it("trims fields and strips trailing slashes from baseUrl", () => {
    const n = normalizeCustomSource(
      src({ name: " R ", baseUrl: "https://x.com/v1///", token: " t ", request: { path: " /b " } })
    )
    expect(n).toMatchObject({ name: "R", baseUrl: "https://x.com/v1", token: "t" })
    expect(n.request.path).toBe("/b")
  })

  it("deep-copies window specs", () => {
    const original = src({
      extract: {
        kind: "window",
        windows: [{ id: "s", labelKey: "k", usedPctPath: "p" }],
      },
    })
    const n = normalizeCustomSource(original)
    expect(n.extract).not.toBe(original.extract)
    if (n.extract.kind === "window") expect(n.extract.windows[0]).not.toBe(original.extract)
  })
})

describe("isCustomSourceComplete", () => {
  it("requires name, baseUrl, token, path, and an extract field", () => {
    expect(isCustomSourceComplete(src())).toBe(true)
    expect(isCustomSourceComplete(src({ name: "" }))).toBe(false)
    expect(isCustomSourceComplete(src({ token: "  " }))).toBe(false)
    expect(isCustomSourceComplete(src({ request: { path: "" } }))).toBe(false)
    expect(isCustomSourceComplete(src({ extract: { kind: "balance", remainingPath: "" } }))).toBe(
      false
    )
  })

  it("validates window sources need at least one window with a usedPctPath", () => {
    expect(isCustomSourceComplete(src({ extract: { kind: "window", windows: [] } }))).toBe(false)
    expect(
      isCustomSourceComplete(
        src({ extract: { kind: "window", windows: [{ id: "s", labelKey: "k", usedPctPath: "" }] } })
      )
    ).toBe(false)
    expect(
      isCustomSourceComplete(
        src({
          extract: { kind: "window", windows: [{ id: "s", labelKey: "k", usedPctPath: "p" }] },
        })
      )
    ).toBe(true)
  })
})

describe("upsert / remove", () => {
  it("appends a new source and replaces an existing one by id", () => {
    const list = [src({ id: "a" })]
    const added = upsertCustomSource(list, src({ id: "b", name: "B" }))
    expect(added.map((s) => s.id)).toEqual(["a", "b"])
    const replaced = upsertCustomSource(added, src({ id: "a", name: "A2" }))
    expect(replaced.find((s) => s.id === "a")?.name).toBe("A2")
    expect(replaced).toHaveLength(2)
  })

  it("removes by id without mutating the input", () => {
    const list = [src({ id: "a" }), src({ id: "b" })]
    const next = removeCustomSource(list, "a")
    expect(next.map((s) => s.id)).toEqual(["b"])
    expect(list).toHaveLength(2)
  })
})

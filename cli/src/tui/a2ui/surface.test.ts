/** @jest-environment node */
import { validateA2UISurface } from "./surface"

const node = (id: string, component = "Text", extra: Record<string, unknown> = {}) => ({
  id,
  component,
  text: id,
  ...extra,
})

describe("validateA2UISurface", () => {
  it("normalizes array and record component payloads", () => {
    const array = validateA2UISurface("s1", {
      rootId: "root",
      components: [node("root", "Column", { children: ["child"] }), node("child")],
      dataModel: { name: "Ada" },
    })
    expect(array).toMatchObject({ ok: true, surface: { surfaceId: "s1", rootId: "root" } })
    if (array.ok) expect(Object.keys(array.surface.components)).toEqual(["root", "child"])

    const record = validateA2UISurface("s2", {
      rootId: "root",
      components: { root: node("root") },
    })
    expect(record.ok).toBe(true)
  })

  it("rejects more than 500 nodes", () => {
    const components = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [`n${index}`, node(`n${index}`)])
    )
    expect(validateA2UISurface("s", { rootId: "n0", components })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("500"),
    })
  })

  it("rejects depth over 32 and reference cycles", () => {
    const components = Object.fromEntries(
      Array.from({ length: 34 }, (_, index) => [
        `n${index}`,
        node(`n${index}`, "Column", { children: index < 33 ? [`n${index + 1}`] : [] }),
      ])
    )
    expect(validateA2UISurface("deep", { rootId: "n0", components })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("depth"),
    })
    expect(
      validateA2UISurface("cycle", {
        rootId: "a",
        components: {
          a: node("a", "Column", { children: ["b"] }),
          b: node("b", "Column", { children: ["a"] }),
        },
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining("cycle") })
  })

  it("rejects serialized payloads over 1 MiB and malformed roots", () => {
    expect(
      validateA2UISurface("large", {
        rootId: "root",
        components: { root: node("root", "Text", { text: "x".repeat(1024 * 1024) }) },
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining("MiB") })
    expect(validateA2UISurface("bad", { components: [] })).toMatchObject({ ok: false })
  })
})

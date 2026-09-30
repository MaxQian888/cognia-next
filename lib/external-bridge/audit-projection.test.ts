import { auditProjection, MAX_PROJECTION_FIELDS, MAX_PROJECTION_STRING } from "./audit-projection"

describe("auditProjection", () => {
  it("records nothing when the tool declares no projection", () => {
    expect(auditProjection(undefined)).toBeUndefined()
  })

  it("keeps bounded scalars and drops structured values instead of stringifying", () => {
    expect(
      auditProjection(() => ({
        root: "root-1",
        path: "a.ts",
        n: 3,
        flag: true,
        nan: Number.NaN,
        nested: { secret: "x" },
        list: ["y"],
        nothing: undefined,
      }))
    ).toEqual({ root: "root-1", path: "a.ts", n: 3, flag: true })
  })

  it("caps field count and string length", () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`f${i}`, "v".repeat(500)])
    )
    const out = auditProjection(() => many)!
    expect(Object.keys(out)).toHaveLength(MAX_PROJECTION_FIELDS)
    expect(String(out.f0)).toHaveLength(MAX_PROJECTION_STRING)
  })

  it("treats a throwing or empty projection as unprojectable", () => {
    expect(
      auditProjection(() => {
        throw new Error("bad")
      })
    ).toBeUndefined()
    expect(auditProjection(() => ({}))).toBeUndefined()
    expect(auditProjection(() => [] as unknown as Record<string, unknown>)).toBeUndefined()
  })
})

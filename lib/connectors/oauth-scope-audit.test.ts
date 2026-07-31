import { diffScopes, parseScopeString, recordGrantedScopes } from "./oauth-scope-audit"

const appendMock = jest.fn<Promise<never>, unknown[]>(async () => ({}) as never)
jest.mock("@/lib/db/connector-audit", () => ({
  append: (...args: unknown[]) => appendMock(...args),
}))

beforeEach(() => {
  appendMock.mockClear()
})

describe("parseScopeString", () => {
  it("returns an empty array for empty/nullish input", () => {
    expect(parseScopeString(undefined)).toEqual([])
    expect(parseScopeString(null)).toEqual([])
    expect(parseScopeString("")).toEqual([])
    expect(parseScopeString("   ")).toEqual([])
  })

  it("splits on spaces and commas, trims, de-dupes and sorts", () => {
    expect(parseScopeString("chat:write, channels:read chat:write")).toEqual([
      "channels:read",
      "chat:write",
    ])
  })
})

describe("diffScopes", () => {
  it("reports added and removed entries", () => {
    expect(diffScopes(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] })
  })

  it("is empty when unchanged", () => {
    expect(diffScopes(["a", "b"], ["a", "b"])).toEqual({ added: [], removed: [] })
  })
})

describe("recordGrantedScopes", () => {
  it("stores the first grant without an audit row", async () => {
    const res = await recordGrantedScopes({ adapterId: "x", raw: "b a", now: 100 })
    expect(res.connectedScopes).toEqual({ scopes: ["a", "b"], grantedAtMs: 100 })
    expect(res.changed).toBe(false)
    expect(appendMock).not.toHaveBeenCalled()
  })

  it("does not audit a re-auth with an unchanged scope set", async () => {
    const res = await recordGrantedScopes({
      adapterId: "x",
      raw: "a b",
      previous: { scopes: ["a", "b"], grantedAtMs: 1 },
      now: 200,
    })
    expect(res.changed).toBe(false)
    expect(appendMock).not.toHaveBeenCalled()
    // grant time still refreshes.
    expect(res.connectedScopes.grantedAtMs).toBe(200)
  })

  it("audits a re-auth that gains a scope", async () => {
    const res = await recordGrantedScopes({
      adapterId: "adp1",
      raw: "a b c",
      previous: { scopes: ["a", "b"], grantedAtMs: 1 },
      now: 300,
    })
    expect(res.changed).toBe(true)
    expect(res.added).toEqual(["c"])
    expect(res.removed).toEqual([])
    expect(appendMock).toHaveBeenCalledWith({
      adapterId: "adp1",
      kind: "oauth.scope_changed",
      at: 300,
      fields: { added: ["c"], removed: [], scopes: ["a", "b", "c"] },
    })
  })

  it("audits a re-auth that drops a scope", async () => {
    const res = await recordGrantedScopes({
      adapterId: "adp1",
      raw: "a",
      previous: { scopes: ["a", "b"], grantedAtMs: 1 },
      now: 400,
    })
    expect(res.changed).toBe(true)
    expect(res.removed).toEqual(["b"])
    expect(appendMock).toHaveBeenCalledTimes(1)
  })
})

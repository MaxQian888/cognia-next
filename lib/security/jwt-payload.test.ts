import {
  MalformedJwtError,
  decodeJwtPayload,
  requireJwtPayload,
  stringClaim,
  stringListClaim,
} from "./jwt-payload"

function jwt(payload: unknown, { segments = 3 }: { segments?: number } = {}): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  const parts = ["header", encode(payload), "signature"]
  return parts.slice(0, segments).join(".")
}

describe("decodeJwtPayload", () => {
  it("reads a base64url payload, padding included", () => {
    expect(decodeJwtPayload(jwt({ sub: "usr_1", organization_id: "org_9" }))).toEqual({
      sub: "usr_1",
      organization_id: "org_9",
    })
  })

  it("survives payloads whose base64url needs every padding length", () => {
    for (const sub of ["a", "ab", "abc", "abcd", "abcde"]) {
      expect(decodeJwtPayload(jwt({ sub }))).toEqual({ sub })
    }
  })

  it("returns null rather than throwing for anything malformed", () => {
    expect(decodeJwtPayload("")).toBeNull()
    expect(decodeJwtPayload("not-a-jwt")).toBeNull()
    expect(decodeJwtPayload(jwt({ sub: "x" }, { segments: 2 }))).toBeNull()
    expect(decodeJwtPayload("a..c")).toBeNull()
    expect(decodeJwtPayload("a.!!!not-base64!!!.c")).toBeNull()
  })

  it("rejects payloads that decode to something other than an object", () => {
    expect(decodeJwtPayload(jwt("a string"))).toBeNull()
    expect(decodeJwtPayload(jwt(42))).toBeNull()
    expect(decodeJwtPayload(jwt(null))).toBeNull()
    // An array is an object to `typeof`, and would silently pass a claim read.
    expect(decodeJwtPayload(jwt(["a"]))).toBeNull()
  })
})

describe("requireJwtPayload", () => {
  it("returns the payload when it is readable", () => {
    expect(requireJwtPayload(jwt({ jti: "abc" }))).toEqual({ jti: "abc" })
  })

  it("throws a named error carrying the caller's message", () => {
    expect(() => requireJwtPayload("nope", "access token is malformed")).toThrow(MalformedJwtError)
    expect(() => requireJwtPayload("nope", "access token is malformed")).toThrow(
      "access token is malformed"
    )
  })
})

describe("claim readers", () => {
  it("treats a missing, empty or non-string claim as absent", () => {
    const payload = { sub: "usr_1", empty: "", numeric: 7 }
    expect(stringClaim(payload, "sub")).toBe("usr_1")
    expect(stringClaim(payload, "empty")).toBeUndefined()
    expect(stringClaim(payload, "numeric")).toBeUndefined()
    expect(stringClaim(payload, "absent")).toBeUndefined()
    expect(stringClaim(null, "sub")).toBeUndefined()
  })

  it("accepts both shapes OIDC uses for list claims", () => {
    expect(
      stringListClaim({ organization_roles: ["admin", "member"] }, "organization_roles")
    ).toEqual(["admin", "member"])
    expect(stringListClaim({ scope: "openid offline_access" }, "scope")).toEqual([
      "openid",
      "offline_access",
    ])
    expect(stringListClaim({ mixed: ["ok", 3, null] }, "mixed")).toEqual(["ok"])
    expect(stringListClaim({}, "absent")).toEqual([])
    expect(stringListClaim(null, "absent")).toEqual([])
  })
})

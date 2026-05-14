import { createKeyringSecretResolver, parseRef } from "./secret-resolver-keyring"

jest.mock("@/lib/keyring", () => ({
  __esModule: true,
  getSecret: jest.fn(async (ref: { namespace: string; key: string }) =>
    ref.namespace === "test" && ref.key === "match" ? "secret-value" : null
  ),
}))

describe("parseRef", () => {
  it("accepts the explicit `keyring:<ns>:<key>` form", () => {
    expect(parseRef("keyring:github-delivery:pat:owner/repo")).toEqual({
      namespace: "github-delivery",
      key: "pat:owner/repo",
    })
  })

  it("accepts the `<ns>/<key>` shorthand for plugin secrets", () => {
    expect(parseRef("github-delivery/repo-token")).toEqual({
      namespace: "github-delivery",
      key: "repo-token",
    })
  })

  it("rejects empty / malformed inputs", () => {
    expect(parseRef("")).toBeNull()
    expect(parseRef("keyring:onlypart")).toBeNull()
    expect(parseRef("/key-with-no-namespace")).toBeNull()
    expect(parseRef("ns/")).toBeNull()
    // URLs shouldn't be misread as plugin shorthand.
    expect(parseRef("https://example.com/path")).toBeNull()
  })
})

describe("createKeyringSecretResolver", () => {
  it("resolves a matching ref via lib/keyring", async () => {
    const resolver = createKeyringSecretResolver()
    await expect(resolver.resolve("keyring:test:match")).resolves.toBe("secret-value")
  })

  it("returns undefined when keyring has no entry", async () => {
    const resolver = createKeyringSecretResolver()
    await expect(resolver.resolve("keyring:test:missing")).resolves.toBeUndefined()
  })

  it("returns undefined for refs that don't parse", async () => {
    const resolver = createKeyringSecretResolver()
    await expect(resolver.resolve("garbage")).resolves.toBeUndefined()
  })
})

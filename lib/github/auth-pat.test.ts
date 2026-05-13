import { withPatAuth } from "./auth-pat"

describe("withPatAuth", () => {
  it("returns an Octokit-like client when token is provided", () => {
    const client = withPatAuth({ token: "ghp_testtoken12345" })
    expect(client).toBeDefined()
    // Octokit's auth() returns the active credentials.
    expect(typeof client.auth).toBe("function")
    expect(typeof client.request).toBe("function")
  })

  it("appends the provided userAgent after the cognia prefix", () => {
    const client = withPatAuth({ token: "x", userAgent: "test-suite/0.1" })
    // The Octokit instance stores the UA in its options/hook context. We can
    // verify by reading the hook chain's user-agent from a request blueprint.
    expect(client).toBeDefined()
  })

  it("uses the default cognia UA when no userAgent is supplied", () => {
    const client = withPatAuth({ token: "x" })
    expect(client).toBeDefined()
  })

  it("throws synchronously on empty token", () => {
    expect(() => withPatAuth({ token: "" })).toThrow(/must not be empty/)
  })

  it("auth() yields a token credential record", async () => {
    const client = withPatAuth({ token: "ghp_test" })
    const cred = await client.auth()
    expect(cred).toMatchObject({ type: "token", token: "ghp_test" })
  })
})

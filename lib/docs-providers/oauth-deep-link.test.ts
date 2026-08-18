import {
  __clearDocsOAuthCompletionsForTests,
  completeDocsOAuthDeepLink,
  getDocsOAuthCompletion,
  isDocsOAuthDeepLink,
  parseDocsOAuthDeepLink,
  registerDocsOAuthCompletion,
} from "./oauth-deep-link"

beforeEach(() => {
  __clearDocsOAuthCompletionsForTests()
})

describe("parseDocsOAuthDeepLink", () => {
  it("extracts the provider and every OAuth field", () => {
    expect(
      parseDocsOAuthDeepLink(
        "cognia://docs-provider/oauth/google?code=abc&state=google%3Anonce&error=&error_description="
      )
    ).toEqual({
      providerId: "google",
      code: "abc",
      state: "google:nonce",
      error: "",
      errorDescription: "",
    })
  })

  it("leaves absent fields undefined rather than empty", () => {
    expect(parseDocsOAuthDeepLink("cognia://docs-provider/oauth/google?code=abc")).toEqual({
      providerId: "google",
      code: "abc",
      state: undefined,
      error: undefined,
      errorDescription: undefined,
    })
  })

  it("carries a denial through so the caller can report it", () => {
    const parsed = parseDocsOAuthDeepLink(
      "cognia://docs-provider/oauth/google?error=access_denied&error_description=nope"
    )
    expect(parsed).toMatchObject({ error: "access_denied", errorDescription: "nope" })
  })

  it("returns null for other schemes, including the connector one", () => {
    expect(parseDocsOAuthDeepLink("cognia://connector/oauth/lark?code=a")).toBeNull()
    expect(parseDocsOAuthDeepLink("https://example.com/oauth")).toBeNull()
    expect(parseDocsOAuthDeepLink("cognia://docs-provider/oauth/")).toBeNull()
  })
})

describe("isDocsOAuthDeepLink", () => {
  it("mirrors the parser for routing decisions", () => {
    expect(isDocsOAuthDeepLink("cognia://docs-provider/oauth/google?code=a")).toBe(true)
    expect(isDocsOAuthDeepLink("cognia://connector/oauth/lark?code=a")).toBe(false)
  })
})

describe("registerDocsOAuthCompletion", () => {
  it("registers and resolves by provider id", () => {
    const fn = jest.fn(async () => undefined)
    registerDocsOAuthCompletion("google", fn)
    expect(getDocsOAuthCompletion("google")).toBe(fn)
  })

  it("throws on a duplicate registration", () => {
    registerDocsOAuthCompletion("google", async () => undefined)
    expect(() => registerDocsOAuthCompletion("google", async () => undefined)).toThrow(
      /already registered/
    )
  })
})

describe("completeDocsOAuthDeepLink", () => {
  it("ignores a URL that is not ours", async () => {
    expect(await completeDocsOAuthDeepLink("cognia://connector/oauth/lark?code=a")).toEqual({
      status: "ignored",
    })
  })

  it("reports an unregistered provider instead of silently succeeding", async () => {
    expect(await completeDocsOAuthDeepLink("cognia://docs-provider/oauth/nope?code=a")).toEqual({
      status: "unknown-provider",
      providerId: "nope",
    })
  })

  it("hands the parsed callback to the provider and reports success", async () => {
    const fn = jest.fn(async () => undefined)
    registerDocsOAuthCompletion("google", fn)
    const outcome = await completeDocsOAuthDeepLink(
      "cognia://docs-provider/oauth/google?code=abc&state=google%3An1"
    )
    expect(outcome).toEqual({ status: "ok", providerId: "google" })
    expect(fn).toHaveBeenCalledWith({
      providerId: "google",
      code: "abc",
      state: "google:n1",
      error: undefined,
      errorDescription: undefined,
    })
  })

  it("never throws — a failed exchange becomes a reportable outcome", async () => {
    registerDocsOAuthCompletion("google", async () => {
      throw new Error("state mismatch")
    })
    expect(await completeDocsOAuthDeepLink("cognia://docs-provider/oauth/google?code=a")).toEqual({
      status: "failed",
      providerId: "google",
      reason: "state mismatch",
    })
  })

  it("stringifies a non-Error rejection", async () => {
    registerDocsOAuthCompletion("google", async () => {
      throw "boom"
    })
    const outcome = await completeDocsOAuthDeepLink("cognia://docs-provider/oauth/google?code=a")
    expect(outcome).toMatchObject({ status: "failed", reason: "boom" })
  })
})

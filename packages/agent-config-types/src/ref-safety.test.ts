import { absolutePathViolation, isNonEmptyString, refViolation } from "./ref-safety"

describe("isNonEmptyString", () => {
  it("accepts a non-empty string", () => {
    expect(isNonEmptyString("x")).toBe(true)
  })

  it.each([
    ["", "empty string"],
    [undefined, "undefined"],
    [null, "null"],
    [0, "zero"],
    [{}, "object"],
  ])("rejects %p (%s)", (value, _label) => {
    expect(isNonEmptyString(value)).toBe(false)
  })
})

describe("refViolation", () => {
  it.each([
    ["sk-abc123", "OpenAI-style secret"],
    ["my_api_key", "api_key"],
    ["my-api-key", "api-key"],
    ["apikey-thing", "apikey"],
    ["bearer eyJhbGc", "bearer prefix"],
    ["token=abc", "token assignment"],
    ["token:abc", "token colon"],
  ])("flags %p as secret-shaped (%s)", (value) => {
    expect(refViolation(value)).toBe("secret-shaped value in a ref position")
  })

  it.each([
    ["https://example.com", "https"],
    ["http://example.com", "http"],
    ["postgres://host/db", "custom scheme"],
    ["s3+v4://bucket/key", "scheme with + and ."],
  ])("flags %p as URL-shaped (%s)", (value) => {
    expect(refViolation(value)).toBe("URL-shaped value in a ref position")
  })

  it("checks secret shape before URL shape", () => {
    // A URL that also carries a token must report the secret, which is the
    // more serious finding and the one that must reach the operator.
    expect(refViolation("https://h/x?token=abc")).toBe("secret-shaped value in a ref position")
  })

  it.each([
    ["workspace-main", "plain logical ref"],
    ["team/project", "slash-separated ref"],
    ["broken-token", "the word token without an assignment"],
    ["relative/path/file.ts", "relative path"],
    ["not-a-scheme:/single-slash", "single slash is not a URL"],
  ])("accepts %p (%s)", (value) => {
    expect(refViolation(value)).toBeNull()
  })
})

describe("absolutePathViolation", () => {
  it.each([
    ["/srv/data", "POSIX absolute"],
    ["/", "POSIX root"],
    ["C:\\Users\\me", "Windows backslash"],
    ["C:/Users/me", "Windows forward slash"],
    ["d:/lower-case-drive", "lower-case drive letter"],
  ])("flags %p (%s)", (value) => {
    expect(absolutePathViolation(value)).toBe("machine-local absolute path is not a stable ref")
  })

  it.each([
    ["relative/path", "relative path"],
    ["./relative", "explicitly relative"],
    ["workspace-main", "logical ref"],
    ["CC:/not-a-drive", "two-letter prefix is not a drive"],
    ["", "empty string"],
  ])("accepts %p (%s)", (value) => {
    expect(absolutePathViolation(value)).toBeNull()
  })
})

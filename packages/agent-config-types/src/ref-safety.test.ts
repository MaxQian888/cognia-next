import {
  absolutePathViolation,
  hasOnlyKeys,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  refViolation,
} from "./ref-safety"

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
    // `sk-` must be boundary-guarded: unanchored it fires on any id that
    // merely contains those letters, rejecting ordinary refs as credentials.
    ["task-1", "an id ending in a word that contains sk-"],
    ["agent-task-42", "an agent task id"],
    ["risk-report", "risk-"],
    ["disk-cache", "disk-"],
  ])("accepts %p (%s)", (value) => {
    expect(refViolation(value)).toBeNull()
  })

  it.each([
    ["sk-abc123", "at the start of the value"],
    ["prefix/sk-abc123", "after a separator"],
    ["OPENAI_sk-abc123", "after an underscore"],
  ])("still flags a real sk- key %p (%s)", (value) => {
    expect(refViolation(value)).toBe("secret-shaped value in a ref position")
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

describe("isRecord", () => {
  it("accepts a plain object", () => {
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it.each([
    [null, "null"],
    [[], "array"],
    ["x", "string"],
    [1, "number"],
    [undefined, "undefined"],
  ])("rejects %p (%s)", (value) => {
    expect(isRecord(value)).toBe(false)
  })
})

describe("hasOnlyKeys", () => {
  it("accepts a subset of the allowed keys", () => {
    expect(hasOnlyKeys({ a: 1 }, ["a", "b"])).toBe(true)
  })

  it("accepts an empty object", () => {
    expect(hasOnlyKeys({}, ["a"])).toBe(true)
  })

  it("rejects an undeclared key", () => {
    expect(hasOnlyKeys({ a: 1, rogue: 2 }, ["a"])).toBe(false)
  })

  it("rejects a key whose value is undefined", () => {
    // Presence, not value, is what closes the schema — an explicit
    // `{ rogue: undefined }` still means the peer sent a field we do not know.
    expect(hasOnlyKeys({ rogue: undefined }, ["a"])).toBe(false)
  })
})

describe("isNonNegativeInteger", () => {
  it.each([
    [0, "zero"],
    [1, "one"],
    [Number.MAX_SAFE_INTEGER, "max safe integer"],
  ])("accepts %p (%s)", (value) => {
    expect(isNonNegativeInteger(value)).toBe(true)
  })

  it.each([
    [-1, "negative"],
    [1.5, "fractional"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "infinity"],
    [Number.MAX_SAFE_INTEGER + 1, "beyond safe integer range"],
    ["1", "numeric string"],
    [null, "null"],
  ])("rejects %p (%s)", (value) => {
    expect(isNonNegativeInteger(value)).toBe(false)
  })
})

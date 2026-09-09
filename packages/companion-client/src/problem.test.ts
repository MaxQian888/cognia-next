import { isProblem, parseProblem, problemRetryAfterMs, PROBLEM_TYPE_BASE } from "./problem"

const DOCUMENT = {
  type: "https://cognia.dev/problems/command_renamed",
  title: "Gone",
  status: 410,
  detail: "session_list is now session.list",
  instance: "/api/_rpc/session_list",
  code: "command_renamed",
  requestId: "req-1",
  retryable: false,
  details: { replacement: "session.list" },
}

describe("isProblem", () => {
  it("accepts the RFC document and refuses the legacy envelopes", () => {
    expect(isProblem(DOCUMENT)).toBe(true)
    expect(isProblem({ error: { code: "x", message: "y" } })).toBe(false)
    expect(isProblem({ code: "x", message: "y" })).toBe(false)
    expect(isProblem(null)).toBe(false)
    expect(isProblem("nope")).toBe(false)
  })
})

describe("parseProblem", () => {
  it("returns the document as written, with details always an object", () => {
    expect(parseProblem(DOCUMENT)).toEqual(DOCUMENT)
    expect(parseProblem({ ...DOCUMENT, details: null })).toMatchObject({ details: {} })
  })

  it("reads the nested envelope an older device plane answered with", () => {
    const problem = parseProblem(
      {
        error: {
          code: "rate_limited",
          message: "slow down",
          requestId: "req-2",
          retryable: true,
          details: { retryAfterSeconds: 3 },
        },
      },
      429
    )
    expect(problem).toEqual({
      type: `${PROBLEM_TYPE_BASE}rate_limited`,
      title: "",
      status: 429,
      detail: "slow down",
      code: "rate_limited",
      requestId: "req-2",
      retryable: true,
      details: { retryAfterSeconds: 3 },
    })
  })

  it("reads the flat envelope an older internal plane answered with", () => {
    expect(parseProblem({ code: "unknown_command", message: "nope" }, 404)).toMatchObject({
      code: "unknown_command",
      detail: "nope",
      status: 404,
      retryable: false,
    })
  })

  it('reads a bare `{ error: "code" }` and takes its sibling message', () => {
    expect(parseProblem({ error: "forbidden", message: "not the owner" }, 403)).toMatchObject({
      code: "forbidden",
      detail: "not the owner",
      status: 403,
    })
  })

  it("guesses retryability from the status only when the Host did not say", () => {
    expect(parseProblem({ code: "boom", message: "x" }, 503)?.retryable).toBe(true)
    expect(parseProblem({ code: "boom", message: "x", retryable: false }, 503)?.retryable).toBe(
      false
    )
  })

  it("answers null for a body with no code, so the caller falls back to the status", () => {
    expect(parseProblem({ hello: 1 })).toBeNull()
    expect(parseProblem({ error: "" })).toBeNull()
    expect(parseProblem(null)).toBeNull()
    expect(parseProblem([1, 2])).toBeNull()
  })
})

describe("problemRetryAfterMs", () => {
  it("turns retryAfterSeconds into milliseconds and ignores junk", () => {
    expect(problemRetryAfterMs({ details: { retryAfterSeconds: 7 } })).toBe(7000)
    expect(problemRetryAfterMs({ details: { retryAfterSeconds: "7" } })).toBeNull()
    expect(problemRetryAfterMs({ details: {} })).toBeNull()
  })
})

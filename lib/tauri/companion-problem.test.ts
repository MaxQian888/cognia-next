import {
  companionErrorInitFromBody,
  companionErrorInitFromProblem,
  isProblem,
  parseProblem,
} from "./companion-problem"

const DOCUMENT = {
  type: "https://cognia.dev/problems/rate_limited",
  title: "Too Many Requests",
  status: 429,
  detail: "device exceeded the remote execution quota",
  code: "rate_limited",
  requestId: "req-1",
  retryable: true,
  details: { retryAfterSeconds: 3 },
}

describe("companionErrorInitFromProblem", () => {
  it("carries code, detail, retryability and the quantified wait", () => {
    expect(companionErrorInitFromProblem(DOCUMENT)).toEqual({
      code: "rate_limited",
      message: "device exceeded the remote execution quota",
      retryable: true,
      retryAfterMs: 3000,
    })
  })

  it("keeps the code as the message when the Host gave no detail", () => {
    expect(companionErrorInitFromProblem({ ...DOCUMENT, detail: "", details: {} })).toEqual({
      code: "rate_limited",
      message: "rate_limited",
      retryable: true,
    })
  })
})

describe("companionErrorInitFromBody", () => {
  it("reads the document and the legacy nested envelope alike", () => {
    expect(companionErrorInitFromBody(DOCUMENT, 429).code).toBe("rate_limited")
    expect(
      companionErrorInitFromBody({ error: { code: "device_revoked", message: "gone" } }, 401)
    ).toEqual({ code: "device_revoked", message: "gone", retryable: false })
  })

  it("falls back to the status when the body carries no code", () => {
    expect(companionErrorInitFromBody(null, 503)).toEqual({
      code: "server_error",
      message: "HTTP 503",
      retryable: true,
    })
    expect(companionErrorInitFromBody({ hello: 1 }, 404)).toEqual({
      code: "http_404",
      message: "HTTP 404",
      retryable: false,
    })
  })
})

describe("re-exports", () => {
  it("exposes the package parser under the app seam", () => {
    expect(isProblem(DOCUMENT)).toBe(true)
    expect(parseProblem(DOCUMENT)?.code).toBe("rate_limited")
  })
})

import { diagnoseParsedError, type ParsedErrorLike } from "./from-parsed-error"

const parsed = (...nodes: ParsedErrorLike["nodes"]): ParsedErrorLike => ({ nodes })

describe("diagnoseParsedError", () => {
  it("lifts a category node straight through — the ids are shared by design", () => {
    expect(
      diagnoseParsedError(parsed({ kind: "category", category: "connectionRefused" }))
    ).toEqual({ code: "connectionRefused" })
  })

  it("carries the HTTP status off a statusCode node", () => {
    expect(
      diagnoseParsedError(parsed({ kind: "statusCode", status: 429, category: "rateLimited" }))
    ).toEqual({ code: "rateLimited", httpStatus: 429 })
  })

  it("keeps a status seen before the category node that resolves the code", () => {
    // Parsers emit nodes in text order, so the status can precede the category.
    expect(
      diagnoseParsedError(
        parsed({ kind: "statusCode", status: 503 }, { kind: "category", category: "serverError" })
      )
    ).toEqual({ code: "serverError", httpStatus: 503 })
  })

  it("returns null when nothing was classifiable, so the caller can try the next classifier", () => {
    // Returning `unknown` here would stop the funnel one step too early.
    expect(diagnoseParsedError(parsed({ kind: "text" }))).toBeNull()
    expect(diagnoseParsedError(parsed())).toBeNull()
  })

  it("returns null for a status with no category rather than inventing a code", () => {
    expect(diagnoseParsedError(parsed({ kind: "statusCode", status: 404 }))).toBeNull()
  })

  it("ignores a category the registry doesn't know", () => {
    // Parsers can gain a category before the registry does; that must not
    // produce a code with no translation behind it.
    expect(diagnoseParsedError(parsed({ kind: "category", category: "brandNewThing" }))).toBeNull()
  })

  it("takes the first recognised category when several are present", () => {
    expect(
      diagnoseParsedError(
        parsed(
          { kind: "category", category: "timeout" },
          { kind: "category", category: "serverError" }
        )
      )
    ).toEqual({ code: "timeout" })
  })

  it("does not treat inherited Object keys as categories", () => {
    expect(diagnoseParsedError(parsed({ kind: "category", category: "constructor" }))).toBeNull()
  })
})

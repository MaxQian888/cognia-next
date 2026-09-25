import { runErrorText } from "./run-error"

const t = (key: string, params?: Record<string, string | number>) =>
  `${key}${params ? JSON.stringify(params) : ""}`

describe("runErrorText", () => {
  it("translates a stored code with its params", () => {
    expect(
      runErrorText({ errorCode: "strixError", errorParams: { exit: 1 }, error: "English" }, t)
    ).toBe('run.error.strixError{"exit":1}')
  })

  it("translates a code with no params", () => {
    expect(runErrorText({ errorCode: "interrupted", error: "English" }, t)).toBe(
      "run.error.interrupted"
    )
  })

  it("falls back to the stored English detail for rows written before codes", () => {
    expect(runErrorText({ error: "Legacy failure" }, t)).toBe("Legacy failure")
  })

  it("is empty when the run carries no reason", () => {
    expect(runErrorText({}, t)).toBeUndefined()
  })
})

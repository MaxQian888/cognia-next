import { newEvalTraceId } from "./span-scope"

describe("newEvalTraceId", () => {
  it("is prefixed and unique across calls", () => {
    const a = newEvalTraceId()
    const b = newEvalTraceId()
    expect(a).toMatch(/^evtrace_/)
    expect(b).toMatch(/^evtrace_/)
    expect(a).not.toBe(b)
  })
})

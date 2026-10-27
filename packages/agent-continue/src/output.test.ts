/** @jest-environment node */
import { parseContinueOutput } from "./output"

describe("Continue published headless JSON output", () => {
  it("extracts the documented structured result without guessing text", () => {
    expect(parseContinueOutput('{"response":"hello","toolCalls":[]}')).toEqual({
      text: "hello",
      structured: { response: "hello", toolCalls: [] },
    })
  })
  it("rejects terminal text and malformed JSON", () => {
    expect(() => parseContinueOutput("hello")).toThrow(/JSON/)
    expect(parseContinueOutput('{"unexpected":true}').text).toBe('{"unexpected":true}')
    expect(() => parseContinueOutput('{"status":"error","error":"quota"}')).toThrow("quota")
  })
})

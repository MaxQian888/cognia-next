import * as logging from "./index"

describe("logging package barrel", () => {
  it("exports the console bridge and OTLP Logs adapter", () => {
    expect(typeof logging.installConsoleBridge).toBe("function")
    expect(typeof logging.structuredLogEntriesToOtlpLogs).toBe("function")
  })
})

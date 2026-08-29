import { copilotCliSessionSource } from "./copilot-cli"

describe("copilotCliSessionSource", () => {
  it("scans the documented local session-state directory", () => {
    expect(copilotCliSessionSource.scanRoots("/home/u")).toEqual(["/home/u/.copilot/session-state"])
    expect(copilotCliSessionSource.detect([])).toBe("no")
  })
})

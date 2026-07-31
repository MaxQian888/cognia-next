import { makeCommandRecord, makeSuggestion, makeTerminalSession } from "./terminal"

describe("terminal story fixtures", () => {
  it("defaults sessions to the local host and preserves remote ownership", () => {
    expect(makeTerminalSession()).toMatchObject({ hostId: null, controllerId: null })
    expect(makeTerminalSession({ hostId: "host_a", controllerId: "device_a" })).toMatchObject({
      hostId: "host_a",
      controllerId: "device_a",
    })
  })

  it("builds command and completion rows while preserving overrides", () => {
    expect(makeCommandRecord({ cmd: "pnpm lint", exitCode: 1 })).toMatchObject({
      cmd: "pnpm lint",
      exitCode: 1,
    })
    expect(makeSuggestion({ text: "git diff", score: 0.95 })).toMatchObject({
      text: "git diff",
      score: 0.95,
      source: "history",
    })
  })
})

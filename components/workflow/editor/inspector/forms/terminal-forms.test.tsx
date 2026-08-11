import {
  SystemTerminalConfig,
  TerminalSessionOpenConfig,
  TerminalSessionRunConfig,
  TerminalSessionCloseConfig,
  TerminalScriptConfig,
  TerminalReadRecentConfig,
  TerminalWaitForExitConfig,
  TerminalCommandTriggerConfig,
} from "./terminal-forms"

describe("terminal-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        SystemTerminalConfig,
        TerminalSessionOpenConfig,
        TerminalSessionRunConfig,
        TerminalSessionCloseConfig,
        TerminalScriptConfig,
        TerminalReadRecentConfig,
        TerminalWaitForExitConfig,
        TerminalCommandTriggerConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})

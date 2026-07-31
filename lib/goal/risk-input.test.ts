import type { AppSettings, Character } from "@cognia/agent-config-types"
import { buildGoalRiskInput } from "./risk-input"

const character = (over: Partial<Character> = {}): Character =>
  ({ id: "c1", name: "C", ...over }) as unknown as Character

const settings = (over: Record<string, unknown> = {}): AppSettings =>
  ({ id: "singleton", ...over }) as unknown as AppSettings

describe("buildGoalRiskInput", () => {
  it("uses the redacted objective verbatim and has no task descriptions", () => {
    const input = buildGoalRiskInput({ safeObjective: "Ship <PERSON_1>'s report" })
    expect(input.objective).toBe("Ship <PERSON_1>'s report")
    expect(input.taskDescriptions).toEqual([])
  })

  it("returns an empty posture with no character and no settings", () => {
    const input = buildGoalRiskInput({ safeObjective: "do a thing" })
    expect(input.toolIds).toEqual([])
    expect(input.capabilityIds).toEqual([])
    expect(input.sandboxEnabled).toBe(false)
  })

  it("takes the character's explicit tool allowlist", () => {
    const input = buildGoalRiskInput({
      safeObjective: "x",
      character: character({ allowedTools: ["bash", "read"] }),
    })
    expect(input.toolIds.sort()).toEqual(["bash", "read"])
  })

  it("maps enableComputerUse onto the computer-use tool id", () => {
    const input = buildGoalRiskInput({
      safeObjective: "x",
      character: character({ enableComputerUse: true }),
    })
    expect(input.toolIds).toContain("computer_use")
  })

  it("does not map enableComputerUse when it is false or absent", () => {
    expect(
      buildGoalRiskInput({ safeObjective: "x", character: character({ enableComputerUse: false }) })
        .toolIds
    ).toEqual([])
    expect(buildGoalRiskInput({ safeObjective: "x", character: character() }).toolIds).toEqual([])
  })

  describe("operator-enabled builtin suites", () => {
    it.each([
      ["coreFiles", "bash"],
      ["process", "start_process"],
      ["shellAdvanced", "shell_execute_advanced"],
      ["terminalRepl", "terminal_repl_spawn"],
      ["fileExtras", "file_append"],
    ])("%s surfaces %s", (suite, toolId) => {
      const input = buildGoalRiskInput({
        safeObjective: "x",
        appSettings: settings({ builtinTools: { [suite]: true } }),
      })
      expect(input.toolIds).toContain(toolId)
    })

    it("ignores a suite that is switched off", () => {
      const input = buildGoalRiskInput({
        safeObjective: "x",
        appSettings: settings({ builtinTools: { coreFiles: false, process: false } }),
      })
      expect(input.toolIds).toEqual([])
    })

    it("ignores suites that carry no risk (git, lsp, codeGraph)", () => {
      const input = buildGoalRiskInput({
        safeObjective: "x",
        appSettings: settings({ builtinTools: { git: true, lsp: true, codeGraph: true } }),
      })
      expect(input.toolIds).toEqual([])
    })
  })

  it("does NOT infer SDK-native tools — only explicit configuration counts", () => {
    // The Anthropic path ships a native Bash regardless of settings. Inferring
    // it here would classify every default goal as high risk and gate all of
    // them, which is exactly the over-gating the policy is built to avoid.
    const input = buildGoalRiskInput({
      safeObjective: "Refactor the parser",
      character: character(),
      appSettings: settings({ builtinTools: {} }),
    })
    expect(input.toolIds).toEqual([])
  })

  it("collects mcp + skill ids as capabilities", () => {
    const input = buildGoalRiskInput({
      safeObjective: "x",
      character: character({ mcpServerIds: ["keyring"], skillIds: ["s1"] }),
    })
    expect(input.capabilityIds.sort()).toEqual(["keyring", "s1"])
  })

  it("drops an explicitly denied tool — a denied tool is not evidence", () => {
    const input = buildGoalRiskInput({
      safeObjective: "x",
      character: character({ allowedTools: ["bash", "read"], disallowedTools: ["bash"] }),
    })
    expect(input.toolIds).toEqual(["read"])
  })

  describe("sandbox cascade", () => {
    it("defaults off", () => {
      expect(buildGoalRiskInput({ safeObjective: "x" }).sandboxEnabled).toBe(false)
    })

    it("follows the app default", () => {
      expect(
        buildGoalRiskInput({
          safeObjective: "x",
          appSettings: settings({ sandboxDefaultEnabled: true }),
        }).sandboxEnabled
      ).toBe(true)
    })

    it("lets the character beat the app default in both directions", () => {
      expect(
        buildGoalRiskInput({
          safeObjective: "x",
          character: character({ sandboxEnabled: false }),
          appSettings: settings({ sandboxDefaultEnabled: true }),
        }).sandboxEnabled
      ).toBe(false)
      expect(
        buildGoalRiskInput({
          safeObjective: "x",
          character: character({ sandboxEnabled: true }),
          appSettings: settings({ sandboxDefaultEnabled: false }),
        }).sandboxEnabled
      ).toBe(true)
    })
  })
})

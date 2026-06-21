/**
 * @jest-environment node
 */
import { parseArgv, stringFlag, boolFlag, numberFlag } from "./args"

describe("parseArgv", () => {
  it("parses a run command with a quoted prompt and value flags", () => {
    const a = parseArgv(["run", "fix the bug", "--model", "gpt-x", "--cwd", "/p"])
    expect(a.command).toBe("run")
    expect(a.subcommand).toBeUndefined()
    expect(a.positionals).toEqual(["fix the bug"])
    expect(stringFlag(a, "model")).toBe("gpt-x")
    expect(stringFlag(a, "cwd")).toBe("/p")
  })

  it("treats grouped commands' first positional as a subcommand", () => {
    const a = parseArgv(["auth", "login", "--provider", "openai", "--api-key", "sk"])
    expect(a.command).toBe("auth")
    expect(a.subcommand).toBe("login")
    expect(stringFlag(a, "provider")).toBe("openai")
  })

  it("handles boolean flags without consuming the next token", () => {
    const a = parseArgv(["run", "hi", "--yes", "--json"])
    expect(boolFlag(a, "yes")).toBe(true)
    expect(boolFlag(a, "json")).toBe(true)
    expect(a.positionals).toEqual(["hi"])
  })

  it("treats --plugin-tools as a boolean flag (does not consume the next token)", () => {
    const a = parseArgv(["chat", "--plugin-tools", "extra"])
    expect(boolFlag(a, "plugin-tools")).toBe(true)
    expect(a.positionals).toContain("extra")
  })

  it("supports --flag=value", () => {
    const a = parseArgv(["run", "hi", "--model=claude-x"])
    expect(stringFlag(a, "model")).toBe("claude-x")
  })

  it("maps short aliases -h -v -y -p", () => {
    expect(parseArgv(["-h"]).help).toBe(true)
    expect(parseArgv(["-v"]).version).toBe(true)
    expect(boolFlag(parseArgv(["run", "x", "-y"]), "yes")).toBe(true)
    expect(boolFlag(parseArgv(["-p", "fix bug"]), "print")).toBe(true)
  })

  it("treats -p/--print as boolean and keeps the prompt as a positional", () => {
    const a = parseArgv(["-p", "fix the bug"])
    expect(boolFlag(a, "print")).toBe(true)
    // The prompt word lands in `command` (the parser shifts the first positional);
    // the index shorthand reconstructs it from command + positionals.
    expect(a.command).toBe("fix the bug")
  })

  it("treats --dev-plugins as boolean (does not consume the next token)", () => {
    const a = parseArgv(["chat", "--dev-plugins", "extra"])
    expect(boolFlag(a, "dev-plugins")).toBe(true)
    expect(a.positionals).toContain("extra")
  })

  it("numberFlag parses numeric value flags and ignores non-numeric / boolean", () => {
    expect(numberFlag(parseArgv(["run", "x", "--max-turns", "12"]), "max-turns")).toBe(12)
    expect(numberFlag(parseArgv(["run", "x", "--max-turns", "abc"]), "max-turns")).toBeUndefined()
    expect(numberFlag(parseArgv(["run", "x"]), "max-turns")).toBeUndefined()
  })

  it("does not consume a following flag as a value", () => {
    const a = parseArgv(["run", "hi", "--model", "--yes"])
    // --model had no value → treated as boolean; --yes parsed separately
    expect(boolFlag(a, "yes")).toBe(true)
    expect(a.flags.model).toBe(true)
  })

  it("returns undefined command for empty argv", () => {
    expect(parseArgv([]).command).toBeUndefined()
  })
})

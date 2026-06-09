/**
 * @jest-environment node
 */
import { parseArgv, stringFlag, boolFlag } from "./args"

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

  it("supports --flag=value", () => {
    const a = parseArgv(["run", "hi", "--model=claude-x"])
    expect(stringFlag(a, "model")).toBe("claude-x")
  })

  it("maps short aliases -h -v -y", () => {
    expect(parseArgv(["-h"]).help).toBe(true)
    expect(parseArgv(["-v"]).version).toBe(true)
    expect(boolFlag(parseArgv(["run", "x", "-y"]), "yes")).toBe(true)
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

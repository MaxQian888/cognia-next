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

  it("treats --continue/-c as boolean and --resume as an optional-value flag", () => {
    // `--continue` never eats the next token (it's in BOOLEAN_FLAGS).
    const a = parseArgv(["chat", "--continue", "extra"])
    expect(boolFlag(a, "continue")).toBe(true)
    expect(a.positionals).toContain("extra")
    expect(boolFlag(parseArgv(["chat", "-c"]), "continue")).toBe(true)
    // `--resume` takes an optional value: id when given, boolean when bare.
    expect(stringFlag(parseArgv(["chat", "--resume", "s-42"]), "resume")).toBe("s-42")
    expect(boolFlag(parseArgv(["chat", "--resume"]), "resume")).toBe(true)
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

  it("treats durability as a grouped command so the verb lands in subcommand", () => {
    const args = parseArgv(["durability", "verify", "--account", "acct"])
    expect(args.command).toBe("durability")
    expect(args.subcommand).toBe("verify")
    expect(stringFlag(args, "account")).toBe("acct")
  })

  it("never lets --activate or --confirm swallow the next token", () => {
    const args = parseArgv([
      "durability",
      "recover",
      "--activate",
      "--from",
      "journal",
      "--confirm",
      "--generation",
      "gen-0002",
    ])
    expect(boolFlag(args, "activate")).toBe(true)
    expect(boolFlag(args, "confirm")).toBe(true)
    expect(stringFlag(args, "from")).toBe("journal")
    expect(stringFlag(args, "generation")).toBe("gen-0002")
  })

  it("treats -- as a stop-parsing sentinel (tokens after go to rest)", () => {
    const args = parseArgv([
      "x",
      "claude",
      "--model",
      "test",
      "--",
      "--verbose",
      "--cwd",
      "/my/dir",
    ])
    expect(args.command).toBe("x")
    expect(stringFlag(args, "model")).toBe("test")
    expect(args.rest).toEqual(["--verbose", "--cwd", "/my/dir"])
    // Tokens after -- should NOT be in positionals or flags
    expect(args.positionals).toEqual(["claude"])
    expect(boolFlag(args, "verbose")).toBe(false)
  })

  it("rest is empty when no -- is present", () => {
    const args = parseArgv(["run", "hello", "--yes"])
    expect(args.rest).toEqual([])
  })

  it("-- at the end yields empty rest", () => {
    const args = parseArgv(["x", "codex", "--"])
    expect(args.rest).toEqual([])
    expect(args.positionals).toEqual(["codex"])
  })

  it("treats --verbose as boolean flag", () => {
    const args = parseArgv(["x", "claude", "--verbose"])
    expect(boolFlag(args, "verbose")).toBe(true)
  })
})

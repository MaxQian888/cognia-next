import {
  parseFixArgs,
  fixCommand,
  FIX_DEFAULT_COMMAND,
  FIX_DEFAULT_ROUNDS,
  FIX_MAX_ROUNDS,
} from "./fix-command"
import type { CommandContext } from "./types"

function ctx(args: string): CommandContext {
  return {
    state: {} as CommandContext["state"],
    config: {} as CommandContext["config"],
    version: "0",
    args,
  }
}

describe("parseFixArgs", () => {
  it("defaults to `pnpm test` and the default round cap", () => {
    expect(parseFixArgs("")).toEqual({
      testCommand: FIX_DEFAULT_COMMAND,
      maxRounds: FIX_DEFAULT_ROUNDS,
    })
  })

  it("takes the remaining tokens as the test command", () => {
    expect(parseFixArgs("pnpm test -- foo.test.ts")).toEqual({
      testCommand: "pnpm test -- foo.test.ts",
      maxRounds: FIX_DEFAULT_ROUNDS,
    })
  })

  it("parses --rounds and --n (both spaced and = forms)", () => {
    expect(parseFixArgs("--rounds 6 jest x").maxRounds).toBe(6)
    expect(parseFixArgs("--n=3 jest x").maxRounds).toBe(3)
    expect(parseFixArgs("jest x --n 2")).toEqual({ testCommand: "jest x", maxRounds: 2 })
  })

  it("clamps the round cap to [1, FIX_MAX_ROUNDS]", () => {
    expect(parseFixArgs("--rounds 0").maxRounds).toBe(1)
    expect(parseFixArgs(`--rounds ${FIX_MAX_ROUNDS + 50}`).maxRounds).toBe(FIX_MAX_ROUNDS)
  })
})

describe("fixCommand", () => {
  it("returns a fixRun effect", () => {
    expect(fixCommand.handler!(ctx("--rounds 5 pnpm test"))).toEqual({
      kind: "fixRun",
      testCommand: "pnpm test",
      maxRounds: 5,
    })
  })

  it("is registered under the cognia category", () => {
    expect(fixCommand.category).toBe("cognia")
    expect(fixCommand.name).toBe("fix")
  })
})

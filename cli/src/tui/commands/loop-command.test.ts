/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import { createInitialState } from "../state/initial"
import { LOOP_DEFAULT, LOOP_MAX, loopCommand, parseLoopArgs } from "./loop-command"
import type { CommandContext, CommandEffect } from "./types"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }
const run = (args: string): CommandEffect =>
  loopCommand.handler!({
    state: createInitialState(config, "s1"),
    config,
    version: "1.0.0",
    args,
  } as CommandContext)

describe("parseLoopArgs", () => {
  it("returns null for empty input", () => {
    expect(parseLoopArgs("   ")).toBeNull()
  })

  it("defaults to LOOP_DEFAULT iterations", () => {
    expect(parseLoopArgs("keep refining")).toEqual({ prompt: "keep refining", max: LOOP_DEFAULT })
  })

  it("parses --n N", () => {
    expect(parseLoopArgs("do it --n 4")).toEqual({ prompt: "do it", max: 4 })
  })

  it("parses --n=N", () => {
    expect(parseLoopArgs("do it --n=7")).toEqual({ prompt: "do it", max: 7 })
  })

  it("keeps the prompt when the flag is in the middle", () => {
    expect(parseLoopArgs("fix the --n 2 bug")).toEqual({ prompt: "fix the bug", max: 2 })
  })

  it("clamps the count to [1, LOOP_MAX]", () => {
    expect(parseLoopArgs("x --n 0")?.max).toBe(1)
    expect(parseLoopArgs("x --n 999")?.max).toBe(LOOP_MAX)
  })

  it("returns null when only a flag is given", () => {
    expect(parseLoopArgs("--n 3")).toBeNull()
  })
})

describe("/loop handler", () => {
  it("emits a loop effect", () => {
    expect(run("ship it --n 2")).toEqual({ kind: "loop", prompt: "ship it", max: 2 })
  })

  it("notices usage when empty", () => {
    expect(run("")).toEqual({ kind: "notice", message: "Usage: /loop <prompt> [--n <count>]" })
  })
})

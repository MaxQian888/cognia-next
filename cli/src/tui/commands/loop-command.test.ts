/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import { createInitialState } from "../state/initial"
import { LOOP_MAX_ITERATIONS, loopCommand, parseLoopArgs } from "./loop-command"
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

  it("defaults to self-paced with no iteration cap", () => {
    expect(parseLoopArgs("keep refining")).toEqual({ mode: "self_paced", prompt: "keep refining" })
  })

  it("parses a leading interval token into interval mode", () => {
    expect(parseLoopArgs("5m check the deploy")).toEqual({
      mode: "interval",
      prompt: "check the deploy",
      intervalMs: 5 * 60_000,
    })
  })

  it("rounds a sub-minute interval up to the 1-minute floor", () => {
    expect(parseLoopArgs("30s ping")).toEqual({
      mode: "interval",
      prompt: "ping",
      intervalMs: 60_000,
    })
  })

  it("does not treat a non-interval first token as interval", () => {
    expect(parseLoopArgs("5things to do")).toEqual({ mode: "self_paced", prompt: "5things to do" })
  })

  it("parses --n N as the iteration cap", () => {
    expect(parseLoopArgs("do it --n 4")).toEqual({
      mode: "self_paced",
      prompt: "do it",
      maxIterations: 4,
    })
  })

  it("parses --n=N", () => {
    expect(parseLoopArgs("do it --n=7")).toEqual({
      mode: "self_paced",
      prompt: "do it",
      maxIterations: 7,
    })
  })

  it("combines interval + --n", () => {
    expect(parseLoopArgs("1h sweep logs --n 3")).toEqual({
      mode: "interval",
      prompt: "sweep logs",
      intervalMs: 3_600_000,
      maxIterations: 3,
    })
  })

  it("keeps the prompt when the flag is in the middle", () => {
    expect(parseLoopArgs("fix the --n 2 bug")).toEqual({
      mode: "self_paced",
      prompt: "fix the bug",
      maxIterations: 2,
    })
  })

  it("clamps the count to [1, LOOP_MAX_ITERATIONS]", () => {
    expect(parseLoopArgs("x --n 0")?.maxIterations).toBe(1)
    expect(parseLoopArgs("x --n 99999")?.maxIterations).toBe(LOOP_MAX_ITERATIONS)
  })

  it("returns null when only a flag is given", () => {
    expect(parseLoopArgs("--n 3")).toBeNull()
  })

  it("returns null when an interval has no prompt", () => {
    expect(parseLoopArgs("5m")).toBeNull()
  })
})

describe("/loop handler", () => {
  it.each(["pause", "resume", "stop"])("routes %s as a control, never a model prompt", (action) => {
    expect(run(action)).toEqual({ kind: "loopControl", action })
  })
  it("emits a self-paced loop effect", () => {
    expect(run("ship it --n 2")).toEqual({
      kind: "loop",
      mode: "self_paced",
      prompt: "ship it",
      maxIterations: 2,
    })
  })

  it("emits an interval loop effect", () => {
    expect(run("10m watch the queue")).toEqual({
      kind: "loop",
      mode: "interval",
      prompt: "watch the queue",
      intervalMs: 10 * 60_000,
    })
  })

  it("notices usage when empty", () => {
    expect(run("")).toEqual({
      kind: "notice",
      message: "Usage: /loop [interval] <prompt> [--n <count>]",
    })
  })
})

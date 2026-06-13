/**
 * @jest-environment node
 */
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import { runDrivenTurns, frameSteer, type DrivenAdvance } from "./driven-turns"
import type { TuiAction } from "../state/types"

const reply = (text: string, input = 0, output = 0): RunAndCaptureResult => ({
  text,
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
  usage: { inputTokens: input, outputTokens: output },
})

describe("runDrivenTurns", () => {
  it("pumps firstPrompt + continuations until advance stops", async () => {
    const actions: TuiAction[] = []
    const sent: string[] = []
    const advances: DrivenAdvance[] = [
      { kind: "continue", prompt: "next-1" },
      { kind: "continue", prompt: "next-2" },
      { kind: "stop", status: "done", summary: "all done" },
    ]
    let i = 0
    await runDrivenTurns({
      send: async (p) => {
        sent.push(p)
        return reply("ok", 3, 2)
      },
      firstPrompt: "first",
      advance: async () => advances[i++],
      dispatch: (a) => actions.push(a),
      signal: new AbortController().signal,
      label: "demo",
      kind: "goal",
      delay: async () => {},
    })

    expect(sent).toEqual(["first", "next-1", "next-2"])
    expect(actions[0]).toEqual({ type: "ACTIVITY_START", kind: "goal", label: "demo" })
    expect(actions.filter((a) => a.type === "ACTIVITY_PROGRESS")).toHaveLength(3)
    expect(actions.at(-1)).toEqual({ type: "ACTIVITY_END", status: "done", summary: "all done" })
  })

  it("forwards the token delta to advance", async () => {
    const seen: number[] = []
    await runDrivenTurns({
      send: async () => reply("ok", 10, 7),
      firstPrompt: "first",
      advance: async ({ tokensDelta }) => {
        seen.push(tokensDelta)
        return { kind: "stop", status: "done", summary: "x" }
      },
      dispatch: () => {},
      signal: new AbortController().signal,
      label: "demo",
      kind: "goal",
    })
    expect(seen).toEqual([17])
  })

  it("a queued steer replaces the next prompt and skips the delay", async () => {
    const sent: string[] = []
    const delaySpy = jest.fn(async () => {})
    let steerOnce: string | null = "check the logs"
    const advances: DrivenAdvance[] = [
      { kind: "continue", prompt: "auto-next", delayMs: 5000 },
      { kind: "stop", status: "done", summary: "done" },
    ]
    let i = 0
    await runDrivenTurns({
      send: async (p) => {
        sent.push(p)
        return reply("ok")
      },
      firstPrompt: "first",
      advance: async () => advances[i++],
      dispatch: () => {},
      signal: new AbortController().signal,
      label: "demo",
      kind: "loop",
      delay: delaySpy,
      takeSteer: () => {
        const s = steerOnce
        steerOnce = null
        return s
      },
    })

    expect(sent[0]).toBe("first")
    expect(sent[1]).toBe(frameSteer("check the logs"))
    expect(delaySpy).not.toHaveBeenCalled()
  })

  it("stops when the signal is already aborted", async () => {
    const actions: TuiAction[] = []
    const controller = new AbortController()
    controller.abort()
    const send = jest.fn(async () => reply("ok"))
    await runDrivenTurns({
      send,
      firstPrompt: "first",
      advance: async () => ({ kind: "stop", status: "done", summary: "x" }),
      dispatch: (a) => actions.push(a),
      signal: controller.signal,
      label: "demo",
      kind: "goal",
    })
    expect(send).not.toHaveBeenCalled()
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "done" })
  })

  it("ends with an error when a turn fails (send returns null)", async () => {
    const actions: TuiAction[] = []
    const advance = jest.fn(
      async (): Promise<DrivenAdvance> => ({
        kind: "stop",
        status: "done",
        summary: "x",
      })
    )
    await runDrivenTurns({
      send: async () => null,
      firstPrompt: "first",
      advance,
      dispatch: (a) => actions.push(a),
      signal: new AbortController().signal,
      label: "demo",
      kind: "loop",
    })
    expect(advance).not.toHaveBeenCalled()
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
  })

  it("ends with an error when advance throws", async () => {
    const actions: TuiAction[] = []
    await runDrivenTurns({
      send: async () => reply("ok"),
      firstPrompt: "first",
      advance: async () => {
        throw new Error("kaboom")
      },
      dispatch: (a) => actions.push(a),
      signal: new AbortController().signal,
      label: "demo",
      kind: "goal",
    })
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "error",
      summary: "Goal crashed: kaboom",
    })
  })

  it("uses the built-in delay between turns when none is injected", async () => {
    const advances: DrivenAdvance[] = [
      { kind: "continue", prompt: "again", delayMs: 1 },
      { kind: "stop", status: "done", summary: "done" },
    ]
    let i = 0
    const actions: TuiAction[] = []
    await runDrivenTurns({
      send: async () => reply("ok"),
      firstPrompt: "first",
      advance: async () => advances[i++],
      dispatch: (a) => actions.push(a),
      signal: new AbortController().signal,
      label: "demo",
      kind: "loop",
      // no `delay` injected → exercises the built-in setTimeout path
    })
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "done" })
  })

  it("the built-in delay resolves early when the signal aborts mid-wait", async () => {
    const controller = new AbortController()
    const actions: TuiAction[] = []
    let first = true
    await runDrivenTurns({
      send: async () => reply("ok"),
      firstPrompt: "first",
      advance: async () => {
        if (first) {
          first = false
          setTimeout(() => controller.abort(), 0)
          return { kind: "continue", prompt: "again", delayMs: 10_000 }
        }
        return { kind: "stop", status: "done", summary: "done" }
      },
      dispatch: (a) => actions.push(a),
      signal: controller.signal,
      label: "demo",
      kind: "goal",
    })
    // Abort fired during the wait → the next loop iteration sees it and ends.
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END" })
  })

  it("enforces the hard cap", async () => {
    const actions: TuiAction[] = []
    await runDrivenTurns({
      send: async () => reply("ok"),
      firstPrompt: "first",
      advance: async () => ({ kind: "continue", prompt: "again" }),
      dispatch: (a) => actions.push(a),
      signal: new AbortController().signal,
      label: "demo",
      kind: "loop",
      hardCap: 3,
      delay: async () => {},
    })
    expect(actions.filter((a) => a.type === "ACTIVITY_PROGRESS")).toHaveLength(3)
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
  })
})

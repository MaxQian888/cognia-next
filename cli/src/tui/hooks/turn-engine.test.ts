/**
 * @jest-environment node
 */
import type { CapturePermissionDecision, RunAndCaptureResult } from "@/lib/claude/run-and-capture"

import { createGateController, runTurn, type TurnSession } from "./turn-engine"
import type { TuiAction } from "../state/types"

const okResult = (overrides?: Partial<RunAndCaptureResult>): RunAndCaptureResult => ({
  text: "done",
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
  ...overrides,
})

describe("createGateController", () => {
  it("resolves the responder promise when the UI supplies a decision", async () => {
    const requests: string[] = []
    const gate = createGateController((req) => requests.push(req.toolName))
    const decisionP = gate.responder({ toolName: "bash" } as never)
    expect(requests).toEqual(["bash"])
    expect(gate.isPending()).toBe(true)
    const decision: CapturePermissionDecision = { decision: "allow_always" }
    gate.resolve(decision)
    await expect(decisionP).resolves.toEqual(decision)
    expect(gate.isPending()).toBe(false)
  })

  it("resolve is a no-op when nothing is pending", () => {
    const gate = createGateController(() => {})
    expect(() => gate.resolve({ decision: "deny" })).not.toThrow()
  })

  it("queues concurrent requests in order", async () => {
    const gate = createGateController(() => {})
    const a = gate.responder({ toolName: "a" } as never)
    const b = gate.responder({ toolName: "b" } as never)
    gate.resolve({ decision: "allow" })
    gate.resolve({ decision: "deny" })
    await expect(a).resolves.toEqual({ decision: "allow" })
    await expect(b).resolves.toEqual({ decision: "deny" })
  })
})

describe("runTurn", () => {
  it("streams capture events into reducer actions and commits", async () => {
    const actions: TuiAction[] = []
    const session: TurnSession = {
      async send(_prompt, opts) {
        opts.onEvent?.({ type: "text-delta", delta: "Hi" })
        opts.onEvent?.({ type: "tool-call", toolName: "bash", input: { command: "ls" } })
        return okResult({ usage: { inputTokens: 3 } })
      },
    }
    await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
    })
    expect(actions.map((a) => a.type)).toEqual([
      "TURN_START",
      "INFLIGHT_TEXT",
      "TOOL_CALL",
      "TURN_COMMIT",
    ])
  })

  it("surfaces active skills as a NOTICE", async () => {
    const actions: TuiAction[] = []
    const session: TurnSession = {
      async send(_prompt, opts) {
        opts.onActiveSkills?.(["builtin:web-search", "cli-disk:p:my-skill"])
        return okResult()
      },
    }
    await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
    })
    expect(actions).toContainEqual({
      type: "NOTICE",
      message: "Active skills (2): web-search, my-skill",
    })
  })

  it("does not dispatch a NOTICE when no skills are active", async () => {
    const actions: TuiAction[] = []
    const session: TurnSession = {
      async send(_prompt, opts) {
        opts.onActiveSkills?.([])
        return okResult()
      },
    }
    await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
    })
    expect(actions.some((a) => a.type === "NOTICE")).toBe(false)
  })

  it("maps a thrown error to TURN_ERROR", async () => {
    const actions: TuiAction[] = []
    const session: TurnSession = {
      async send() {
        throw new Error("kaboom")
      },
    }
    await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
    })
    expect(actions.at(-1)).toEqual({ type: "TURN_ERROR", message: "kaboom" })
  })

  it("maps an aborted turn to TURN_ABORTED", async () => {
    const actions: TuiAction[] = []
    const controller = new AbortController()
    const session: TurnSession = {
      async send() {
        controller.abort()
        throw new Error("aborted")
      },
    }
    await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
      signal: controller.signal,
    })
    expect(actions.at(-1)).toEqual({ type: "TURN_ABORTED" })
  })

  it("drives the gate through to the session", async () => {
    let sawDecision: CapturePermissionDecision | undefined
    const gate = createGateController(() => {})
    const session: TurnSession = {
      async send(_prompt, opts) {
        const p = opts.gate({ toolName: "bash" } as never)
        gate.resolve({ decision: "deny", message: "no" })
        sawDecision = await p
        return okResult()
      },
    }
    await runTurn({ session, prompt: "go", dispatch: () => {}, gate: gate.responder })
    expect(sawDecision).toEqual({ decision: "deny", message: "no" })
  })
})

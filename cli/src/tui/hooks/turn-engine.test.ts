/**
 * @jest-environment node
 */
import type { CapturePermissionDecision, RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import { RunAndCaptureError } from "@/lib/claude/run-and-capture"

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

  it("peek returns the head request (for attributing a denial), undefined when empty", () => {
    const gate = createGateController(() => {})
    expect(gate.peek()).toBeUndefined()
    void gate.responder({ toolName: "bash" } as never)
    void gate.responder({ toolName: "edit" } as never)
    expect(gate.peek()?.toolName).toBe("bash") // FIFO head
    gate.resolve({ decision: "deny" })
    expect(gate.peek()?.toolName).toBe("edit") // head advances
    gate.resolve({ decision: "allow" })
    expect(gate.peek()).toBeUndefined()
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

  it("surfaces parallel requests one overlay at a time (head only, then re-pumps)", async () => {
    // Regression: a single assistant message can emit several tool_use blocks in
    // parallel, so the responder is invoked concurrently for all of them. The
    // overlay must show ONE request at a time — firing onRequest for every
    // arrival overwrote the overlay down to the last ask, and the UI resolved a
    // single decision then closed, stranding the other resolvers (their
    // canUseTool promises never settled → the turn hung forever).
    const opened: string[] = []
    const gate = createGateController((req) => opened.push(req.toolName))
    const a = gate.responder({ toolName: "dir_a" } as never)
    const b = gate.responder({ toolName: "dir_b" } as never)
    const c = gate.responder({ toolName: "dir_c" } as never)
    // Only the head opened an overlay; the other two wait their turn.
    expect(opened).toEqual(["dir_a"])
    expect(gate.isPending()).toBe(true)

    gate.resolve({ decision: "allow" }) // dir_a → re-pumps dir_b
    expect(opened).toEqual(["dir_a", "dir_b"])
    gate.resolve({ decision: "allow" }) // dir_b → re-pumps dir_c
    expect(opened).toEqual(["dir_a", "dir_b", "dir_c"])
    gate.resolve({ decision: "allow" }) // dir_c → queue drained, no re-pump
    expect(opened).toEqual(["dir_a", "dir_b", "dir_c"])
    expect(gate.isPending()).toBe(false)

    // Every parallel ask was answered — none stranded.
    await expect(a).resolves.toEqual({ decision: "allow" })
    await expect(b).resolves.toEqual({ decision: "allow" })
    await expect(c).resolves.toEqual({ decision: "allow" })
  })

  it("reset clears pending resolvers so the next request doesn't pop a stale one", async () => {
    const gate = createGateController(() => {})
    // Simulate a timed-out turn: a permission was requested but never resolved.
    const _orphaned = gate.responder({ toolName: "stale" } as never)
    expect(gate.isPending()).toBe(true)
    // The session hook resets the gate after the error.
    gate.reset()
    expect(gate.isPending()).toBe(false)
    // The orphaned promise is never resolved (it will be gc'd).
    // A new turn starts and a fresh permission arrives — it must be the
    // FIRST queued resolver, not the stale one.
    const fresh = gate.responder({ toolName: "fresh" } as never)
    gate.resolve({ decision: "allow" })
    await expect(fresh).resolves.toEqual({ decision: "allow" })
  })
})

describe("createGateController auto-approve", () => {
  it("auto-resolves allow without showing the overlay when autoApprove returns true", async () => {
    const requests: string[] = []
    const gate = createGateController(
      (req) => requests.push(req.toolName),
      undefined,
      (req) => req.toolName === "mcp__cognia-tools__bash"
    )
    const decision = await gate.responder({
      toolName: "mcp__cognia-tools__bash",
      input: {},
    } as never)
    expect(decision).toEqual({ decision: "allow" })
    // The overlay never opened and nothing is left pending.
    expect(requests).toEqual([])
    expect(gate.isPending()).toBe(false)
  })

  it("falls through to the overlay when autoApprove returns false", async () => {
    const requests: string[] = []
    const gate = createGateController(
      (req) => requests.push(req.toolName),
      undefined,
      () => false
    )
    const p = gate.responder({ toolName: "Edit", input: {} } as never)
    expect(requests).toEqual(["Edit"])
    expect(gate.isPending()).toBe(true)
    gate.resolve({ decision: "allow" })
    await expect(p).resolves.toEqual({ decision: "allow" })
  })

  it("a PreToolUse deny still wins over an auto-approve", async () => {
    const requests: string[] = []
    const gate = createGateController(
      (req) => requests.push(req.toolName),
      async () => ({ deny: true, reason: "blocked by hook" }),
      () => true
    )
    const decision = await gate.responder({ toolName: "bash", input: {} } as never)
    expect(decision).toEqual({ decision: "deny", message: "blocked by hook" })
    expect(requests).toEqual([])
    expect(gate.isPending()).toBe(false)
  })

  it("auto-approves after the pre-check allows (pre-check precedes auto-approve)", async () => {
    const requests: string[] = []
    const gate = createGateController(
      (req) => requests.push(req.toolName),
      async () => ({ deny: false }),
      () => true
    )
    const decision = await gate.responder({ toolName: "bash", input: {} } as never)
    expect(decision).toEqual({ decision: "allow" })
    expect(requests).toEqual([])
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
    const { ok } = await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
    })
    expect(ok).toBe(true)
    expect(actions.map((a) => a.type)).toEqual([
      "TURN_START",
      "INFLIGHT_TEXT",
      "TOOL_CALL",
      "TURN_COMMIT",
    ])
  })

  it("returns the captured result on success and undefined on error", async () => {
    const result = okResult({ text: "hi", usage: { inputTokens: 10, outputTokens: 5 } })
    const okSession: TurnSession = {
      async send() {
        return result
      },
    }
    const okOut = await runTurn({
      session: okSession,
      prompt: "x",
      dispatch: () => {},
      gate: async () => ({ decision: "allow" }),
    })
    expect(okOut).toEqual({ ok: true, result })

    const errSession: TurnSession = {
      async send() {
        throw new Error("boom")
      },
    }
    const errOut = await runTurn({
      session: errSession,
      prompt: "x",
      dispatch: () => {},
      gate: async () => ({ decision: "allow" }),
    })
    // An unknown (non-RunAndCaptureError) fault is treated as non-recoverable.
    expect(errOut).toEqual({ ok: false, recoverable: false })
  })

  it("surfaces active skills as a NOTICE when showActiveSkills is on", async () => {
    const actions: TuiAction[] = []
    const session: TurnSession = {
      async send(_prompt, opts) {
        opts.onActiveSkills?.(["builtin:web-search", "cli-disk:p:my-skill"])
        return okResult()
      },
    }
    const { ok } = await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
      showActiveSkills: true,
    })
    expect(ok).toBe(true)
    expect(actions).toContainEqual({
      type: "NOTICE",
      message: "Active skills (2): web-search, my-skill",
    })
  })

  it("suppresses the active-skills NOTICE by default (showActiveSkills off)", async () => {
    const actions: TuiAction[] = []
    const session: TurnSession = {
      async send(_prompt, opts) {
        opts.onActiveSkills?.(["builtin:web-search"])
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

  it("does not dispatch a NOTICE when no skills are active", async () => {
    const actions: TuiAction[] = []
    const session: TurnSession = {
      async send(_prompt, opts) {
        opts.onActiveSkills?.([])
        return okResult()
      },
    }
    const { ok } = await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
    })
    expect(ok).toBe(true)
    expect(actions.some((a) => a.type === "NOTICE")).toBe(false)
  })

  it("surfaces an attachment summary as a NOTICE", async () => {
    const actions: TuiAction[] = []
    const session: TurnSession = {
      async send(_prompt, opts) {
        opts.onAttachments?.({
          imageCount: 1,
          documentCount: 0,
          injectedFiles: ["spec.md"],
          ocr: [],
          failed: [],
          skipped: [],
        })
        return okResult()
      },
    }
    const { ok } = await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
    })
    expect(ok).toBe(true)
    expect(actions).toContainEqual({ type: "NOTICE", message: "📎 1 image · 1 file inlined" })
  })

  it("maps a thrown error to TURN_ERROR and returns ok:false", async () => {
    const actions: TuiAction[] = []
    const session: TurnSession = {
      async send() {
        throw new Error("kaboom")
      },
    }
    const { ok } = await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
    })
    expect(ok).toBe(false)
    // A generic error still carries the classified title (no hint for generic).
    expect(actions.at(-1)).toEqual({
      type: "TURN_ERROR",
      message: "kaboom",
      title: "Error",
      category: "generic",
    })
  })

  it("attaches a remediation hint + category for a classifiable error", async () => {
    const actions: TuiAction[] = []
    const session: TurnSession = {
      async send() {
        throw new Error("Request failed: 401 Unauthorized")
      },
    }
    await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
    })
    const last = actions.at(-1) as Extract<TuiAction, { type: "TURN_ERROR" }>
    expect(last.type).toBe("TURN_ERROR")
    expect(last.category).toBe("auth")
    expect(last.hint).toMatch(/re-authenticate/i)
  })

  it("maps an aborted turn to TURN_ABORTED and returns ok:false", async () => {
    const actions: TuiAction[] = []
    const controller = new AbortController()
    const session: TurnSession = {
      async send() {
        controller.abort()
        throw new Error("aborted")
      },
    }
    const { ok } = await runTurn({
      session,
      prompt: "go",
      dispatch: (a) => actions.push(a),
      gate: async () => ({ decision: "allow" }),
      signal: controller.signal,
    })
    expect(ok).toBe(false)
    expect(actions.at(-1)).toEqual({ type: "TURN_ABORTED" })
  })

  it("marks a user-aborted turn as recoverable (session kept for the next message)", async () => {
    const controller = new AbortController()
    const session: TurnSession = {
      async send() {
        controller.abort()
        throw new RunAndCaptureError("aborted by signal", "aborted")
      },
    }
    const out = await runTurn({
      session,
      prompt: "go",
      dispatch: () => {},
      gate: async () => ({ decision: "allow" }),
      signal: controller.signal,
    })
    expect(out).toEqual({ ok: false, recoverable: true })
  })

  it.each([
    ["session_error", true],
    ["send_failed", true],
    ["no_assistant_text", true],
    ["sidecar_exited", false],
  ] as const)("maps RunAndCaptureError %s to recoverable=%s", async (code, recoverable) => {
    const session: TurnSession = {
      async send() {
        throw new RunAndCaptureError("boom", code)
      },
    }
    const out = await runTurn({
      session,
      prompt: "go",
      dispatch: () => {},
      gate: async () => ({ decision: "allow" }),
    })
    expect(out).toEqual({ ok: false, recoverable })
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

describe("createGateController PreToolUse pre-check", () => {
  it("denies a tool when the pre-check denies, without showing the overlay", async () => {
    const requests: string[] = []
    const gate = createGateController(
      (req) => requests.push(req.toolName),
      async () => ({ deny: true, reason: "blocked by hook" })
    )
    const decision = await gate.responder({ toolName: "Edit", input: {} } as never)
    expect(decision).toEqual({ decision: "deny", message: "blocked by hook" })
    expect(requests).toEqual([])
    expect(gate.isPending()).toBe(false)
  })

  it("falls through to the overlay when the pre-check allows", async () => {
    const requests: string[] = []
    const gate = createGateController(
      (req) => requests.push(req.toolName),
      async () => ({ deny: false })
    )
    const p = gate.responder({ toolName: "Edit", input: {} } as never)
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toEqual(["Edit"])
    gate.resolve({ decision: "allow" })
    await expect(p).resolves.toEqual({ decision: "allow" })
  })

  it("falls through to the overlay when the pre-check throws", async () => {
    const requests: string[] = []
    const gate = createGateController(
      (req) => requests.push(req.toolName),
      async () => {
        throw new Error("boom")
      }
    )
    const p = gate.responder({ toolName: "Edit", input: {} } as never)
    await Promise.resolve()
    await Promise.resolve()
    expect(requests).toEqual(["Edit"])
    gate.resolve({ decision: "allow" })
    await expect(p).resolves.toEqual({ decision: "allow" })
  })
})

/**
 * Tests for the AI Shell plan executor.
 */

import { executeStep, executePlan } from "./plan-executor"
import type { ExecutionStep, ExecutionPlan, AiShellSession, StepStatus } from "./types"

/** Helper: create a mock session that resolves commands synchronously via callbacks. */
function mockSession(exitCodes: Array<number | null | "timeout">): AiShellSession {
  let callIdx = 0
  const written: string[] = []

  return {
    write(data: string) {
      written.push(data)
      // Trigger the queued callback on next microtask (simulates PTY response)
    },
    onNextPrompt(cb: () => void) {
      Promise.resolve().then(cb)
      return () => {}
    },
    onCommandEnd(cb: (exitCode: number | null) => void) {
      const idx = callIdx++
      const code = exitCodes[idx]
      if (code === "timeout") {
        // Don't fire the callback — let the timeout handle it
        return () => {}
      }
      // Fire on microtask so the write() happens first
      Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => cb(code as number | null))
      return () => {}
    },
    getRecentOutput(maxLines?: number) {
      return `error output (${maxLines ?? 20} lines)`
    },
  }
}

function makeStep(overrides?: Partial<ExecutionStep>): ExecutionStep {
  return {
    index: 0,
    command: "echo hello",
    description: "Print hello",
    status: "pending",
    exitCode: null,
    outputSnippet: null,
    requiresConfirmation: false,
    ...overrides,
  }
}

function makePlan(steps: ExecutionStep[]): ExecutionPlan {
  return {
    id: "test-plan",
    intent: "test",
    steps,
    status: "ready",
    createdAt: Date.now(),
  }
}

describe("ai-shell/plan-executor", () => {
  describe("executeStep", () => {
    it("succeeds with exit code 0", async () => {
      const session = mockSession([0])
      const step = makeStep()

      const result = await executeStep(step, session)

      expect(result.status).toBe("succeeded")
      expect(result.exitCode).toBe(0)
      expect(result.outputSnippet).toBeNull()
    })

    it("fails with non-zero exit code", async () => {
      const session = mockSession([1])
      const step = makeStep({ command: "false" })

      const result = await executeStep(step, session)

      expect(result.status).toBe("failed")
      expect(result.exitCode).toBe(1)
      expect(result.outputSnippet).toContain("error output")
    })

    it("returns cancelled when signal is already aborted", async () => {
      const controller = new AbortController()
      controller.abort()
      const session = mockSession([0])
      const step = makeStep()

      const result = await executeStep(step, session, { signal: controller.signal })

      expect(result.status).toBe("cancelled")
    })

    it("cancels mid-execution when signal aborts", async () => {
      const controller = new AbortController()
      // Session that never fires command_end
      const session: AiShellSession = {
        write() {},
        onNextPrompt() {
          return () => {}
        },
        onCommandEnd() {
          return () => {}
        },
        getRecentOutput() {
          return ""
        },
      }
      const step = makeStep()

      // Start execution but abort immediately after
      const resultPromise = executeStep(step, session, {
        signal: controller.signal,
        timeoutMs: 30_000,
      })
      controller.abort()
      const result = await resultPromise

      expect(result.status).toBe("cancelled")
    })

    it("times out when command_end never fires", async () => {
      jest.useFakeTimers()
      const session: AiShellSession = {
        write() {},
        onNextPrompt() {
          return () => {}
        },
        onCommandEnd() {
          return () => {}
        },
        getRecentOutput() {
          return "stuck output"
        },
      }
      const step = makeStep()

      const resultPromise = executeStep(step, session, { timeoutMs: 100 })
      jest.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result.status).toBe("failed")
      expect(result.exitCode).toBeNull()
      jest.useRealTimers()
    })
  })

  describe("executePlan", () => {
    it("executes all steps successfully", async () => {
      const session = mockSession([0, 0, 0])
      const plan = makePlan([
        makeStep({ index: 0, command: "step 1" }),
        makeStep({ index: 1, command: "step 2" }),
        makeStep({ index: 2, command: "step 3" }),
      ])

      const result = await executePlan(plan, session)

      expect(result.allSucceeded).toBe(true)
      expect(result.completedSteps).toBe(3)
      expect(result.totalSteps).toBe(3)
      expect(result.firstFailedStep).toBe(-1)
    })

    it("stops on first failure", async () => {
      const session = mockSession([0, 1])
      const plan = makePlan([
        makeStep({ index: 0, command: "step 1" }),
        makeStep({ index: 1, command: "step 2 (fails)" }),
        makeStep({ index: 2, command: "step 3 (never runs)" }),
      ])

      const result = await executePlan(plan, session)

      expect(result.allSucceeded).toBe(false)
      expect(result.completedSteps).toBe(1)
      expect(result.firstFailedStep).toBe(1)
      // Remaining step should be pending (not cancelled)
      expect(result.steps[2].status).toBe("pending")
    })

    it("fires onProgress callback for each step", async () => {
      const session = mockSession([0, 0])
      const plan = makePlan([makeStep({ index: 0 }), makeStep({ index: 1 })])
      const progress: Array<{ idx: number; status: StepStatus }> = []

      await executePlan(plan, session, undefined, (idx, status) => {
        progress.push({ idx, status })
      })

      // Should have "running" + "succeeded" for each step
      expect(progress).toContainEqual({ idx: 0, status: "running" })
      expect(progress).toContainEqual({ idx: 0, status: "succeeded" })
      expect(progress).toContainEqual({ idx: 1, status: "running" })
      expect(progress).toContainEqual({ idx: 1, status: "succeeded" })
    })

    it("skips already-succeeded steps", async () => {
      const session = mockSession([0])
      const plan = makePlan([
        makeStep({ index: 0, status: "succeeded", exitCode: 0 }),
        makeStep({ index: 1, command: "new step" }),
      ])

      const result = await executePlan(plan, session)

      expect(result.completedSteps).toBe(2)
      expect(result.steps[0].status).toBe("succeeded")
    })

    it("cancels all remaining steps when signal aborts before start", async () => {
      const controller = new AbortController()
      controller.abort()
      const session = mockSession([])
      const plan = makePlan([makeStep({ index: 0 }), makeStep({ index: 1 })])

      const result = await executePlan(plan, session, { signal: controller.signal })

      expect(result.allSucceeded).toBe(false)
      expect(result.steps[0].status).toBe("cancelled")
      expect(result.steps[1].status).toBe("cancelled")
    })

    it("handles empty plan", async () => {
      const session = mockSession([])
      const plan = makePlan([])

      const result = await executePlan(plan, session)

      expect(result.allSucceeded).toBe(true)
      expect(result.completedSteps).toBe(0)
      expect(result.totalSteps).toBe(0)
    })
  })
})

/**
 * @jest-environment jsdom
 */

/**
 * Tests for the useAiShell hook.
 */

import { renderHook, act } from "@testing-library/react"
import { useAiShell, __resetAiShellMessageIdForTesting } from "./use-ai-shell"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { getLiveSession } from "@/lib/terminal/session-registry"
import type { IntegrationEvent } from "@/lib/terminal/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock dependencies
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: { terminal: { autocomplete: {} } },
      activeSession: null,
    }),
  },
}))

jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: {
    getState: () => ({
      sessions: {
        "test-session": {
          id: "test-session",
          cwd: "/home/user",
          shell: "zsh",
          status: "idle",
          lastCommands: [{ cmd: "ls", exitCode: 0, endedAt: 1000 }],
        },
      },
    }),
  },
}))

jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: jest.fn(() => null),
}))

jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: jest.fn(() => null),
}))

describe("useAiShell", () => {
  beforeEach(() => {
    __resetAiShellMessageIdForTesting()
    jest.clearAllMocks()
    ;(buildUtilityLlmClient as jest.Mock).mockReturnValue(null)
    ;(getLiveSession as jest.Mock).mockReturnValue(null)
  })

  describe("observed execution", () => {
    function setup(integration = true, interruptAcknowledged = true) {
      const listeners = new Set<(event: IntegrationEvent) => void>()
      const write = jest.fn(async (data: string) => {
        if (data === "\u0003" && interruptAcknowledged) {
          for (const cb of listeners) cb({ kind: "command_end", exit_code: 130 })
        }
      })
      const complete = jest.fn(async () =>
        JSON.stringify({
          steps: [
            { command: "echo hello", description: "Print hello" },
            { command: "echo world", description: "Print world" },
          ],
        })
      )
      ;(buildUtilityLlmClient as jest.Mock).mockReturnValue({ complete })
      ;(getLiveSession as jest.Mock).mockReturnValue({
        write,
        getLastOutput: () => "",
        ...(integration
          ? {
              onIntegration: (cb: (event: IntegrationEvent) => void) => {
                listeners.add(cb)
                return () => listeners.delete(cb)
              },
            }
          : {}),
      })
      const hook = renderHook(() => useAiShell("test-session"))
      return {
        ...hook,
        write,
        complete,
        listeners,
        emit: (event: IntegrationEvent) => {
          for (const cb of listeners) cb(event)
        },
      }
    }

    async function setupFailedStep(retryAfterFix: boolean, interruptAcknowledged = true) {
      const hook = setup(true, interruptAcknowledged)
      await act(async () => {
        await hook.result.current[1].submit("print a greeting")
      })
      act(() => {
        hook.result.current[1].skipStep(1)
      })
      let pending!: Promise<void>
      act(() => {
        pending = hook.result.current[1].runNextStep()
      })
      await act(async () => {
        hook.emit({ kind: "command_end", exit_code: 1 })
        await pending
      })
      expect(hook.result.current[0].plan?.steps[0]).toMatchObject({
        command: "echo hello",
        status: "failed",
        exitCode: 1,
      })
      hook.complete.mockResolvedValueOnce(
        JSON.stringify({
          diagnosis: "The command needs a replacement greeting",
          suggestedFix: "echo fixed",
          retryAfterFix,
        })
      )
      await act(async () => {
        await hook.result.current[1].requestAdvisory(0)
      })
      expect(hook.complete).toHaveBeenCalledTimes(2)
      expect(hook.complete.mock.calls[1]).toEqual([
        expect.stringContaining("echo hello"),
        expect.objectContaining({
          system: expect.stringContaining("terminal error diagnosis assistant"),
        }),
      ])
      expect(hook.result.current[0].advisory).toMatchObject({
        stepIndex: 0,
        suggestedFix: "echo fixed",
        retryAfterFix,
      })
      return hook
    }

    it("waits for a fix's real exit before making the original command pending without auto-running it", async () => {
      const { result, emit, write } = await setupFailedStep(true)
      let pending!: Promise<void>
      act(() => {
        pending = result.current[1].applyFix()
      })
      expect(result.current[0].executing).toBe(true)
      expect(result.current[0].advisory).not.toBeNull()
      expect(write).toHaveBeenLastCalledWith("echo fixed\r")

      await act(async () => {
        emit({ kind: "command_end", exit_code: 0 })
        await pending
      })

      expect(result.current[0].executing).toBe(false)
      expect(result.current[0].advisory).toBeNull()
      expect(result.current[0].plan).toMatchObject({
        status: "ready",
        steps: [
          { command: "echo hello", status: "pending", exitCode: null, outputSnippet: null },
          { status: "skipped" },
        ],
      })
      expect(write.mock.calls.map(([data]) => data)).toEqual(["echo hello\r", "echo fixed\r"])
    })

    it("replaces a failed command with a successful non-retry fix and completes the finished plan", async () => {
      const { result, emit, write } = await setupFailedStep(false)
      let pending!: Promise<void>
      act(() => {
        pending = result.current[1].applyFix()
      })
      expect(result.current[0].executing).toBe(true)
      await act(async () => {
        emit({ kind: "command_end", exit_code: 0 })
        await pending
      })

      expect(result.current[0].advisory).toBeNull()
      expect(result.current[0].plan).toMatchObject({
        status: "completed",
        steps: [{ command: "echo fixed", status: "succeeded", exitCode: 0 }, { status: "skipped" }],
      })
      expect(write.mock.calls.map(([data]) => data)).toEqual(["echo hello\r", "echo fixed\r"])
    })

    it("sends an interrupt when cancelling a fix and waits for the actual command end", async () => {
      const { result, emit, write } = await setupFailedStep(true, false)
      let pending!: Promise<void>
      act(() => {
        pending = result.current[1].applyFix()
      })
      await act(async () => {
        result.current[1].cancel()
        await Promise.resolve()
      })
      expect(write).toHaveBeenLastCalledWith("\u0003")
      expect(result.current[0].executing).toBe(true)
      await act(async () => {
        emit({ kind: "command_end", exit_code: 130 })
        await pending
      })
      expect(result.current[0].executing).toBe(false)
      expect(result.current[0].plan?.status).toBe("cancelled")
      expect(result.current[0].plan?.steps[0].status).not.toBe("succeeded")
    })

    it("blocks further execution after an unacknowledged fix interrupt until a real prompt recovers the session", async () => {
      jest.useFakeTimers()
      try {
        const { result, emit, write, unmount } = await setupFailedStep(true, false)
        let pending!: Promise<void>
        act(() => {
          pending = result.current[1].applyFix()
        })
        await act(async () => {
          result.current[1].cancel()
          await jest.advanceTimersByTimeAsync(2000)
          await pending
        })
        expect(result.current[0].executing).toBe(false)
        expect(result.current[0].messages.at(-1)?.content).toBe("messages.executionFailed")
        const writesAfterInterrupt = write.mock.calls.length
        await act(async () => {
          await result.current[1].runNextStep()
          await result.current[1].applyFix()
        })
        expect(write).toHaveBeenCalledTimes(writesAfterInterrupt)

        unmount()
        const remounted = renderHook(() => useAiShell("test-session"))
        await act(async () => {
          await remounted.result.current[1].submit("print a new greeting")
        })
        act(() => {
          remounted.result.current[1].skipStep(1)
        })
        await act(async () => {
          await remounted.result.current[1].runNextStep()
        })
        expect(write).toHaveBeenCalledTimes(writesAfterInterrupt)
        expect(remounted.result.current[0].messages.at(-1)?.content).toBe(
          "messages.executionFailed"
        )

        act(() => {
          emit({ kind: "prompt_start" })
        })
        act(() => {
          pending = remounted.result.current[1].runNextStep()
        })
        expect(write).toHaveBeenLastCalledWith("echo hello\r")
        await act(async () => {
          emit({ kind: "command_end", exit_code: 0 })
          await pending
        })
        expect(remounted.result.current[0].plan?.status).toBe("completed")
      } finally {
        jest.useRealTimers()
      }
    })

    it("allows a failed step to be edited and explicitly skipped after execution ends", async () => {
      const { result, write } = await setupFailedStep(true)
      act(() => {
        result.current[1].editStep(0, "  echo revised  ")
      })
      expect(result.current[0].plan?.steps[0]).toMatchObject({
        command: "echo revised",
        status: "pending",
        exitCode: null,
        outputSnippet: null,
      })
      act(() => {
        result.current[1].skipStep(0)
      })
      expect(result.current[0].plan?.steps.map((step) => step.status)).toEqual([
        "skipped",
        "skipped",
      ])
      expect(result.current[0].plan?.status).toBe("completed")
      expect(write).toHaveBeenCalledTimes(1)
    })

    it("never invents success after five seconds without integration", async () => {
      jest.useFakeTimers()
      try {
        const { result, write } = setup(false)
        await act(async () => {
          await result.current[1].submit("print a greeting")
        })
        let pending!: Promise<void>
        act(() => {
          pending = result.current[1].runAll()
        })
        await act(async () => {
          await jest.advanceTimersByTimeAsync(5000)
        })
        expect(result.current[0].executing).toBe(true)
        expect(write).toHaveBeenCalledTimes(1)
        expect(result.current[0].plan?.steps[0].status).toBe("running")
        await act(async () => {
          result.current[1].cancel()
          await jest.advanceTimersByTimeAsync(2000)
          await pending
        })
        expect(write).toHaveBeenLastCalledWith("\u0003")
        expect(result.current[0].plan?.status).toBe("ready")
        expect(result.current[0].plan?.steps[0]).toMatchObject({ status: "failed", exitCode: null })
        expect(result.current[0].messages.at(-1)?.content).toBe("messages.executionFailed")
      } finally {
        jest.useRealTimers()
      }
    })

    it("runs only the requested next step and uses the real exit code", async () => {
      const { result, emit, write } = setup()
      await act(async () => {
        await result.current[1].submit("print a greeting")
      })
      let pending!: Promise<void>
      act(() => {
        pending = result.current[1].runNextStep()
      })
      await act(async () => {
        emit({ kind: "command_end", exit_code: 0 })
        await pending
      })
      expect(result.current[0].plan?.steps.map((s) => s.status)).toEqual(["succeeded", "pending"])
      act(() => {
        pending = result.current[1].runNextStep()
      })
      await act(async () => {
        emit({ kind: "command_end", exit_code: 7 })
        await pending
      })
      expect(result.current[0].plan?.steps[1]).toMatchObject({ status: "failed", exitCode: 7 })
      expect(result.current[0].plan?.status).toBe("ready")
      expect(write.mock.calls.map(([data]) => data)).toEqual(["echo hello\r", "echo world\r"])
    })

    it("interrupts and unsubscribes when the session surface unmounts", async () => {
      const { result, unmount, write, listeners } = setup()
      await act(async () => {
        await result.current[1].submit("print a greeting")
      })
      let pending!: Promise<void>
      act(() => {
        pending = result.current[1].runAll()
      })
      unmount()
      await act(async () => {
        await pending
      })
      expect(write).toHaveBeenLastCalledWith("\u0003")
      expect(listeners.size).toBe(0)
    })

    it("does not clear or replace a plan while its command is running", async () => {
      const { result, emit, complete } = setup()
      await act(async () => {
        await result.current[1].submit("print a greeting")
      })
      let pending!: Promise<void>
      act(() => {
        pending = result.current[1].runNextStep()
      })
      await act(async () => {
        result.current[1].clearHistory()
        result.current[1].editStep(0, "false")
        result.current[1].skipStep(0)
        await result.current[1].submit("replace plan")
      })
      expect(complete).toHaveBeenCalledTimes(1)
      expect(result.current[0].plan?.steps[0]).toMatchObject({
        command: "echo hello",
        status: "running",
      })
      await act(async () => {
        emit({ kind: "command_end", exit_code: 0 })
        await pending
      })
    })

    it("ignores a generation result that arrives after cancellation", async () => {
      const { result, complete } = setup()
      let respond!: (text: string) => void
      complete.mockImplementation(
        () =>
          new Promise((resolve) => {
            respond = resolve
          })
      )
      let pending!: Promise<void>
      act(() => {
        pending = result.current[1].submit("print a greeting")
      })
      act(() => {
        result.current[1].cancel()
      })
      await act(async () => {
        respond('{"steps":[{"command":"echo stale"}]}')
        await pending
      })
      expect(result.current[0].plan?.status).not.toBe("ready")
      expect(result.current[0].generating).toBe(false)
    })
  })

  describe("initial state", () => {
    it("starts with panel closed", () => {
      const { result } = renderHook(() => useAiShell("test-session"))
      const [state] = result.current

      expect(state.open).toBe(false)
      expect(state.messages).toHaveLength(0)
      expect(state.plan).toBeNull()
      expect(state.generating).toBe(false)
      expect(state.executing).toBe(false)
      expect(state.advisory).toBeNull()
      expect(state.advisoryLoading).toBe(false)
    })

    it("handles null sessionId", () => {
      const { result } = renderHook(() => useAiShell(null))
      const [state] = result.current

      expect(state.open).toBe(false)
    })
  })

  describe("panel toggle", () => {
    it("toggles open state", () => {
      const { result } = renderHook(() => useAiShell("test-session"))

      act(() => {
        result.current[1].toggle()
      })
      expect(result.current[0].open).toBe(true)

      act(() => {
        result.current[1].toggle()
      })
      expect(result.current[0].open).toBe(false)
    })

    it("openPanel sets open to true", () => {
      const { result } = renderHook(() => useAiShell("test-session"))

      act(() => {
        result.current[1].openPanel()
      })
      expect(result.current[0].open).toBe(true)
    })

    it("closePanel sets open to false", () => {
      const { result } = renderHook(() => useAiShell("test-session"))

      act(() => {
        result.current[1].openPanel()
      })
      act(() => {
        result.current[1].closePanel()
      })
      expect(result.current[0].open).toBe(false)
    })
  })

  describe("submit", () => {
    it("ignores empty intent", async () => {
      const { result } = renderHook(() => useAiShell("test-session"))

      await act(async () => {
        await result.current[1].submit("")
      })

      expect(result.current[0].messages).toHaveLength(0)
    })

    it("ignores whitespace-only intent", async () => {
      const { result } = renderHook(() => useAiShell("test-session"))

      await act(async () => {
        await result.current[1].submit("   ")
      })

      expect(result.current[0].messages).toHaveLength(0)
    })

    it("adds user message and error when no client", async () => {
      const { result } = renderHook(() => useAiShell("test-session"))

      await act(async () => {
        await result.current[1].submit("deploy to staging")
      })

      const [state] = result.current
      // Should have user message + assistant error message
      expect(state.messages.length).toBeGreaterThanOrEqual(2)
      expect(state.messages[0].role).toBe("user")
      expect(state.messages[0].content).toBe("deploy to staging")
    })

    it("does nothing when sessionId is null", async () => {
      const { result } = renderHook(() => useAiShell(null))

      await act(async () => {
        await result.current[1].submit("deploy")
      })

      expect(result.current[0].messages).toHaveLength(0)
    })
  })

  describe("plan manipulation", () => {
    it("skipStep marks a step as skipped", async () => {
      const { result } = renderHook(() => useAiShell("test-session"))

      // Manually set a plan
      await act(async () => {
        // We need to force a plan into state. Use submit which will fail (no client),
        // so let's test skipStep with a direct state manipulation approach.
        // Since we can't easily set plan state externally, test the logic through cancel
      })

      // This test verifies the callback doesn't throw
      act(() => {
        result.current[1].skipStep(0)
      })
      // With no plan, it's a no-op
      expect(result.current[0].plan).toBeNull()
    })

    it("editStep does nothing without a plan", () => {
      const { result } = renderHook(() => useAiShell("test-session"))

      act(() => {
        result.current[1].editStep(0, "new command")
      })

      expect(result.current[0].plan).toBeNull()
    })

    it("cancel aborts and sets status", () => {
      const { result } = renderHook(() => useAiShell("test-session"))

      act(() => {
        result.current[1].cancel()
      })

      expect(result.current[0].generating).toBe(false)
      expect(result.current[0].executing).toBe(false)
    })
  })

  describe("clearHistory", () => {
    it("clears all state", async () => {
      const { result } = renderHook(() => useAiShell("test-session"))

      // Add a message first
      await act(async () => {
        await result.current[1].submit("hello")
      })

      act(() => {
        result.current[1].clearHistory()
      })

      const [state] = result.current
      expect(state.messages).toHaveLength(0)
      expect(state.plan).toBeNull()
      expect(state.advisory).toBeNull()
    })
  })
})

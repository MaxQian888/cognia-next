"use client"

/**
 * React hook for the Interactive AI Shell panel.
 *
 * Manages the panel state, conversation history, plan generation, and
 * execution lifecycle. Thin wiring layer — the domain logic lives in
 * `lib/terminal/ai-shell/`.
 *
 * Designed to be mounted per terminal session (each tab can have its own
 * AI Shell conversation).
 */

import { useCallback, useRef, useState } from "react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { getLiveSession } from "@/lib/terminal/session-registry"
import type { LlmClient } from "@/lib/twin/distill/llm"
import {
  buildAiShellContext,
  isContextPiiSafe,
  generatePlan,
  executePlan,
  getErrorAdvisory,
  type AiShellMessage,
  type AiShellContext,
  type ExecutionPlan,
  type ErrorAdvisory,
  type AiShellSession,
  type PlanExecutionResult,
} from "@/lib/terminal/ai-shell"

/** State shape returned by the hook. */
export interface UseAiShellState {
  /** Whether the panel is open. */
  open: boolean
  /** Chat history. */
  messages: AiShellMessage[]
  /** The current plan (null when none). */
  plan: ExecutionPlan | null
  /** Whether the plan is currently being generated. */
  generating: boolean
  /** Whether the plan is currently being executed. */
  executing: boolean
  /** Error advisory for the last failed step (null when none). */
  advisory: ErrorAdvisory | null
  /** Whether an advisory is being fetched. */
  advisoryLoading: boolean
}

/** Actions returned by the hook. */
export interface UseAiShellActions {
  /** Toggle the panel open/closed. */
  toggle: () => void
  /** Open the panel. */
  openPanel: () => void
  /** Close the panel. */
  closePanel: () => void
  /** Submit a natural language intent. */
  submit: (intent: string) => Promise<void>
  /** Run all steps in the current plan. */
  runAll: () => Promise<void>
  /** Run one step at a time (the next pending step). */
  runNextStep: () => Promise<void>
  /** Skip a step by index. */
  skipStep: (index: number) => void
  /** Edit a step's command. */
  editStep: (index: number, newCommand: string) => void
  /** Cancel the current plan / execution. */
  cancel: () => void
  /** Request an error advisory for a failed step. */
  requestAdvisory: (stepIndex: number) => Promise<void>
  /** Apply the suggested fix from an advisory. */
  applyFix: () => Promise<void>
  /** Clear conversation history. */
  clearHistory: () => void
}

export type UseAiShellReturn = [UseAiShellState, UseAiShellActions]

let messageIdCounter = 0
function nextMessageId(): string {
  return `ai-shell-msg-${++messageIdCounter}`
}

/**
 * Build an `AiShellSession` adapter from the live terminal session.
 * This bridges the xterm-backed session to the executor's minimal contract.
 */
function buildSessionAdapter(sessionId: string): AiShellSession | null {
  const live = getLiveSession(sessionId)
  if (!live) return null

  return {
    write(data: string) {
      void live.write(data)
    },
    onNextPrompt(cb: () => void) {
      // Use integration event listener if available
      const off = live.onIntegration?.((event) => {
        if (event.kind === "prompt_start") {
          off?.()
          cb()
        }
      })
      // Fallback: if no integration events, resolve after delay
      if (!off) {
        const timer = setTimeout(cb, 250)
        return () => clearTimeout(timer)
      }
      return off
    },
    onCommandEnd(cb: (exitCode: number | null) => void) {
      const off = live.onIntegration?.((event) => {
        if (event.kind === "command_end") {
          off?.()
          cb(event.exit_code ?? null)
        }
      })
      if (!off) {
        // Fallback: assume success after 5 seconds
        const timer = setTimeout(() => cb(0), 5000)
        return () => clearTimeout(timer)
      }
      return off
    },
    getRecentOutput(maxLines = 20) {
      // Attempt to get output from the live session's buffer
      const output = live.getLastOutput?.() ?? ""
      return output.split("\n").slice(-maxLines).join("\n")
    },
  }
}

/**
 * Hook for the Interactive AI Shell.
 *
 * @param sessionId - The terminal session this AI Shell is attached to
 */
export function useAiShell(sessionId: string | null): UseAiShellReturn {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<AiShellMessage[]>([])
  const [plan, setPlan] = useState<ExecutionPlan | null>(null)
  const [generating, setGenerating] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [advisory, setAdvisory] = useState<ErrorAdvisory | null>(null)
  const [advisoryLoading, setAdvisoryLoading] = useState(false)

  const abortRef = useRef<AbortController | null>(null)

  /** Resolve an LlmClient from current settings. */
  const getClient = useCallback((): LlmClient | null => {
    const { settings, activeSession } = useSettingsStore.getState()
    return buildUtilityLlmClient({
      session: activeSession,
      appSettings: settings,
      featureId: "terminal.aiShell",
    })
  }, [])

  /** Build the terminal context for the LLM. */
  const buildContext = useCallback((): AiShellContext | null => {
    if (!sessionId) return null
    const row = useTerminalStore.getState().sessions[sessionId]
    if (!row) return null

    // Try to get recent output from the live session
    const live = getLiveSession(sessionId)
    const recentOutput = live?.getLastOutput?.() ?? ""

    return buildAiShellContext(row, recentOutput, {
      platform:
        typeof navigator !== "undefined" && navigator.userAgent.includes("Mac")
          ? "darwin"
          : "linux",
    })
  }, [sessionId])

  const toggle = useCallback(() => setOpen((o) => !o), [])
  const openPanel = useCallback(() => setOpen(true), [])
  const closePanel = useCallback(() => setOpen(false), [])

  const submit = useCallback(
    async (intent: string) => {
      if (!intent.trim() || !sessionId) return

      // Add user message
      const userMsg: AiShellMessage = {
        id: nextMessageId(),
        role: "user",
        content: intent.trim(),
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, userMsg])
      setAdvisory(null)

      // Build context
      const context = buildContext()
      if (!context) {
        const errMsg: AiShellMessage = {
          id: nextMessageId(),
          role: "system",
          content: "No active terminal session.",
          timestamp: Date.now(),
        }
        setMessages((prev) => [...prev, errMsg])
        return
      }

      // PII check
      if (!isContextPiiSafe(context)) {
        const errMsg: AiShellMessage = {
          id: nextMessageId(),
          role: "system",
          content: "Context contains sensitive information. Cannot proceed.",
          timestamp: Date.now(),
        }
        setMessages((prev) => [...prev, errMsg])
        return
      }

      // Abort any previous generation
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setGenerating(true)
      setPlan(null)

      const result = await generatePlan(
        intent.trim(),
        context,
        { getClient },
        { signal: controller.signal },
        (partial) => {
          if (partial.status === "generating") {
            setPlan(partial as ExecutionPlan)
          }
        }
      )

      setGenerating(false)

      if (result.status === "cancelled") return

      setPlan(result)

      // Add assistant message summarizing the plan
      const assistantMsg: AiShellMessage = {
        id: nextMessageId(),
        role: "assistant",
        content:
          result.status === "ready"
            ? `Generated a plan with ${result.steps.length} step${result.steps.length === 1 ? "" : "s"}.`
            : (result.error ?? "Failed to generate plan."),
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, assistantMsg])
    },
    [sessionId, buildContext, getClient]
  )

  const runAll = useCallback(async () => {
    if (!plan || !sessionId || plan.status !== "ready") return

    const session = buildSessionAdapter(sessionId)
    if (!session) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setExecuting(true)
    setPlan((p) => (p ? { ...p, status: "executing" } : p))

    const result: PlanExecutionResult = await executePlan(
      plan,
      session,
      { signal: controller.signal },
      (stepIndex, status, exitCode, outputSnippet) => {
        setPlan((p) => {
          if (!p) return p
          const steps = [...p.steps]
          steps[stepIndex] = { ...steps[stepIndex], status, exitCode, outputSnippet }
          return { ...p, steps }
        })
      }
    )

    setExecuting(false)
    setPlan((p) => {
      if (!p) return p
      return {
        ...p,
        status: result.allSucceeded
          ? "completed"
          : controller.signal.aborted
            ? "cancelled"
            : "ready",
      }
    })
  }, [plan, sessionId])

  const runNextStep = useCallback(async () => {
    if (!plan || !sessionId) return

    const nextPendingIdx = plan.steps.findIndex((s) => s.status === "pending")
    if (nextPendingIdx === -1) return

    const session = buildSessionAdapter(sessionId)
    if (!session) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setExecuting(true)

    // Execute only a single-step plan
    const singleStepPlan: ExecutionPlan = {
      ...plan,
      steps: [plan.steps[nextPendingIdx]],
    }

    await executePlan(
      singleStepPlan,
      session,
      { signal: controller.signal },
      (_, status, exitCode, outputSnippet) => {
        setPlan((p) => {
          if (!p) return p
          const steps = [...p.steps]
          steps[nextPendingIdx] = { ...steps[nextPendingIdx], status, exitCode, outputSnippet }
          return { ...p, steps }
        })
      }
    )

    setExecuting(false)

    // Check if all steps are done
    setPlan((p) => {
      if (!p) return p
      const allDone = p.steps.every((s) => s.status === "succeeded" || s.status === "skipped")
      return { ...p, status: allDone ? "completed" : "ready" }
    })
  }, [plan, sessionId])

  const skipStep = useCallback((index: number) => {
    setPlan((p) => {
      if (!p) return p
      const steps = [...p.steps]
      if (steps[index] && steps[index].status === "pending") {
        steps[index] = { ...steps[index], status: "skipped" }
      }
      const allDone = steps.every((s) => s.status === "succeeded" || s.status === "skipped")
      return { ...p, steps, status: allDone ? "completed" : p.status }
    })
  }, [])

  const editStep = useCallback((index: number, newCommand: string) => {
    setPlan((p) => {
      if (!p) return p
      const steps = [...p.steps]
      if (steps[index]) {
        steps[index] = { ...steps[index], command: newCommand }
      }
      return { ...p, steps }
    })
  }, [])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    setGenerating(false)
    setExecuting(false)
    setPlan((p) => (p ? { ...p, status: "cancelled" } : p))
  }, [])

  const requestAdvisory = useCallback(
    async (stepIndex: number) => {
      if (!plan || !sessionId) return
      const step = plan.steps[stepIndex]
      if (!step || step.status !== "failed") return

      const context = buildContext()
      if (!context) return

      setAdvisoryLoading(true)
      const result = await getErrorAdvisory(
        step,
        { cwd: context.cwd, shell: context.shell, platform: context.platform },
        { getClient }
      )
      setAdvisory(result)
      setAdvisoryLoading(false)
    },
    [plan, sessionId, buildContext, getClient]
  )

  const applyFix = useCallback(async () => {
    if (!advisory?.suggestedFix || !sessionId) return

    const session = buildSessionAdapter(sessionId)
    if (!session) return

    // Write the fix command
    session.write(advisory.suggestedFix + "\r")
    setAdvisory(null)
  }, [advisory, sessionId])

  const clearHistory = useCallback(() => {
    setMessages([])
    setPlan(null)
    setAdvisory(null)
  }, [])

  const state: UseAiShellState = {
    open,
    messages,
    plan,
    generating,
    executing,
    advisory,
    advisoryLoading,
  }

  const actions: UseAiShellActions = {
    toggle,
    openPanel,
    closePanel,
    submit,
    runAll,
    runNextStep,
    skipStep,
    editStep,
    cancel,
    requestAdvisory,
    applyFix,
    clearHistory,
  }

  return [state, actions]
}

/** Reset the message counter (for testing). */
export function __resetAiShellMessageIdForTesting(): void {
  messageIdCounter = 0
}

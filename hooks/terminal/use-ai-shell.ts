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

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
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
  executeStep,
  getErrorAdvisory,
  type AiShellMessage,
  type AiShellContext,
  type ExecutionPlan,
  type ErrorAdvisory,
  type AiShellSession,
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
// A session can outlive its keyed React surface. Preserve an execution lease
// across tab switches, including an unacknowledged interrupt, until real shell
// readiness/exit or a replacement live connection establishes recovery.
const activeAiShellSessions = new WeakSet<object>()
const unconfirmedAiShellSessions = new WeakSet<object>()
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
      if (data !== "\u0003") {
        if (activeAiShellSessions.has(live))
          return Promise.reject(new Error("AI Shell session is busy"))
        activeAiShellSessions.add(live)
        unconfirmedAiShellSessions.delete(live)
        const recover = () => {
          activeAiShellSessions.delete(live)
          unconfirmedAiShellSessions.delete(live)
          offIntegration?.()
          offExit?.()
        }
        const offIntegration = live.onIntegration?.((event) => {
          if (
            event.kind === "command_end" ||
            (event.kind === "prompt_start" && unconfirmedAiShellSessions.has(live))
          )
            recover()
        })
        const offExit = live.onExit?.(recover)
      }
      return live.write(data)
    },
    onNextPrompt(cb: () => void) {
      return (
        live.onIntegration?.((event) => {
          if (event.kind === "prompt_start") cb()
        }) ?? (() => undefined)
      )
    },
    onCommandEnd(cb: (exitCode: number | null) => void) {
      // No timer can prove a command succeeded. The executor fails with an
      // unknown exit code if shell integration never reports completion.
      const offIntegration = live.onIntegration?.((event) => {
        if (event.kind === "command_end") cb(event.exit_code ?? null)
      })
      const offExit = live.onExit?.(() => cb(null))
      return () => {
        offIntegration?.()
        offExit?.()
      }
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
  const t = useTranslations("terminal.aiShell")
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<AiShellMessage[]>([])
  const [plan, setPlan] = useState<ExecutionPlan | null>(null)
  const [generating, setGenerating] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [advisory, setAdvisory] = useState<ErrorAdvisory | null>(null)
  const [advisoryLoading, setAdvisoryLoading] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    return () => {
      const controller = abortRef.current
      abortRef.current = null
      controller?.abort()
    }
  }, [sessionId])

  const reportError = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: nextMessageId(),
        role: "system",
        content,
        timestamp: Date.now(),
      },
    ])
  }, [])

  /** Resolve an LlmClient from current settings. */
  const getClient = useCallback((): LlmClient | null => {
    const { settings } = useSettingsStore.getState()
    return buildUtilityLlmClient({
      session: null,
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

    return buildAiShellContext(row, recentOutput)
  }, [sessionId])

  const toggle = useCallback(() => setOpen((o) => !o), [])
  const openPanel = useCallback(() => setOpen(true), [])
  const closePanel = useCallback(() => setOpen(false), [])

  const submit = useCallback(
    async (intent: string) => {
      if (!intent.trim() || !sessionId || abortRef.current) return

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
          content: t("messages.noSession"),
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
          content: t("messages.sensitiveContext"),
          timestamp: Date.now(),
        }
        setMessages((prev) => [...prev, errMsg])
        return
      }

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
          if (
            abortRef.current === controller &&
            !controller.signal.aborted &&
            partial.status === "generating"
          ) {
            setPlan(partial as ExecutionPlan)
          }
        }
      )

      if (abortRef.current !== controller) return
      abortRef.current = null
      setGenerating(false)

      if (controller.signal.aborted || result.status === "cancelled") return

      setPlan(result)

      // Add assistant message summarizing the plan
      const assistantMsg: AiShellMessage = {
        id: nextMessageId(),
        role: "assistant",
        content:
          result.status === "ready"
            ? t("messages.generatedPlan", { count: result.steps.length })
            : t("messages.generationFailed"),
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, assistantMsg])
    },
    [sessionId, buildContext, getClient, t]
  )

  const runSteps = useCallback(
    async (single: boolean) => {
      if (!plan || !sessionId || plan.status !== "ready" || abortRef.current) return
      const live = getLiveSession(sessionId)
      if (live && activeAiShellSessions.has(live)) {
        reportError(t("messages.executionFailed"))
        return
      }
      const row = useTerminalStore.getState().sessions[sessionId]
      const session = buildSessionAdapter(sessionId)
      if (!row || row.kind === "serial" || row.status === "exited" || !session) {
        reportError(t("messages.terminalUnavailable"))
        return
      }
      if (row.status === "running") {
        reportError(t("messages.terminalBusy"))
        return
      }
      const nextStep = plan.steps.find((s) => s.status === "pending" || s.status === "failed")
      if (!nextStep) return
      const controller = new AbortController()
      abortRef.current = controller
      setExecuting(true)
      setAdvisory(null)
      setPlan((p) => (p ? { ...p, status: "executing" } : p))

      const result = await executePlan(
        single ? { ...plan, steps: [nextStep] } : plan,
        session,
        { signal: controller.signal },
        (stepIndex, status, exitCode, outputSnippet) => {
          if (abortRef.current !== controller) return
          setPlan((p) => {
            if (!p) return p
            const steps = p.steps.map((step) =>
              step.index === stepIndex ? { ...step, status, exitCode, outputSnippet } : step
            )
            return { ...p, steps }
          })
        }
      )
      if (live && activeAiShellSessions.has(live) && result.steps.some((s) => s.unconfirmed)) {
        unconfirmedAiShellSessions.add(live)
      }
      if (abortRef.current !== controller) return
      abortRef.current = null
      setExecuting(false)
      setPlan((p) => {
        if (!p) return p
        const allDone = p.steps.every((s) => s.status === "succeeded" || s.status === "skipped")
        return {
          ...p,
          status: result.steps.some((s) => s.status === "failed")
            ? "ready"
            : controller.signal.aborted
              ? "cancelled"
              : allDone
                ? "completed"
                : "ready",
        }
      })
      if (result.steps.some((s) => s.status === "failed" && s.exitCode === null)) {
        reportError(t("messages.executionFailed"))
      }
    },
    [plan, sessionId, reportError, t]
  )

  const runAll = useCallback(() => runSteps(false), [runSteps])
  const runNextStep = useCallback(() => runSteps(true), [runSteps])

  const skipStep = useCallback((index: number) => {
    if (abortRef.current) return
    setPlan((p) => {
      if (!p) return p
      const steps = [...p.steps]
      if (steps[index] && (steps[index].status === "pending" || steps[index].status === "failed")) {
        steps[index] = { ...steps[index], status: "skipped" }
      }
      const allDone = steps.every((s) => s.status === "succeeded" || s.status === "skipped")
      return { ...p, steps, status: allDone ? "completed" : p.status }
    })
  }, [])

  const editStep = useCallback((index: number, newCommand: string) => {
    if (abortRef.current || !newCommand.trim()) return
    setPlan((p) => {
      if (!p) return p
      const steps = [...p.steps]
      if (steps[index] && (steps[index].status === "pending" || steps[index].status === "failed")) {
        steps[index] = {
          ...steps[index],
          command: newCommand.trim(),
          status: "pending",
          exitCode: null,
          outputSnippet: null,
        }
      }
      return { ...p, steps }
    })
  }, [])

  const cancel = useCallback(() => {
    const controller = abortRef.current
    // Keep execution locked until the executor has sent the interrupt.
    if (!executing) {
      abortRef.current = null
      setGenerating(false)
      setAdvisoryLoading(false)
      setPlan((p) => (p ? { ...p, status: "cancelled" } : p))
    }
    controller?.abort()
  }, [executing])

  const requestAdvisory = useCallback(
    async (stepIndex: number) => {
      if (!plan || !sessionId || abortRef.current) return
      const step = plan.steps[stepIndex]
      if (!step || step.status !== "failed") return

      const context = buildContext()
      if (!context) return

      const controller = new AbortController()
      abortRef.current = controller
      setAdvisoryLoading(true)
      const result = await getErrorAdvisory(
        step,
        { cwd: context.cwd, shell: context.shell, platform: context.platform },
        { getClient },
        controller.signal
      )
      if (abortRef.current !== controller) return
      abortRef.current = null
      if (!controller.signal.aborted) setAdvisory(result)
      setAdvisoryLoading(false)
    },
    [plan, sessionId, buildContext, getClient]
  )

  const applyFix = useCallback(async () => {
    if (!advisory?.suggestedFix || !sessionId || !plan || abortRef.current) return
    const live = getLiveSession(sessionId)
    if (live && activeAiShellSessions.has(live)) {
      reportError(t("messages.executionFailed"))
      return
    }
    const session = buildSessionAdapter(sessionId)
    const row = useTerminalStore.getState().sessions[sessionId]
    if (!session || !row || row.kind === "serial" || row.status === "exited") {
      reportError(t("messages.terminalUnavailable"))
      return
    }
    if (row.status === "running") {
      reportError(t("messages.terminalBusy"))
      return
    }
    const step = plan.steps[advisory.stepIndex]
    if (!step || step.status !== "failed") return
    const controller = new AbortController()
    abortRef.current = controller
    setExecuting(true)
    const result = await executeStep({ ...step, command: advisory.suggestedFix }, session, {
      signal: controller.signal,
    })
    if (live && activeAiShellSessions.has(live) && result.unconfirmed) {
      unconfirmedAiShellSessions.add(live)
    }
    if (abortRef.current !== controller) return
    abortRef.current = null
    setExecuting(false)
    if (result.status === "succeeded") {
      setAdvisory(null)
      setPlan((p) => {
        if (!p) return p
        const steps = p.steps.map<ExecutionPlan["steps"][number]>((s) =>
          s.index === step.index
            ? advisory.retryAfterFix
              ? { ...s, status: "pending", exitCode: null, outputSnippet: null }
              : {
                  ...s,
                  command: advisory.suggestedFix!,
                  status: "succeeded",
                  exitCode: 0,
                  outputSnippet: null,
                }
            : s
        )
        return {
          ...p,
          steps,
          status: steps.every((s) => s.status === "succeeded" || s.status === "skipped")
            ? "completed"
            : "ready",
        }
      })
    } else if (result.status === "cancelled") {
      setPlan((p) => (p ? { ...p, status: "cancelled" } : p))
    } else {
      reportError(t("messages.executionFailed"))
    }
  }, [advisory, sessionId, plan, reportError, t])

  const clearHistory = useCallback(() => {
    if (abortRef.current) return
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

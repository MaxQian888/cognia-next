"use client"

/**
 * Running a Canvas document.
 *
 * Two things were missing. Stop aborted an `AbortController` that only the
 * renderer could see, so a Python run detached from the UI and kept going to
 * its 30s timeout: the run now carries an id the host can kill by. And the
 * whole of Settings → Canvas → Execution had no reader, so the timeout, the
 * clear-on-run switch and the rest were controls that did nothing. They are
 * read here, which is the only place they can mean anything.
 */

import { useCallback, useRef, useState } from "react"
import { nanoid } from "nanoid"
import {
  codeExecutionAvailability,
  executeCodeWithSandboxPriority,
  type CodeExecutionUnavailableReason,
  type UnifiedCodeExecutionResult,
} from "@/lib/native/code-execution-strategy"
import { useNativeStore } from "@/stores"
import { useSettingsStore } from "@/stores/settings"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { loggers } from "@cognia/logging"

export interface ExecutionOptions {
  timeout?: number
  stdin?: string
  language?: string
  /**
   * Localized fallback message used when the sandbox throws a non-`Error`
   * value. Pass `t("canvas.executionFailedDefault")` from a component;
   * outside React the default English string is used.
   */
  errorMessageFallback?: string
}

interface UseCodeExecutionReturn {
  isExecuting: boolean
  result: CodeSandboxExecutionResult | null
  error: string | null
  execute: (
    code: string,
    language: string,
    options?: ExecutionOptions
  ) => Promise<CodeSandboxExecutionResult>
  cancel: () => void
  clear: () => void
  /** Whether the output pane should be shown at all (a Settings preference). */
  showOutput: boolean
  /**
   * Whether this host can run this language. Asked BEFORE the click, so Run can
   * be disabled with a reason instead of failing on press with
   * `sandbox: "unsupported"`.
   */
  availabilityFor: (language: string | undefined) => {
    available: boolean
    reason: CodeExecutionUnavailableReason | null
  }
}

export type CodeSandboxExecutionResult = UnifiedCodeExecutionResult

export function useCodeExecution(): UseCodeExecutionReturn {
  const [isExecuting, setIsExecuting] = useState(false)
  const [result, setResult] = useState<CodeSandboxExecutionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const isDesktop = useNativeStore((state) => state.isDesktop)
  // Settings → Canvas → Execution. Every one of these had a control and no
  // reader before this.
  const execution = useCanvasSettingsStore((s) => s.settings.execution)
  // ADR-0028 — Canvas Python executes through the OS sandbox backend rather
  // than a bare interpreter. Confined by DEFAULT (independent of the chat-tool
  // `sandboxDefaultEnabled` flag); a user can opt out in Settings → Sandbox.
  // JS/HTML/CSS are unaffected (already iframe-confined).
  const sandboxEnabled = useSettingsStore((s) => s.settings?.canvasCodeSandboxEnabled ?? true)

  const execute = useCallback(
    async (
      code: string,
      language: string,
      options: ExecutionOptions = {}
    ): Promise<CodeSandboxExecutionResult> => {
      setIsExecuting(true)
      setError(null)
      // "Clear output on run" — the panel's Clear button was the only thing
      // that ever called `clear()`.
      if (execution.clearOutputOnRun) setResult(null)
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      // The host needs a name for this run to be able to kill it.
      const runId = nanoid()

      try {
        const execResult = await executeCodeWithSandboxPriority({
          code,
          language,
          isDesktop,
          stdin: options.stdin,
          // An explicit per-call timeout still wins, but the settings value is
          // the default now rather than the hardcoded 30s in the strategy.
          timeoutMs: options.timeout ?? execution.maxExecutionTime,
          signal: controller.signal,
          sandboxed: sandboxEnabled,
          runId,
        })

        if (!controller.signal.aborted) {
          setResult(execResult)
        }

        return execResult
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : (options.errorMessageFallback ?? "Execution failed")
        loggers.canvas.error("code execution failed", {
          language,
          error: errorMessage,
        })
        setError(errorMessage)

        const errorResult: CodeSandboxExecutionResult = {
          success: false,
          sandbox: "unsupported",
          stdout: "",
          stderr: errorMessage,
          exitCode: 1,
          durationMs: 0,
          executionTime: 0,
          language,
        }
        setResult(errorResult)
        return errorResult
      } finally {
        if (!controller.signal.aborted) {
          setIsExecuting(false)
        }
        if (abortRef.current === controller) abortRef.current = null
      }
    },
    [execution.clearOutputOnRun, execution.maxExecutionTime, isDesktop, sandboxEnabled]
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsExecuting(false)
  }, [])

  const clear = useCallback(() => {
    setResult(null)
    setError(null)
  }, [])

  const availabilityFor = useCallback(
    (language: string | undefined) => codeExecutionAvailability(language, isDesktop),
    [isDesktop]
  )

  return {
    isExecuting,
    result,
    error,
    execute,
    cancel,
    clear,
    showOutput: execution.showOutput,
    availabilityFor,
  }
}

export default useCodeExecution

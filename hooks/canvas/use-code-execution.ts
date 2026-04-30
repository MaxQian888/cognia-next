"use client"

/**
 * useCodeExecution - Hook for executing code in Canvas
 * Strategy: desktop sandbox first, browser fallback, simulation fallback.
 */

import { useCallback, useRef, useState } from "react"
import {
  executeCodeWithSandboxPriority,
  type UnifiedCodeExecutionResult,
} from "@/lib/native/code-execution-strategy"
import { useNativeStore } from "@/stores"
import { loggers } from "@/lib/logger"

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
}

export type CodeSandboxExecutionResult = UnifiedCodeExecutionResult

export function useCodeExecution(): UseCodeExecutionReturn {
  const [isExecuting, setIsExecuting] = useState(false)
  const [result, setResult] = useState<CodeSandboxExecutionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef(false)

  const isDesktop = useNativeStore((state) => state.isDesktop)

  const execute = useCallback(
    async (
      code: string,
      language: string,
      options: ExecutionOptions = {}
    ): Promise<CodeSandboxExecutionResult> => {
      setIsExecuting(true)
      setError(null)
      abortRef.current = false

      try {
        const execResult = await executeCodeWithSandboxPriority({
          code,
          language,
          isDesktop,
          stdin: options.stdin,
        })

        if (!abortRef.current) {
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
        if (!abortRef.current) {
          setIsExecuting(false)
        }
      }
    },
    [isDesktop]
  )

  const cancel = useCallback(() => {
    abortRef.current = true
    setIsExecuting(false)
  }, [])

  const clear = useCallback(() => {
    setResult(null)
    setError(null)
  }, [])

  return {
    isExecuting,
    result,
    error,
    execute,
    cancel,
    clear,
  }
}

export default useCodeExecution

"use client"

import { useCallback, useState } from "react"

function actionErrorDetail(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "detail" in cause) {
    const detail = (cause as { detail?: unknown }).detail
    if (typeof detail === "string") return detail
  }
  return String(cause)
}

/** Shared pending/error lifecycle for workspace inventory and session actions. */
export function useWorkspaceActionController() {
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => setError(null), [])

  const run = useCallback(async <T>(key: string, operation: () => Promise<T>) => {
    setPendingKey(key)
    setError(null)
    try {
      return await operation()
    } catch (cause) {
      setError(actionErrorDetail(cause))
      return undefined
    } finally {
      setPendingKey(null)
    }
  }, [])

  return {
    pendingKey,
    busy: pendingKey !== null,
    error,
    setError,
    clearError,
    run,
  }
}

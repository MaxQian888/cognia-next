"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"

import { HostConsentRequiredError } from "@/lib/tauri/admin-lease"
import { WorkspaceOperationUnavailableError } from "@/lib/task-workspace/user-action"
import { AVAILABILITY_MESSAGE_KEY } from "@/lib/workspace/availability-messages"

function rawDetail(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "detail" in cause) {
    const detail = (cause as { detail?: unknown }).detail
    if (typeof detail === "string") return detail
  }
  return String(cause)
}

/** Shared pending/error lifecycle for workspace inventory and session actions. */
export function useWorkspaceActionController() {
  const t = useTranslations("workspace.actionErrors")
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => setError(null), [])

  /**
   * Turn a thrown cause into something the user can act on.
   *
   * The two cases worth naming are the ones the raw message handles worst.
   * A consent refusal reads as a permission error when the real answer is
   * "approve it on the host, here is the code", and an unavailability refusal
   * arrives as a state name with no indication of which grant is missing.
   */
  const describe = useCallback(
    (cause: unknown): string => {
      if (cause instanceof HostConsentRequiredError) {
        return cause.consentCode
          ? t("consentRequired", { code: cause.consentCode })
          : t("consentRequiredNoCode")
      }
      if (cause instanceof WorkspaceOperationUnavailableError) {
        const { state, requiredGrant } = cause.availability
        return t(AVAILABILITY_MESSAGE_KEY[state], { grant: requiredGrant ?? "" })
      }
      return rawDetail(cause)
    },
    [t]
  )

  const run = useCallback(
    async <T>(key: string, operation: () => Promise<T>) => {
      setPendingKey(key)
      setError(null)
      try {
        return await operation()
      } catch (cause) {
        setError(describe(cause))
        return undefined
      } finally {
        setPendingKey(null)
      }
    },
    [describe]
  )

  return {
    pendingKey,
    busy: pendingKey !== null,
    error,
    setError,
    clearError,
    describe,
    run,
  }
}

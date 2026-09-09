"use client"

/**
 * Batch connection verification for the provider list.
 *
 * Owns the whole operation: which providers are eligible, which previously
 * failed, the sequential run itself, its progress counters, and cancellation.
 * `provider-settings.tsx` held all of that inline, where the four id memos sat
 * two hundred lines away from the runner that was their only consumer.
 *
 * The run is deliberately sequential rather than parallel. Each job is a real
 * request against a third-party endpoint, and firing forty of them at once is
 * how you get rate-limited by the provider you are trying to verify.
 */

import { useCallback, useMemo, useRef, useState } from "react"

import type { UseProviderSettingsResult } from "@/hooks/settings/use-provider-settings"

import {
  getVisibleEligibleBuiltInProviderIds,
  getVisibleEligibleCustomProviderIds,
  getVisibleRetryFailedBuiltInProviderIds,
  getVisibleRetryFailedCustomProviderIds,
} from "./provider-readiness"

export type BatchOperationType = "verify-enabled" | "retry-failed"

export interface BatchVerificationState {
  isRunning: boolean
  /**
   * Set the moment the user asks to stop, so the cancel button can disable
   * itself while the in-flight request finishes. Distinct from `canceled`,
   * which records how the finished run ended.
   */
  cancelRequested: boolean
  total: number
  completed: number
  success: number
  failed: number
  canceled: boolean
}

const IDLE: BatchVerificationState = {
  isRunning: false,
  cancelRequested: false,
  total: 0,
  completed: 0,
  success: 0,
  failed: 0,
  canceled: false,
}

export interface UseProviderBatchVerifyResult {
  /** How many enabled providers a "verify enabled" run would test. */
  eligibleCount: number
  /** How many previously failed providers a "retry failed" run would test. */
  retryCount: number
  verification: BatchVerificationState
  /** Which of the two runs produced the currently displayed summary. */
  operationType: BatchOperationType
  runVerifyEnabled: () => Promise<void>
  runRetryFailed: () => Promise<void>
  cancel: () => void
}

export function useProviderBatchVerify(
  settings: UseProviderSettingsResult
): UseProviderBatchVerifyResult {
  const {
    filteredProviders,
    providerSettings,
    testResults,
    visibleCustomProviderIds,
    customProviders,
    customTestResults,
    testProvider,
    testCustomProvider,
  } = settings

  const [verification, setVerification] = useState<BatchVerificationState>(IDLE)
  const [operationType, setOperationType] = useState<BatchOperationType>("verify-enabled")
  // A ref, not state: the loop below reads it between awaits, and a state read
  // there would be the value captured when the run started.
  const cancelRequested = useRef(false)

  const visibleBuiltInIds = useMemo(
    () => filteredProviders.map(([providerId]) => providerId),
    [filteredProviders]
  )

  const eligibleBuiltInIds = useMemo(
    () => getVisibleEligibleBuiltInProviderIds(visibleBuiltInIds, providerSettings, testResults),
    [visibleBuiltInIds, providerSettings, testResults]
  )
  const eligibleCustomIds = useMemo(
    () =>
      getVisibleEligibleCustomProviderIds(
        visibleCustomProviderIds,
        customProviders,
        customTestResults
      ),
    [visibleCustomProviderIds, customProviders, customTestResults]
  )
  // "Retry failed" reuses the readiness helpers that already existed for it.
  // Nothing called them until the retry button was wired up.
  const retryBuiltInIds = useMemo(
    () => getVisibleRetryFailedBuiltInProviderIds(visibleBuiltInIds, providerSettings, testResults),
    [visibleBuiltInIds, providerSettings, testResults]
  )
  const retryCustomIds = useMemo(
    () =>
      getVisibleRetryFailedCustomProviderIds(
        visibleCustomProviderIds,
        customProviders,
        customTestResults
      ),
    [visibleCustomProviderIds, customProviders, customTestResults]
  )

  const isRunning = verification.isRunning

  const runBatch = useCallback(
    async (
      nextOperationType: BatchOperationType,
      builtInIds: readonly string[],
      customIds: readonly string[]
    ) => {
      const total = builtInIds.length + customIds.length
      if (isRunning || total === 0) return
      cancelRequested.current = false
      setOperationType(nextOperationType)
      setVerification({ ...IDLE, isRunning: true, total })

      const jobs = [
        ...builtInIds.map((providerId) => () => testProvider(providerId)),
        ...customIds.map((providerId) => () => testCustomProvider(providerId)),
      ]

      let completed = 0
      let success = 0
      let failed = 0
      for (const run of jobs) {
        if (cancelRequested.current) break
        const result = await run()
        completed += 1
        if (result?.success) success += 1
        else failed += 1
        setVerification((current) => ({ ...current, completed, success, failed }))
      }

      setVerification((current) => ({
        ...current,
        isRunning: false,
        completed,
        success,
        failed,
        canceled: cancelRequested.current,
      }))
    },
    [isRunning, testCustomProvider, testProvider]
  )

  const runVerifyEnabled = useCallback(
    () => runBatch("verify-enabled", eligibleBuiltInIds, eligibleCustomIds),
    [eligibleBuiltInIds, eligibleCustomIds, runBatch]
  )
  const runRetryFailed = useCallback(
    () => runBatch("retry-failed", retryBuiltInIds, retryCustomIds),
    [retryBuiltInIds, retryCustomIds, runBatch]
  )
  const cancel = useCallback(() => {
    cancelRequested.current = true
    setVerification((current) => ({ ...current, cancelRequested: true }))
  }, [])

  return {
    eligibleCount: eligibleBuiltInIds.length + eligibleCustomIds.length,
    retryCount: retryBuiltInIds.length + retryCustomIds.length,
    verification,
    operationType,
    runVerifyEnabled,
    runRetryFailed,
    cancel,
  }
}

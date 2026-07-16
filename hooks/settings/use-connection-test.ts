"use client"

// Shared "test connection" state machine for provider settings dialogs.
// `QuickAddProviderDialog` and `CustomProviderDialog` each used to hand-roll
// their own `testing`/`testResult` state around
// `testCustomProviderConnectionByProtocol`, collapsing the richer
// `ApiTestResult` (latency, message, the "limited" outcome) down to a bare
// `"success" | "error"` string. This hook centralizes that so both surfaces
// show consistent detail and the AI SDK's the "limited" outcome isn't lost.

import { useCallback, useState } from "react"
import type { ApiProtocol } from "@cognia/provider-types"
import {
  testCustomProviderConnectionByProtocol,
  type ApiTestResult,
} from "@/lib/ai/infrastructure/api-test"

export interface UseConnectionTestResult {
  testing: boolean
  result: ApiTestResult | null
  /**
   * Run the test; also returns the result for callers that need it inline.
   * `model` is required by Anthropic-wire hosts, which probe with a real
   * request — omitting it falls back to a Claude model that only Anthropic has.
   */
  test: (
    baseURL: string,
    apiKey: string,
    protocol: ApiProtocol,
    model?: string
  ) => Promise<ApiTestResult>
  /** Clear the last result — call on any field edit so a stale badge doesn't linger. */
  reset: () => void
}

export function useConnectionTest(): UseConnectionTestResult {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ApiTestResult | null>(null)

  const test = useCallback(
    async (baseURL: string, apiKey: string, protocol: ApiProtocol, model?: string) => {
      setTesting(true)
      setResult(null)
      const r = await testCustomProviderConnectionByProtocol(baseURL, apiKey, protocol, model)
      setResult(r)
      setTesting(false)
      return r
    },
    []
  )

  const reset = useCallback(() => setResult(null), [])

  return { testing, result, test, reset }
}

"use client"

/**
 * cognia-next adapter for the Cognia provider hook.
 *
 * Cognia's `useProviderSettings` is 838 lines and pulls in the MCP
 * store, coding-package gating, batch verification, and routing
 * presets. cognia-next deferred the reliability/routing infrastructure
 * per the provider port plan, so we expose a slimmer hook that:
 *   - reads the rich `UserProviderSettings` map from `useSettingsStore`
 *   - exposes connection-test state in memory (not persisted)
 *   - exposes selected-provider id as a piece of UI state
 *   - delegates create / update / delete to the existing store actions
 *
 * Component imports that point at this path resolve to this hook.
 * Components that need fields the hook doesn't expose either:
 *   1. Get a sensible default (e.g., empty array, no-op callback), or
 *   2. Are skipped from the new `provider-settings.tsx` root.
 */

import { useCallback, useMemo, useState } from "react"
import { useSettingsStore } from "@/stores/settings"
import { PROVIDERS } from "@/types/provider/provider"
import type {
  CustomModelMetadata,
  CustomProviderSettings,
  ProviderUIPreferences,
  UserProviderSettings,
} from "@/types/provider/provider"
import {
  testCustomProviderConnectionByProtocol,
  testProviderConnection,
  type ApiTestResult,
} from "@/lib/ai/providers/api-test"

export interface UseProviderSettingsResult {
  // ---------------------------------------------------------------------------
  // Data sources
  // ---------------------------------------------------------------------------
  providerSettings: Record<string, UserProviderSettings>
  customProviders: Record<string, CustomProviderSettings>
  defaultProvider: string
  uiPreferences: ProviderUIPreferences
  testResults: Record<string, ApiTestResult | null>
  customTestResults: Record<string, "success" | "error" | "limited" | null>
  customTestMessages: Record<string, string | null>
  testingProviders: Record<string, boolean>
  testingCustomProviders: Record<string, boolean>
  selectedProviderId: string | null

  // ---------------------------------------------------------------------------
  // Mutations (delegate to the settings store)
  // ---------------------------------------------------------------------------
  setSelectedProviderId: (id: string | null) => void
  updateProviderSettings: (id: string, patch: Partial<UserProviderSettings>) => Promise<void>
  updateCustomProvider: (id: string, patch: Partial<CustomProviderSettings>) => Promise<void>
  removeCustomProvider: (id: string) => Promise<void>
  setDefaultProvider: (id: string) => Promise<void>

  // ---------------------------------------------------------------------------
  // Connection tests
  // ---------------------------------------------------------------------------
  testProvider: (id: string) => Promise<ApiTestResult | null>
  testCustomProvider: (id: string) => Promise<ApiTestResult | null>

  // ---------------------------------------------------------------------------
  // Lists (sorted / filtered for the sidebar)
  // ---------------------------------------------------------------------------
  filteredProviders: Array<[string, (typeof PROVIDERS)[string]]>
  visibleCustomProviderIds: string[]
}

export function useProviderSettings(): UseProviderSettingsResult {
  const settings = useSettingsStore((s) => s.settings)
  const setProviderConfig = useSettingsStore((s) => s.setProviderConfig)
  const setStoreDefaultProvider = useSettingsStore((s) => s.setDefaultProvider)
  const upsertCustomProviderStore = useSettingsStore((s) => s.upsertCustomProvider)
  const removeCustomProviderStore = useSettingsStore((s) => s.removeCustomProvider)

  const providerSettings = settings?.providerSettings ?? {}
  const customProvidersList = settings?.customProviders ?? []
  const defaultProvider = settings?.defaultProvider ?? ""
  const uiPreferences = useSettingsStore((s) => s.providerUIPreferences)

  const customProviders = useMemo<Record<string, CustomProviderSettings>>(() => {
    const out: Record<string, CustomProviderSettings> = {}
    for (const cp of customProvidersList) {
      out[cp.id] = cp
    }
    return out
  }, [customProvidersList])

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, ApiTestResult | null>>({})
  const [customTestResults, setCustomTestResults] = useState<
    Record<string, "success" | "error" | "limited" | null>
  >({})
  const [customTestMessages, setCustomTestMessages] = useState<Record<string, string | null>>({})
  const [testingProviders, setTestingProviders] = useState<Record<string, boolean>>({})
  const [testingCustomProviders, setTestingCustomProviders] = useState<Record<string, boolean>>({})

  // ---------------------------------------------------------------------------
  // Filtered lists for the sidebar — basic name/category sort, no
  // deferred-infra-driven filters (capability tags etc.).
  // ---------------------------------------------------------------------------
  const filteredProviders = useMemo(() => {
    const entries = Object.entries(PROVIDERS) as Array<[string, (typeof PROVIDERS)[string]]>
    return entries.sort((a, b) => a[1].name.localeCompare(b[1].name))
  }, [])

  const visibleCustomProviderIds = useMemo(
    () => customProvidersList.map((cp) => cp.id),
    [customProvidersList]
  )

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------
  const updateProviderSettings = useCallback(
    async (id: string, patch: Partial<UserProviderSettings>) => {
      await setProviderConfig(id, patch)
    },
    [setProviderConfig]
  )

  const updateCustomProvider = useCallback(
    async (id: string, patch: Partial<CustomProviderSettings>) => {
      const cur = customProviders[id]
      if (!cur) return
      await upsertCustomProviderStore({ ...cur, ...patch, id, isCustom: true })
    },
    [customProviders, upsertCustomProviderStore]
  )

  const removeCustomProvider = useCallback(
    async (id: string) => {
      await removeCustomProviderStore(id)
    },
    [removeCustomProviderStore]
  )

  const setDefaultProvider = useCallback(
    async (id: string) => {
      await setStoreDefaultProvider(id)
    },
    [setStoreDefaultProvider]
  )

  // ---------------------------------------------------------------------------
  // Connection tests — delegate to the api-test helpers.
  // ---------------------------------------------------------------------------
  const testProvider = useCallback(
    async (id: string) => {
      const cfg = providerSettings[id]
      if (!cfg) return null
      setTestingProviders((s) => ({ ...s, [id]: true }))
      try {
        const result = await testProviderConnection(id, cfg.apiKey ?? "", cfg.baseURL)
        setTestResults((s) => ({ ...s, [id]: result }))
        return result
      } catch (err) {
        const result: ApiTestResult = {
          success: false,
          message: err instanceof Error ? err.message : String(err),
          outcome: "failed",
        }
        setTestResults((s) => ({ ...s, [id]: result }))
        return result
      } finally {
        setTestingProviders((s) => ({ ...s, [id]: false }))
      }
    },
    [providerSettings]
  )

  const testCustomProvider = useCallback(
    async (id: string) => {
      const cp = customProviders[id]
      if (!cp) return null
      setTestingCustomProviders((s) => ({ ...s, [id]: true }))
      try {
        const result = await testCustomProviderConnectionByProtocol(
          cp.baseURL,
          cp.apiKey ?? "",
          cp.apiProtocol ?? "openai"
        )
        const outcome = result.success ? "success" : "error"
        setCustomTestResults((s) => ({ ...s, [id]: outcome }))
        setCustomTestMessages((s) => ({ ...s, [id]: result.message ?? null }))
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setCustomTestResults((s) => ({ ...s, [id]: "error" }))
        setCustomTestMessages((s) => ({ ...s, [id]: message }))
        return { success: false, message, outcome: "failed" } as ApiTestResult
      } finally {
        setTestingCustomProviders((s) => ({ ...s, [id]: false }))
      }
    },
    [customProviders]
  )

  return {
    providerSettings,
    customProviders,
    defaultProvider,
    uiPreferences,
    testResults,
    customTestResults,
    customTestMessages,
    testingProviders,
    testingCustomProviders,
    selectedProviderId,
    setSelectedProviderId,
    updateProviderSettings,
    updateCustomProvider,
    removeCustomProvider,
    setDefaultProvider,
    testProvider,
    testCustomProvider,
    filteredProviders,
    visibleCustomProviderIds,
  }
}

/** Re-export the model-metadata type for components that import it from here. */
export type { CustomModelMetadata }

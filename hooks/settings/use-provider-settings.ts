"use client"

/**
 * Component-facing provider settings adapter.
 *
 * Provider configuration, persisted UI preferences, connection-test state,
 * and store mutations stay behind this single surface so consumers do not
 * maintain competing copies of provider state.
 */

import { useCallback, useMemo, useState } from "react"
import { useSettingsStore } from "@/stores/settings"
import { PROVIDERS } from "@cognia/provider-types/provider"
import type {
  CustomModelMetadata,
  CustomProviderSettings,
  ProviderName,
  ProviderUIPreferences,
  UserProviderSettings,
} from "@cognia/provider-types/provider"
import { isLocalProviderName } from "@cognia/provider-types/local-provider"
import {
  testCustomProviderConnectionByProtocol,
  testProviderConnection,
  type ApiTestResult,
} from "@cognia/provider-core/providers/api-test"
import { discoverLocalProviderModels } from "@cognia/provider-core/providers/model-discovery"
import { buildProviderVerificationFingerprint } from "@cognia/provider-core/providers/completeness"
import { testAndDiscoverBedrock } from "@/lib/ai/providers/bedrock-connection"

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
  setSelectedProviderId: (id: string | null) => Promise<void>
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
  const setProviderUIPreferences = useSettingsStore((s) => s.setProviderUIPreferences)

  const providerSettings = useMemo(
    () => settings?.providerSettings ?? {},
    [settings?.providerSettings]
  )
  const customProvidersList = useMemo(
    () => settings?.customProviders ?? [],
    [settings?.customProviders]
  )
  const defaultProvider = settings?.defaultProvider ?? ""
  const uiPreferences = useSettingsStore((s) => s.providerUIPreferences)

  const customProviders = useMemo<Record<string, CustomProviderSettings>>(() => {
    const out: Record<string, CustomProviderSettings> = {}
    for (const cp of customProvidersList) {
      out[cp.id] = cp
    }
    return out
  }, [customProvidersList])

  const selectedProviderId = uiPreferences.selectedProviderId ?? null
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

  const setSelectedProviderId = useCallback(
    async (id: string | null) => {
      await setProviderUIPreferences({ selectedProviderId: id ?? undefined })
    },
    [setProviderUIPreferences]
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
  // Connection tests — delegate to the api-test helpers and persist the
  // verification lifecycle to `UserProviderSettings` so the sidebar status
  // survives reloads and isn't stuck on a vague "warning" badge every time.
  // ---------------------------------------------------------------------------
  const testProvider = useCallback(
    async (id: string) => {
      const cfg = providerSettings[id]
      if (!cfg) return null
      setTestingProviders((s) => ({ ...s, [id]: true }))
      try {
        let result: ApiTestResult
        if (id === "bedrock") {
          const bedrockResult = await testAndDiscoverBedrock(cfg)
          if (bedrockResult.models) {
            await setProviderConfig(id, {
              discoveredModels: bedrockResult.models,
              discoveredModelsLastFetched: Date.now(),
            })
          }
          result = bedrockResult.test
        } else {
          result = await testProviderConnection(
            id,
            cfg.apiKey ?? "",
            cfg.baseURL,
            cfg.customHeaders
          )
          const providerName = id as ProviderName
          if (result.success && isLocalProviderName(providerName)) {
            const discoveredModels = await discoverLocalProviderModels(providerName, cfg.baseURL)
            await setProviderConfig(id, {
              discoveredModels,
              discoveredModelsLastFetched: Date.now(),
            })
          }
        }

        // The fingerprint pins the verification to the credentials/endpoint it
        // was made with, so `evaluate*Completeness` can flip the status to
        // "stale" when the key or base URL changes afterwards. Without it the
        // stale branch was unreachable and a rotated key kept showing
        // "verified" forever.
        const verificationPatch: Partial<UserProviderSettings> = result.success
          ? {
              verificationStatus: "verified",
              verificationFingerprint: buildProviderVerificationFingerprint(cfg),
              lastVerifiedAt: Date.now(),
              verificationMessage: result.message,
              healthStatus: "healthy",
            }
          : {
              verificationStatus: "unverified",
              lastVerifiedAt: Date.now(),
              verificationMessage: result.message,
              healthStatus: "error",
            }
        await setProviderConfig(id, verificationPatch)

        setTestResults((s) => ({ ...s, [id]: result }))
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const result: ApiTestResult = {
          success: false,
          message,
          outcome: "failed",
        }
        await setProviderConfig(id, {
          verificationStatus: "unverified",
          lastVerifiedAt: Date.now(),
          verificationMessage: message,
          healthStatus: "error",
        })
        setTestResults((s) => ({ ...s, [id]: result }))
        return result
      } finally {
        setTestingProviders((s) => ({ ...s, [id]: false }))
      }
    },
    [providerSettings, setProviderConfig]
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
          cp.apiProtocol ?? "openai",
          cp.defaultModel,
          cp.customHeaders
        )
        const outcome = result.success ? "success" : "error"
        const verificationPatch: Partial<CustomProviderSettings> = result.success
          ? {
              verificationStatus: "verified",
              verificationFingerprint: buildProviderVerificationFingerprint(cp),
              lastVerifiedAt: Date.now(),
              verificationMessage: result.message,
              healthStatus: "healthy",
            }
          : {
              verificationStatus: "unverified",
              lastVerifiedAt: Date.now(),
              verificationMessage: result.message,
              healthStatus: "error",
            }
        await updateCustomProvider(id, verificationPatch)
        setCustomTestResults((s) => ({ ...s, [id]: outcome }))
        setCustomTestMessages((s) => ({ ...s, [id]: result.message ?? null }))
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await updateCustomProvider(id, {
          verificationStatus: "unverified",
          lastVerifiedAt: Date.now(),
          verificationMessage: message,
          healthStatus: "error",
        })
        setCustomTestResults((s) => ({ ...s, [id]: "error" }))
        setCustomTestMessages((s) => ({ ...s, [id]: message }))
        return { success: false, message, outcome: "failed" } as ApiTestResult
      } finally {
        setTestingCustomProviders((s) => ({ ...s, [id]: false }))
      }
    },
    [customProviders, updateCustomProvider]
  )

  // Referentially stable while nothing changed. Consumers memoise callbacks on
  // the whole result (`useCallback(..., [s])`), and a fresh literal on every
  // render made every one of them a new function each time.
  return useMemo<UseProviderSettingsResult>(
    () => ({
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
    }),
    [
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
    ]
  )
}

/** Re-export the model-metadata type for components that import it from here. */
export type { CustomModelMetadata }

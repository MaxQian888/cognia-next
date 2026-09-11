"use client"

/**
 * Component-facing provider settings adapter.
 *
 * Provider configuration, persisted UI preferences, connection-test state,
 * and store mutations stay behind this single surface so consumers do not
 * maintain competing copies of provider state.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useSettingsStore } from "@/stores/settings"
import { getAllProviders, PROVIDERS } from "@cognia/provider-types/provider"
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
import {
  buildProviderVerificationFingerprint,
  getActiveCredential,
} from "@cognia/provider-core/providers/completeness"
import { testAndDiscoverBedrock } from "@/lib/ai/providers/bedrock-connection"

import { resolveSubscriptionProviderCredential } from "@/lib/claude/provider-attempt-options"
import { subscribeSubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { sha256Hex } from "@/lib/share/hash"
import type { AppSettings } from "@cognia/agent-config-types"

import {
  listSubscriptionProviders,
  subscribeSubscriptionProviders,
} from "@/lib/subscription/core/provider-registry"

// Readiness needs credential identity, never the vault secret. Hash the complete
// transport so account rotation and relay/header changes invalidate verification.
async function subscriptionReadinessConfig<T extends UserProviderSettings>(
  cfg: T,
  credential: NonNullable<Awaited<ReturnType<typeof resolveSubscriptionProviderCredential>>>
): Promise<T> {
  return {
    ...cfg,
    apiKey: `subscription:${await sha256Hex(JSON.stringify(credential))}`,
    apiKeys: [],
    baseURL: credential.baseURL,
  }
}

async function prepareConnectionConfigs<T extends UserProviderSettings>(
  id: string,
  cfg: T,
  settings: AppSettings | null | undefined,
  allowSubscription: boolean
): Promise<{ effectiveCfg: T; verificationCfg: T }> {
  if (!settings || !allowSubscription || getActiveCredential(cfg))
    return { effectiveCfg: cfg, verificationCfg: cfg }
  const credential = await resolveSubscriptionProviderCredential(id, settings)
  if (!credential) return { effectiveCfg: cfg, verificationCfg: cfg }
  return {
    effectiveCfg: {
      ...cfg,
      apiKey: credential.apiKey,
      baseURL: credential.baseURL,
      customHeaders: credential.headers,
    },
    verificationCfg: await subscriptionReadinessConfig(cfg, credential),
  }
}

export interface UseProviderSettingsResult {
  // ---------------------------------------------------------------------------
  // Data sources
  // ---------------------------------------------------------------------------
  providerSettings: Record<string, UserProviderSettings>
  /** Sanitized, ephemeral projection for guards and status; never edit or persist it. */
  readinessProviderSettings?: Record<string, UserProviderSettings>
  customProviders: Record<string, CustomProviderSettings>
  /** Readiness-only copy; credentials are represented by a non-secret identity digest. */
  readinessCustomProviders?: Record<string, CustomProviderSettings>
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

  const [registryRevision, setRegistryRevision] = useState(0)
  useEffect(
    () => subscribeSubscriptionProviders(() => setRegistryRevision((revision) => revision + 1)),
    []
  )
  const catalog = useMemo(() => {
    void registryRevision
    return getAllProviders()
  }, [registryRevision])
  const subscriptionDefinitions = useMemo(() => {
    void registryRevision
    return listSubscriptionProviders(settings?.customProviders)
  }, [settings?.customProviders, registryRevision])
  const subscriptionApiIds = useMemo(
    () =>
      subscriptionDefinitions
        .filter((definition) => definition.authMode !== "anthropic-oauth")
        .flatMap((definition) => [
          definition.id,
          ...(definition.plans?.map((plan) => plan.chatProviderId) ?? []),
        ]),
    [subscriptionDefinitions]
  )

  const providerSettings = useMemo(
    () => settings?.providerSettings ?? {},
    [settings?.providerSettings]
  )
  const [customTestResults, setCustomTestResults] = useState<
    Record<string, "success" | "error" | "limited" | null>
  >({})
  const [customTestMessages, setCustomTestMessages] = useState<Record<string, string | null>>({})
  const [testResults, setTestResults] = useState<Record<string, ApiTestResult | null>>({})
  const subscriptionRevision = useRef(0)
  const latestSettings = useRef(settings)
  useLayoutEffect(() => {
    const previous = latestSettings.current
    latestSettings.current = settings
    const sameProvider = (id: string) =>
      buildProviderVerificationFingerprint(previous?.providerSettings?.[id]) ===
      buildProviderVerificationFingerprint(settings?.providerSettings?.[id])
    const sameCustom = (id: string) =>
      buildProviderVerificationFingerprint(
        previous?.customProviders?.find((provider) => provider.id === id)
      ) ===
      buildProviderVerificationFingerprint(
        settings?.customProviders?.find((provider) => provider.id === id)
      )
    setTestResults((results) =>
      Object.fromEntries(Object.entries(results).filter(([id]) => sameProvider(id)))
    )
    setCustomTestResults((results) =>
      Object.fromEntries(Object.entries(results).filter(([id]) => sameCustom(id)))
    )
    setCustomTestMessages((messages) =>
      Object.fromEntries(Object.entries(messages).filter(([id]) => sameCustom(id)))
    )
  }, [settings])
  // Keep vault work scoped to the settings consumed by credential resolution.
  const hasSettings = Boolean(settings)
  const readinessSettings = useMemo(
    () =>
      hasSettings
        ? {
            providerSettings: settings?.providerSettings,
            customProviders: settings?.customProviders,
            defaultAccountIds: settings?.defaultAccountIds,
            defaultAccountId: settings?.defaultAccountId,
            defaultProvider: settings?.defaultProvider,
          }
        : null,
    [
      hasSettings,
      settings?.providerSettings,
      settings?.customProviders,
      settings?.defaultAccountIds,
      settings?.defaultAccountId,
      settings?.defaultProvider,
    ]
  )
  const [subscriptionReadiness, setSubscriptionReadiness] = useState<{
    settings: typeof readinessSettings
    configs: Record<string, UserProviderSettings>
  } | null>(null)
  useEffect(() => {
    let generation = 0
    let disposed = false
    const refresh = async () => {
      const current = ++generation
      setSubscriptionReadiness(null)
      if (!readinessSettings) return
      const entries = await Promise.all(
        subscriptionApiIds.map(async (id) => {
          const custom = readinessSettings.customProviders?.find((provider) => provider.id === id)
          const cfg = custom ??
            providerSettings[id] ?? {
              providerId: id,
              enabled: false,
              defaultModel: catalog[id]?.defaultModel,
            }
          if (getActiveCredential(cfg)) return null
          try {
            const credential = await resolveSubscriptionProviderCredential(
              id,
              readinessSettings as AppSettings
            )
            return credential
              ? ([id, await subscriptionReadinessConfig(cfg, credential)] as const)
              : null
          } catch {
            return null
          }
        })
      )
      if (!disposed && generation === current) {
        setSubscriptionReadiness({
          settings: readinessSettings,
          configs: Object.fromEntries(entries.filter((entry) => entry !== null)),
        })
      }
    }
    void refresh()
    const unsubscribe = subscribeSubscriptionChanged(() => {
      subscriptionRevision.current += 1
      setTestResults({})
      setCustomTestResults({})
      setCustomTestMessages({})
      void refresh()
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [readinessSettings, providerSettings, subscriptionApiIds, catalog])
  const readinessProviderSettings = useMemo(
    () => ({
      ...providerSettings,
      ...(subscriptionReadiness?.settings === readinessSettings
        ? subscriptionReadiness?.configs
        : {}),
    }),
    [providerSettings, readinessSettings, subscriptionReadiness]
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

  const readinessCustomProviders = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(customProviders).map(([id, custom]) => [
          id,
          {
            ...custom,
            ...(subscriptionReadiness?.settings === readinessSettings
              ? subscriptionReadiness.configs[id]
              : {}),
          },
        ])
      ),
    [customProviders, subscriptionReadiness, readinessSettings]
  )

  const selectedProviderId = uiPreferences.selectedProviderId ?? null
  const [testingProviders, setTestingProviders] = useState<Record<string, boolean>>({})
  const [testingCustomProviders, setTestingCustomProviders] = useState<Record<string, boolean>>({})

  // ---------------------------------------------------------------------------
  // Filtered lists for the sidebar — basic name/category sort, no
  // deferred-infra-driven filters (capability tags etc.).
  // ---------------------------------------------------------------------------
  const filteredProviders = useMemo(() => {
    const entries = Object.entries(catalog) as Array<[string, (typeof PROVIDERS)[string]]>
    return entries.sort((a, b) => a[1].name.localeCompare(b[1].name))
  }, [catalog])

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
      const cfg =
        providerSettings[id] ??
        (subscriptionApiIds.includes(id)
          ? { providerId: id, enabled: false, defaultModel: catalog[id]?.defaultModel }
          : undefined)
      if (!cfg) return null
      const testedRevision = subscriptionRevision.current
      const testedConfig = buildProviderVerificationFingerprint(cfg)
      const isCurrent = () =>
        subscriptionRevision.current === testedRevision &&
        buildProviderVerificationFingerprint(
          latestSettings.current?.providerSettings?.[id] ?? (providerSettings[id] ? undefined : cfg)
        ) === testedConfig
      setTestingProviders((s) => ({ ...s, [id]: true }))
      try {
        const { effectiveCfg, verificationCfg } = await prepareConnectionConfigs(
          id,
          cfg,
          settings,
          subscriptionApiIds.includes(id)
        )
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
          const definition = subscriptionDefinitions.find((entry) => entry.id === id)
          result =
            definition?.source === "plugin"
              ? await testCustomProviderConnectionByProtocol(
                  effectiveCfg.baseURL ?? definition.baseUrl ?? "",
                  getActiveCredential(effectiveCfg),
                  definition.protocol ?? "openai",
                  effectiveCfg.defaultModel ?? definition.models?.[0],
                  effectiveCfg.customHeaders
                )
              : await testProviderConnection(
                  id,
                  getActiveCredential(effectiveCfg),
                  effectiveCfg.baseURL,
                  effectiveCfg.customHeaders
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
              verificationFingerprint: buildProviderVerificationFingerprint(verificationCfg),
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
        if (!isCurrent()) return null
        await setProviderConfig(id, verificationPatch)
        if (!isCurrent()) return null

        setTestResults((s) => ({ ...s, [id]: result }))
        return result
      } catch (err) {
        if (!isCurrent()) return null
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
        if (!isCurrent()) return null
        setTestResults((s) => ({ ...s, [id]: result }))
        return result
      } finally {
        setTestingProviders((s) => ({ ...s, [id]: false }))
      }
    },
    [
      providerSettings,
      settings,
      setProviderConfig,
      subscriptionApiIds,
      subscriptionDefinitions,
      catalog,
    ]
  )

  const testCustomProvider = useCallback(
    async (id: string) => {
      const cp = customProviders[id]
      if (!cp) return null
      const testedRevision = subscriptionRevision.current
      const testedConfig = buildProviderVerificationFingerprint(cp)
      const isCurrent = () =>
        subscriptionRevision.current === testedRevision &&
        buildProviderVerificationFingerprint(
          latestSettings.current?.customProviders?.find((provider) => provider.id === id)
        ) === testedConfig
      setTestingCustomProviders((s) => ({ ...s, [id]: true }))
      try {
        const { effectiveCfg, verificationCfg } = await prepareConnectionConfigs(
          id,
          cp,
          settings,
          Boolean(cp.subscription)
        )
        const result = await testCustomProviderConnectionByProtocol(
          effectiveCfg.baseURL,
          getActiveCredential(effectiveCfg),
          effectiveCfg.apiProtocol ?? "openai",
          effectiveCfg.defaultModel,
          effectiveCfg.customHeaders
        )
        const outcome = result.success ? "success" : "error"
        const verificationPatch: Partial<CustomProviderSettings> = result.success
          ? {
              verificationStatus: "verified",
              verificationFingerprint: buildProviderVerificationFingerprint(verificationCfg),
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
        if (!isCurrent()) return null
        await updateCustomProvider(id, verificationPatch)
        if (!isCurrent()) return null
        setCustomTestResults((s) => ({ ...s, [id]: outcome }))
        setCustomTestMessages((s) => ({ ...s, [id]: result.message ?? null }))
        return result
      } catch (err) {
        if (!isCurrent()) return null
        const message = err instanceof Error ? err.message : String(err)
        await updateCustomProvider(id, {
          verificationStatus: "unverified",
          lastVerifiedAt: Date.now(),
          verificationMessage: message,
          healthStatus: "error",
        })
        if (!isCurrent()) return null
        setCustomTestResults((s) => ({ ...s, [id]: "error" }))
        setCustomTestMessages((s) => ({ ...s, [id]: message }))
        return { success: false, message, outcome: "failed" } as ApiTestResult
      } finally {
        setTestingCustomProviders((s) => ({ ...s, [id]: false }))
      }
    },
    [customProviders, updateCustomProvider, settings]
  )

  // Referentially stable while nothing changed. Consumers memoise callbacks on
  // the whole result (`useCallback(..., [s])`), and a fresh literal on every
  // render made every one of them a new function each time.
  return useMemo<UseProviderSettingsResult>(
    () => ({
      providerSettings,
      readinessProviderSettings,
      readinessCustomProviders,
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
      readinessProviderSettings,
      readinessCustomProviders,
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

/**
 * Canonical Standard Webhooks settings store.
 *
 * This is intentionally outbound-only. The removed Remote Control listener
 * no longer owns renderer state or Tauri commands; webhook delivery keeps its
 * non-secret configuration here and stores the signing secret through the
 * shared keyring abstraction.
 */

import { loggers } from "@cognia/logging"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { setWebhookSigningSecret } from "@/lib/webhooks/signing-secret"
import { persistLocalStorage } from "@/stores/persist-storage"
import {
  DEFAULT_WEBHOOK_CONFIG,
  normalizeWebhookDelivery,
  type WebhookConfig,
  type WebhookEndpoint,
  type WebhookHeader,
} from "@/types/webhooks"

const log = loggers.scheduler

interface WebhookState {
  config: WebhookConfig
  lastError: string | null
}

interface WebhookActions {
  updateConfig: (patch: Partial<WebhookConfig>) => Promise<{ ok: boolean; error?: string }>
  setDefaultHeaders: (headers: WebhookHeader[]) => Promise<{ ok: boolean; error?: string }>
  setSigningSecret: (secret: string | null) => Promise<{ ok: boolean; error?: string }>
  reset: () => void
}

type WebhookStore = WebhookState & WebhookActions

function cloneEndpoint(endpoint: WebhookEndpoint): WebhookEndpoint {
  return {
    ...endpoint,
    headers: endpoint.headers.map((header) => ({ ...header })),
    eventTypes: endpoint.eventTypes ? [...endpoint.eventTypes] : undefined,
  }
}

function cloneConfig(config: WebhookConfig): WebhookConfig {
  return {
    hasSigningSecret: config.hasSigningSecret,
    defaultHeaders: config.defaultHeaders.map((header) => ({ ...header })),
    endpoints: config.endpoints.map(cloneEndpoint),
    delivery: normalizeWebhookDelivery(config.delivery),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringsOnlyHeader(value: unknown): value is WebhookHeader {
  return isRecord(value) && typeof value.name === "string" && typeof value.value === "string"
}

function normalizeEndpoint(value: unknown): WebhookEndpoint | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.url !== "string" ||
    typeof value.enabled !== "boolean"
  ) {
    return null
  }
  return {
    id: value.id,
    name: value.name,
    url: value.url,
    enabled: value.enabled,
    headers: Array.isArray(value.headers) ? value.headers.filter(stringsOnlyHeader) : [],
    eventTypes: Array.isArray(value.eventTypes)
      ? value.eventTypes.filter((item): item is string => typeof item === "string")
      : undefined,
  }
}

function normalizePersistedConfig(value: unknown): WebhookConfig {
  const defaults = DEFAULT_WEBHOOK_CONFIG
  if (!isRecord(value)) return cloneConfig(defaults)
  const delivery = isRecord(value.delivery) ? value.delivery : undefined
  return {
    hasSigningSecret: value.hasSigningSecret === true,
    defaultHeaders: Array.isArray(value.defaultHeaders)
      ? value.defaultHeaders.filter(stringsOnlyHeader)
      : [],
    endpoints: Array.isArray(value.endpoints)
      ? value.endpoints
          .map(normalizeEndpoint)
          .filter((endpoint): endpoint is WebhookEndpoint => endpoint !== null)
      : [],
    delivery: normalizeWebhookDelivery(
      delivery
        ? {
            maxRetries: typeof delivery.maxRetries === "number" ? delivery.maxRetries : undefined,
            timeoutMs: typeof delivery.timeoutMs === "number" ? delivery.timeoutMs : undefined,
            baseDelayMs:
              typeof delivery.baseDelayMs === "number" ? delivery.baseDelayMs : undefined,
          }
        : undefined
    ),
  }
}

/** Extract outbound settings from the former combined Remote Control store. */
export function migrateWebhookPersistedState(persisted: unknown): Pick<WebhookState, "config"> {
  const root = isRecord(persisted) ? persisted : {}
  const config = isRecord(root.config) ? root.config : root
  const outbound = isRecord(config.outbound) ? config.outbound : config
  return { config: normalizePersistedConfig(outbound) }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const initialConfig = cloneConfig(DEFAULT_WEBHOOK_CONFIG)

export const useWebhookStore = create<WebhookStore>()(
  persist(
    (set, get) => ({
      config: initialConfig,
      lastError: null,

      updateConfig: async (patch) => {
        const next = cloneConfig({ ...get().config, ...patch })
        set({ config: next, lastError: null })
        return { ok: true }
      },

      setDefaultHeaders: async (headers) => get().updateConfig({ defaultHeaders: headers }),

      setSigningSecret: async (secret) => {
        const normalized = secret && secret.length > 0 ? secret : null
        try {
          await setWebhookSigningSecret(normalized)
          set((state) => ({
            config: { ...state.config, hasSigningSecret: normalized !== null },
            lastError: null,
          }))
          return { ok: true }
        } catch (error) {
          const message = describeError(error)
          log.error("webhooks.setSigningSecret failed", { error: message })
          set({ lastError: message })
          return { ok: false, error: message }
        }
      },

      reset: () => set({ config: cloneConfig(initialConfig), lastError: null }),
    }),
    {
      // Keep the previous storage key for a single in-place migration so
      // existing outbound endpoints and delivery limits are not discarded.
      name: "cognia-remote-control",
      storage: persistLocalStorage(),
      version: 1,
      migrate: (persisted) => migrateWebhookPersistedState(persisted),
      partialize: (state) => ({ config: state.config }),
    }
  )
)

export const selectWebhookConfig = (state: WebhookStore) => state.config

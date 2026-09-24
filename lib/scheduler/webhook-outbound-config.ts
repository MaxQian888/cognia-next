/**
 * Pulls the outbound webhook configuration (signing secret + custom headers)
 * for a delivery. Lives in its own module so the notification-integration
 * pipeline can stay declarative — and so tests can mock the resolved config
 * without having to spin up the full Zustand store.
 *
 * Resolution order:
 *   1. Custom default headers — read from the canonical webhook store.
 *   2. Signing secret — read through the shared secure-storage abstraction.
 *
 * Returning `undefined` for a field means "no override" — the webhook send
 * path will skip that step.
 */

import { useEffect, useState } from "react"
import { getWebhookSigningSecret } from "@/lib/webhooks/signing-secret"
import { useWebhookStore } from "@/stores/webhooks/store"
import type { WebhookDeliveryConfig } from "@/types/webhooks"

export interface WebhookOutboundConfig {
  /** Lowercase-hex secret used for the `X-Cognia-Signature` HMAC header. */
  signingSecret?: string
  /** Headers merged on top of the default Content-Type. */
  headers?: Record<string, string>
  /** User-tunable retry / timeout / backoff limits, if configured. */
  delivery?: WebhookDeliveryConfig
}

export async function getWebhookOutboundConfig(): Promise<WebhookOutboundConfig> {
  const headers = headersFromStore()
  const signingSecret = await readSigningSecret(signingConfiguredInStore())
  return {
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    signingSecret: signingSecret ?? undefined,
    delivery: deliveryFromStore(),
  }
}

function signingConfiguredInStore(): boolean {
  try {
    return useWebhookStore.getState().config.hasSigningSecret
  } catch {
    return false
  }
}

function deliveryFromStore(): WebhookDeliveryConfig | undefined {
  try {
    return useWebhookStore.getState().config.delivery
  } catch {
    return undefined
  }
}

function headersFromStore(): Record<string, string> {
  try {
    const list = useWebhookStore.getState().config.defaultHeaders
    const out: Record<string, string> = {}
    for (const { name, value } of list) {
      const trimmedName = name.trim()
      if (!trimmedName) continue
      out[trimmedName] = value
    }
    return out
  } catch {
    // The store may not be initialised in some test environments; fall back
    // to no extra headers rather than crash the webhook send path.
    return {}
  }
}

async function readSigningSecret(required: boolean): Promise<string | null> {
  try {
    const secret = await getWebhookSigningSecret()
    if (required && !secret) throw new Error("configured webhook signing secret is unavailable")
    return secret && secret.length > 0 ? secret : null
  } catch (error) {
    if (required) throw error
    return null
  }
}

export interface WebhookSigningState {
  enabled: boolean
  loading: boolean
  /**
   * Signing is configured but the secret could not be read (secure storage
   * locked or unavailable). Signed deliveries fail in this state, so the UI
   * says so instead of claiming "not signed" or spinning on "loading".
   */
  unavailable: boolean
}

/**
 * React hook indicating whether outbound webhook signing is configured.
 *
 * Resolves once on mount via `getWebhookOutboundConfig()`. The signing secret
 * is stored by the shared secure-storage authority and rarely changes
 * mid-session, so mount-time resolution is sufficient. A failed read (the
 * store is locked while signing is required) resolves to `unavailable`; it
 * must not escape as an unhandled rejection from this fire-and-forget effect.
 */
export function useWebhookSigningState(): WebhookSigningState {
  const [state, setState] = useState<WebhookSigningState>({
    enabled: false,
    loading: true,
    unavailable: false,
  })

  useEffect(() => {
    let cancelled = false
    void getWebhookOutboundConfig().then(
      (config) => {
        if (cancelled) return
        setState({ enabled: Boolean(config.signingSecret), loading: false, unavailable: false })
      },
      () => {
        if (cancelled) return
        setState({ enabled: false, loading: false, unavailable: true })
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  return state
}

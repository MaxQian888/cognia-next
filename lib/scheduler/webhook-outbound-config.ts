/**
 * Pulls the outbound webhook configuration (signing secret + custom headers)
 * for a delivery. Lives in its own module so the notification-integration
 * pipeline can stay declarative — and so tests can mock the resolved config
 * without having to spin up the full Zustand store.
 *
 * Resolution order:
 *   1. Custom default headers — always read from the in-memory Zustand store
 *      (`stores/remote-control/store.ts`). On both web and desktop.
 *   2. Signing secret — on the Tauri desktop runtime, read from the OS
 *      keyring through `remoteControlGetSigningSecret`. On web (or when the
 *      Rust call fails for any reason), the secret is treated as "not set"
 *      and signing is skipped.
 *
 * Returning `undefined` for a field means "no override" — the webhook send
 * path will skip that step.
 */

import { useEffect, useState } from "react"
import { isTauri } from "@/lib/tauri"
import { remoteControlGetSigningSecret } from "@/lib/tauri/remote-control"
import { useRemoteControlStore } from "@/stores/remote-control/store"
import type { WebhookDeliveryConfig } from "@/types/remote-control"

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
  const signingSecret = await readSigningSecret()
  return {
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    signingSecret: signingSecret ?? undefined,
    delivery: deliveryFromStore(),
  }
}

function deliveryFromStore(): WebhookDeliveryConfig | undefined {
  try {
    return useRemoteControlStore.getState().config.outbound.delivery
  } catch {
    return undefined
  }
}

function headersFromStore(): Record<string, string> {
  try {
    const list = useRemoteControlStore.getState().config.outbound.defaultHeaders
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

async function readSigningSecret(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const secret = await remoteControlGetSigningSecret()
    return secret && secret.length > 0 ? secret : null
  } catch {
    return null
  }
}

/**
 * React hook indicating whether outbound webhook signing is configured.
 *
 * Resolves once on mount via `getWebhookOutboundConfig()`. The signing secret
 * is stored in the OS keyring (desktop) and rarely changes mid-session, so
 * mount-time resolution is sufficient — users can navigate away and back to
 * re-check after rotating the key.
 *
 * On web `enabled` is always `false` (no keyring access from the browser).
 */
export function useWebhookSigningState(): { enabled: boolean; loading: boolean } {
  const [state, setState] = useState<{ enabled: boolean; loading: boolean }>({
    enabled: false,
    loading: true,
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const config = await getWebhookOutboundConfig()
      if (cancelled) return
      setState({ enabled: Boolean(config.signingSecret), loading: false })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return state
}

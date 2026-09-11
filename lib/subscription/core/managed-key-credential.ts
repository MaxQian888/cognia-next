import { useAccountStore } from "@/stores/account/account-store"
import { getSubscriptionProvider } from "./provider-registry"
import { isTauri } from "@/lib/tauri"
import { restBaseOf } from "@/lib/ai/operations/handlers/http"
import type { SubscriptionProviderDefinition } from "@/types/subscription/provider-definition"
import { getAccount, getActiveAccount, getProviderPreset, listPresets } from "./transport"

/** Resolve a host-owned key just before dispatch; plugins receive only provider metadata. */
export async function resolveManagedSubscriptionCredential(
  definition: SubscriptionProviderDefinition,
  selectedAccountId?: string | null
): Promise<{
  apiKey: string
  baseURL: string
  headers?: Record<string, string>
  apiFlavor?: "chat" | "responses"
} | null> {
  if (!isTauri() || definition.available === false || definition.authMode !== "api-key") return null
  const localAccountId = useAccountStore.getState().unlockedAccountId
  if (!localAccountId) return null
  try {
    const id = selectedAccountId || (await getActiveAccount(definition.id)).activeAccountId
    if (!id) return null
    const account = await getAccount(definition.id, id)
    const credential = account?.credential
    if (!credential || credential.provider !== "api-key" || credential.providerId !== definition.id)
      return null
    const apiKey = credential.accessToken.trim()
    if (!apiKey) return null
    const bound = account.presetId
      ? (await listPresets(definition.id)).find((preset) => preset.id === account.presetId)
      : null
    const preset = bound ?? (await getProviderPreset(definition.id))
    const configuredBaseURL =
      preset?.baseUrl?.trim() || credential.baseUrl?.trim() || definition.baseUrl
    if (!configuredBaseURL) return null
    // The Anthropic AI SDK appends `/messages` to third-party bases verbatim.
    // Resolve the same versioned base used by model-list and other REST calls.
    const baseURL = restBaseOf({
      protocol: definition.protocol ?? "openai",
      baseURL: configuredBaseURL.replace(/\/+$/, ""),
    })!
    const headers = Object.fromEntries(
      Object.entries(preset?.extraHeaders ?? {}).filter(
        ([name]) => !name.toLowerCase().startsWith("x-cognia-")
      )
    )
    if (useAccountStore.getState().unlockedAccountId !== localAccountId) return null
    if (definition.source === "plugin" && !getSubscriptionProvider(definition.id)) return null
    return {
      apiKey,
      baseURL,
      ...(definition.protocol === "openai" && definition.apiFlavor
        ? { apiFlavor: definition.apiFlavor }
        : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    }
  } catch {
    return null
  }
}

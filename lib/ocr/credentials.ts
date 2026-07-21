/**
 * Production credentials for OCR providers.
 *
 * Two sources, mirroring ADR-0024:
 *   1. Cloud OCR providers (`mistral-ocr`, `google-vision`, `aws-textract`, …)
 *      store their secrets in the generic keyring (`lib/keyring`) under the
 *      `"ocr"` namespace, keyed `"<providerId>:<credentialKey>"`. On Tauri this
 *      is the OS keyring; on web it's the AES-GCM encrypted Dexie fallback
 *      (which silently returns null until a passphrase is set — cloud OCR then
 *      degrades and the auto-router falls through to a local engine).
 *   2. LLM-vision providers (`anthropic-vision`, `openai-vision`,
 *      `gemini-vision`) reuse the main provider keys via the same
 *      `resolveFeatureProvider` path that chat uses — no second credential.
 *
 * This is the single production `CredentialsResolver`; `buildOcrDeps()` wires
 * it into every surface (composer, slash command, agent tool, connectors, …).
 */

import { getSecret, setSecret, clearSecret } from "@/lib/keyring"
import { getSettings } from "@/lib/db/settings"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  type ProviderSettingsEntry,
  type RichCustomProviderEntry,
} from "@/lib/ai/provider-consumption"
import type { CredentialsResolver } from "./index"

/** Keyring namespace for OCR cloud-provider secrets. */
export const OCR_KEYRING_NAMESPACE = "ocr"

function secretRef(providerId: string, credentialKey: string) {
  return { namespace: OCR_KEYRING_NAMESPACE, key: `${providerId}:${credentialKey}` }
}

/** Read a single stored OCR cloud-provider secret. Null when unset/unavailable. */
export async function getOcrSecret(
  providerId: string,
  credentialKey: string
): Promise<string | null> {
  return getSecret(secretRef(providerId, credentialKey))
}

/** Persist (or, when value is empty, clear) an OCR cloud-provider secret. */
export async function setOcrSecret(
  providerId: string,
  credentialKey: string,
  value: string
): Promise<void> {
  if (value.length === 0) {
    await clearSecret(secretRef(providerId, credentialKey))
    return
  }
  await setSecret(secretRef(providerId, credentialKey), value)
}

/** Remove a stored OCR cloud-provider secret. */
export async function clearOcrSecret(providerId: string, credentialKey: string): Promise<void> {
  await clearSecret(secretRef(providerId, credentialKey))
}

/**
 * Resolve a main-provider API key (for LLM-vision OCR providers that reuse the
 * chat keys). Returns null when the provider isn't configured.
 */
export async function resolveMainProviderKey(mainProviderId: string): Promise<string | null> {
  const settings = await getSettings()
  const snapshot = createProviderSettingsSnapshot({
    defaultProvider: settings.defaultProvider,
    providerSettings: settings.providerSettings as
      Record<string, ProviderSettingsEntry> | undefined,
    customProviders: settings.customProviders as RichCustomProviderEntry[] | undefined,
  })
  const resolution = resolveFeatureProvider(
    {
      featureId: "ocr",
      routeProfile: "vision",
      selectionMode: "explicit-provider",
      providerId: mainProviderId,
      fallbackMode: "none",
    },
    snapshot
  )
  if (resolution.kind === "resolved" && resolution.apiKey) return resolution.apiKey
  return null
}

/**
 * Build the production OCR `CredentialsResolver`. The optional `deps` hook lets
 * tests inject fakes without touching the keyring or settings store.
 */
export function createOcrCredentialsResolver(deps?: {
  readSecret?: (providerId: string, key: string) => Promise<string | null>
  getMainProviderKey?: (mainProviderId: string) => Promise<string | null>
}): CredentialsResolver {
  const readSecret = deps?.readSecret ?? getOcrSecret
  const getMainProviderKey = deps?.getMainProviderKey ?? resolveMainProviderKey
  return async (providerId, keys) => {
    const secrets: Record<string, string> = {}
    for (const key of keys) {
      const value = await readSecret(providerId, key)
      if (value) secrets[key] = value
    }
    return { secrets, getMainProviderKey }
  }
}

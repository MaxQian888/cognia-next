/**
 * Settings + keyring access for the decisions subsystem (ADR-0194).
 *
 * `AppSettings.decisions` holds the selected provider and the remote endpoint
 * (preset / url / model). The endpoint API key never touches settings or
 * IndexedDB plaintext: it lives in the keyring, one entry per preset so
 * switching presets does not lose a key (same pattern as `lib/share/config.ts`).
 */

import { getSettings } from "@/lib/db/settings"
import { clearSecret, getSecret, setSecret, type KeyringRef } from "@/lib/keyring"
import type { DecisionHttpPresetId, DecisionSettings } from "@/types/decisions"

export const DECISIONS_KEYRING_NAMESPACE = "decisions"

export function decisionKeyRef(preset: DecisionHttpPresetId): KeyringRef {
  return { namespace: DECISIONS_KEYRING_NAMESPACE, key: `http:${preset}` }
}

export async function loadDecisionSettings(): Promise<DecisionSettings> {
  const settings = await getSettings()
  return settings?.decisions ?? {}
}

export async function getDecisionHttpKey(preset: DecisionHttpPresetId): Promise<string | null> {
  return getSecret(decisionKeyRef(preset))
}

/**
 * Store (or, with an empty value, clear) the key for a preset. On the web and
 * mobile shells the keyring fallback needs the backup passphrase; without it
 * the write throws and the caller surfaces "keyring unavailable".
 */
export async function setDecisionHttpKey(
  preset: DecisionHttpPresetId,
  value: string
): Promise<void> {
  const trimmed = value.trim()
  if (trimmed) await setSecret(decisionKeyRef(preset), trimmed)
  else await clearSecret(decisionKeyRef(preset))
}

export async function hasDecisionHttpKey(preset: DecisionHttpPresetId): Promise<boolean> {
  return Boolean(await getDecisionHttpKey(preset))
}

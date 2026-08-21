"use client"

import { useEffect, useState } from "react"

import { hasModelAccess, type ScanResult } from "@/lib/onboarding/scan"
import { resolveStandaloneProvider } from "@/lib/ai/chat/resolve-standalone-provider"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { useSettingsStore } from "@/stores/settings/settings-store"

export interface ModelAccess {
  /**
   * The live verdict — `null` until it settles. Credentials gained *inside*
   * the flow show up here, which is what the terminal step's gate needs: the
   * user who just pasted a key must not meet disabled cards one step later.
   */
  value: boolean | null
  /**
   * The latched verdict, for the step sequence only. See the note below for
   * why these two deliberately differ.
   */
  resolved: boolean
}

/**
 * Whether this device can already reach a model — latched at the first settled
 * answer.
 *
 * **Why latch.** `resolveStepSequence` drops the sign-in step when this is
 * true, and `nextStep` returns the *first* step when the step you are standing
 * on is no longer in the sequence. So a live verdict that flips to `true`
 * while the user is on the sign-in step — which is exactly when it flips, they
 * just signed in — would re-sequence underneath them and send the next
 * "continue" back to the start of the flow. Access gained *inside* the flow is
 * already handled by the step's own action; this value only answers "did they
 * arrive with access", which is a fact about the boot, not about the session.
 * ADR-0122 latches the gate verdict for the same reason.
 *
 * The latch takes the first *settled* answer. `useCredentialStatus` starts at
 * `null` (the Tauri probes are async), and the welcome step — which is not in
 * the rail and not gated on this — is what covers that window.
 *
 * Three sources are folded together by `hasModelAccess`; see its doc comment
 * for why none of them subsumes the others.
 */
export function useModelAccess(scan: ScanResult): ModelAccess {
  const { keyOk } = useCredentialStatus()
  // Settings-resolved AI-SDK providers (OpenAI, Google, a local Ollama, a
  // custom base URL). Read reactively so a key pasted *by the sign-in step*
  // still settles the probe on a shell where `keyOk` stays null.
  const settings = useSettingsStore((s) => s.settings)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const providerConfigured = resolveStandaloneProvider(settings).kind === "resolved"

  const live = hasModelAccess({
    scan,
    credentialsOk: keyOk,
    providerConfigured,
    legacyApiKey: settings?.apiKey,
  })
  // Settled means the probe answered, or something else already proves access.
  const settled = live || (settingsLoaded && keyOk !== null)

  const [latched, setLatched] = useState<boolean | null>(null)
  useEffect(() => {
    if (latched !== null || !settled) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLatched(live)
  }, [latched, settled, live])

  // Two answers on purpose. `resolved` is latched so the sequence cannot change
  // under the user; `value` is live so the terminal step's gate reflects the
  // credential they just added. Latching both would leave someone who signed in
  // during the flow looking at cards that refuse to run.
  return { value: settled ? live : null, resolved: latched === true }
}

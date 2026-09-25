"use client"

import { useExternalRuntimeConnections } from "@/components/settings/provider/use-external-runtime-connections"
import { useClientLiveQuery } from "@/hooks/data"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { resolveStandaloneProvider } from "@/lib/ai/chat/resolve-standalone-provider"
import { countSessions } from "@/lib/db/sessions"
import {
  deriveSetupGaps,
  resolveLiveModelAccess,
  type SetupGap,
} from "@/lib/onboarding/setup-status"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** The built-in agent's own sources: the credential probe, a provider, the legacy key. */
function useBuiltInSources() {
  const { keyOk } = useCredentialStatus()
  const settings = useSettingsStore((s) => s.settings)
  const loaded = useSettingsStore((s) => s.loaded)
  return {
    loaded,
    credentialsOk: keyOk,
    providerConfigured: resolveStandaloneProvider(settings).kind === "resolved",
    legacyApiKey: settings?.apiKey,
  }
}

/**
 * Whether the *built-in* agent can reach a model — a credential, a provider or
 * the legacy key, but not an external agent that brings its own.
 *
 * The provider page asks this narrower question: an external agent working on
 * its own credentials does not make "add a provider" moot, it only changes what
 * adding one is for.
 */
export function useBuiltInModelAccess(): boolean | null {
  const { loaded, ...sources } = useBuiltInSources()
  if (!loaded) return null
  return resolveLiveModelAccess({ ...sources, externalRuntimeReady: false })
}

/**
 * Whether this device can reach a model right now, from inside the app
 * (ADR-0193).
 *
 * The same sources the first-run flow folds into `useModelAccess` — the chat
 * path's credential probe, a settings-resolved provider, the legacy key slot —
 * plus a connected external agent standing in for the flow's process scan.
 * Live, not latched: this is read by surfaces that must change the moment the
 * user fixes the gap somewhere else.
 *
 * `null` until settings hydrate and the probe answers, and forever on a paired
 * phone, which borrows the desktop's credentials — "cannot say", never
 * "missing".
 */
export function useLiveModelAccess(): boolean | null {
  const { loaded, ...sources } = useBuiltInSources()
  const { workingCount } = useExternalRuntimeConnections()
  if (!loaded) return null
  return resolveLiveModelAccess({ ...sources, externalRuntimeReady: workingCount > 0 })
}

export interface SetupStatus {
  /** What is still missing, most blocking first. */
  gaps: SetupGap[]
}

/**
 * Live setup status for the in-app guide surfaces — the finish-setup bar and
 * the Settings → Discover status block read the same answer, so they can never
 * disagree about what is missing. Neither applies the bar's dismissal here:
 * the bar checks it before mounting this at all, and Settings ignores it.
 */
export function useSetupStatus(): SetupStatus {
  const progress = useSettingsStore((s) => s.settings?.onboardingProgress)
  const modelAccess = useLiveModelAccess()
  const sessionCount = useClientLiveQuery<number | null>(() => countSessions(), [], null)

  return {
    gaps: deriveSetupGaps({ progress, modelAccess, sessionCount: sessionCount ?? null }),
  }
}

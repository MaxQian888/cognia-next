"use client"

/**
 * "Can the user turn this plugin on HERE, and if not, why."
 *
 * The compatibility collector already knew (`collectPluginRuntimeProfileDiagnostics`
 * returns an error-severity diagnostic for a runtime the manifest does not
 * support, and the manager refuses to activate on it), but the Switch and the
 * row menu's "Enable" were live anyway. Flipping them started an activation
 * that could only fail, and the user learned why from a raw English toast.
 *
 * On a MIRRORED client (paired phone, web companion) the question is
 * different: the toggle is queued to the desktop host, which runs the plugin
 * on the `tauri` profile. Judging it against the phone's own `mobile` profile
 * flagged nearly every plugin "Not available here" while the toggle worked
 * fine, so the gate evaluates the desktop profile there and says where the
 * plugin actually runs.
 */

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { collectPluginRuntimeProfileDiagnostics } from "@/lib/plugin/core/runtime-compatibility"
import { isMirroredPluginClient } from "@/lib/plugin/core/set-plugin-enabled-for-host"
import type {
  ExtensionCompatibilityDiagnostic,
  PluginManifest,
  PluginRuntimeProfile,
} from "@/types/plugin"

import { usePluginRuntimeProfile } from "./use-plugin-runtime-profile"

const NEVER_CHANGES = () => () => {}

/** True on a client whose plugin rows mirror a desktop host's. */
export function useMirroredPluginClient(): boolean {
  return useSyncExternalStore(NEVER_CHANGES, isMirroredPluginClient, () => false)
}

/**
 * The profile a plugin's toggle is actually judged against: the desktop's on a
 * mirrored client, this host's own everywhere else.
 */
export function useEffectivePluginRuntimeProfile(): PluginRuntimeProfile {
  const own = usePluginRuntimeProfile()
  const mirrored = useMirroredPluginClient()
  return mirrored ? "tauri" : own
}

export interface PluginEnableGateEvaluation {
  /** The plugin cannot be started on `profile`. */
  blocked: boolean
  /** The worst diagnostic (error before warning), or null when fully supported. */
  diagnostic: ExtensionCompatibilityDiagnostic | null
  /** Manifest-authored explanation for `profile`, when the author wrote one. */
  authorReason: string | null
}

function readAuthorReason(manifest: PluginManifest, profile: PluginRuntimeProfile): string | null {
  const map = manifest.runtimeCompatibility as
    Partial<Record<PluginRuntimeProfile, { reason?: unknown }>> | undefined
  const own = map?.[profile]?.reason
  if (typeof own === "string" && own.trim()) return own.trim()
  // Mobile inherits browser compatibility when it declares none of its own —
  // the same fallback the collector applies.
  if (profile === "mobile" && !map?.mobile) {
    const inherited = map?.browser?.reason
    if (typeof inherited === "string" && inherited.trim()) return inherited.trim()
  }
  return null
}

/** Pure half of the gate — exported for non-React callers and tests. */
export function evaluatePluginEnableGate(
  manifest: PluginManifest | Record<string, unknown> | null | undefined,
  profile: PluginRuntimeProfile
): PluginEnableGateEvaluation {
  if (!manifest) return { blocked: false, diagnostic: null, authorReason: null }
  const typed = manifest as PluginManifest
  const diagnostics = collectPluginRuntimeProfileDiagnostics(typed, profile)
  const diagnostic =
    diagnostics.find((d) => d.severity === "error") ??
    diagnostics.find((d) => d.severity === "warning") ??
    null
  return {
    blocked: diagnostic?.severity === "error",
    diagnostic,
    authorReason: diagnostic ? readAuthorReason(typed, profile) : null,
  }
}

export interface PluginEnableGate extends PluginEnableGateEvaluation {
  /** Localized one-line reason when `blocked`, otherwise null. */
  reason: string | null
  /** The toggle is queued to a desktop host that runs the plugin. */
  runsOnDesktop: boolean
  profile: PluginRuntimeProfile
}

export function usePluginEnableGate(
  row: { manifest?: PluginManifest | Record<string, unknown> } | null | undefined
): PluginEnableGate {
  const t = useTranslations("plugins.compatibility")
  const profile = useEffectivePluginRuntimeProfile()
  const runsOnDesktop = useMirroredPluginClient()
  const evaluation = evaluatePluginEnableGate(row?.manifest, profile)
  const reason = evaluation.blocked
    ? t("blockedTooltip", { host: t(`host.${profile}` as never) })
    : null
  return { ...evaluation, reason, runsOnDesktop, profile }
}

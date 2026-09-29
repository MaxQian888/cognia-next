/**
 * Which video providers a chat surface can use, and how the Settings →
 * Media generation defaults combine with a single call's overrides
 * (ADR-0205, S3 "settings defaults + per-call override").
 *
 * A provider is usable when it resolves through the same provider
 * resolution the job engine uses (configured, with credentials) — there is
 * no second notion of "configured" to drift from it.
 */

import type { VideoGenerationSettings } from "@cognia/agent-config-types"

import type { ProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"
import { resolveVideoProvider } from "../provider-generation"
import {
  VIDEO_GENERATION_PROVIDER_IDS,
  VIDEO_PROVIDER_OPTIONS,
  isVideoProviderReachable,
  resolveVideoModel,
  type VideoProviderId,
} from "../video-generation-sdk"
import type { VideoJobParams } from "./params"

export interface ConfiguredVideoProvider {
  providerId: VideoProviderId
  /** The model a job uses when none is chosen. */
  defaultModel: string
  /** False on the web build for providers it cannot reach (listed, but inert). */
  reachable: boolean
}

export function listConfiguredVideoProviders(
  snapshot: ProviderSettingsSnapshot,
  reachesNonCorsHosts: boolean
): ConfiguredVideoProvider[] {
  const out: ConfiguredVideoProvider[] = []
  for (const providerId of VIDEO_GENERATION_PROVIDER_IDS) {
    let model: string | undefined
    try {
      model = resolveVideoProvider(snapshot, providerId).model
    } catch {
      continue
    }
    out.push({
      providerId,
      defaultModel: resolveVideoModel(providerId, model),
      reachable: isVideoProviderReachable(providerId, reachesNonCorsHosts),
    })
  }
  return out
}

/** Whether a chat surface here can start a video job at all. */
export function hasUsableVideoProvider(
  snapshot: ProviderSettingsSnapshot,
  reachesNonCorsHosts: boolean
): boolean {
  return listConfiguredVideoProviders(snapshot, reachesNonCorsHosts).some((p) => p.reachable)
}

/** What one call asks for; every field is optional and wins over its default. */
export interface VideoJobOverrides extends Pick<
  VideoJobParams,
  "durationSec" | "aspectRatio" | "resolution"
> {
  providerId?: string
  model?: string
}

export interface VideoJobSelection {
  /** Undefined lets the engine pick the first configured provider. */
  providerId?: string
  model?: string
  params: VideoJobParams
}

/**
 * Combine the saved defaults with one call's overrides.
 *
 * An override is the caller's explicit choice and is passed through as is —
 * the engine refuses one the provider does not take. A default is softer: the
 * saved model and options belong to the saved provider, so they apply only
 * while the call uses that provider, only where that provider takes them, and
 * not at all once that provider is no longer configured (the engine then
 * picks one, instead of every chat job failing on a stale setting).
 */
export function applyVideoDefaults(
  settings: VideoGenerationSettings | undefined,
  overrides: VideoJobOverrides,
  configured: readonly VideoProviderId[]
): VideoJobSelection {
  const saved = settings?.providerId as VideoProviderId | undefined
  const savedUsable = saved !== undefined && configured.includes(saved)
  const providerId = overrides.providerId ?? (savedUsable ? saved : undefined)
  const defaultsApply = savedUsable && providerId === saved
  const support = defaultsApply ? VIDEO_PROVIDER_OPTIONS[saved] : undefined

  const params: VideoJobParams = {}
  const durationSec =
    overrides.durationSec ?? (support?.duration ? settings?.durationSec : undefined)
  const aspectRatio =
    overrides.aspectRatio ?? (support?.aspectRatio ? settings?.aspectRatio : undefined)
  const resolution =
    overrides.resolution ?? (support?.resolution ? settings?.resolution : undefined)
  if (durationSec !== undefined) params.durationSec = durationSec
  if (aspectRatio !== undefined) params.aspectRatio = aspectRatio
  if (resolution !== undefined) params.resolution = resolution

  const model = overrides.model ?? (defaultsApply ? settings?.model : undefined)
  return {
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
    params,
  }
}

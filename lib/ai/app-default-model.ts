/**
 * What `AppSettings.defaultModel` + `defaultProvider` mean to the lane asking.
 *
 * That pair is dual-purpose, and only two call sites knew it. A model chosen
 * from an external agent's OWN list on a brand-new chat has no session row to
 * land on, so `components/chat/composer/model-picker.tsx` writes it to the app
 * default and stamps `defaultProvider` with the reserved marker
 * (`externalAgentProviderId`). `createSession` then inherits the marked pair
 * onto the row it creates, which is what makes the choice survive into the
 * first turn, so the write is load-bearing and cannot simply be removed.
 *
 * The consequence is that the app-wide default can hold an id that belongs to
 * one agent's vocabulary and to nothing else. `commandcode/meta/muse-spark-1.3`
 * names no provider model, and `cognia:external-agent:pi-rpc` names no
 * provider. `resolveSendOptions` has always stripped it. Every other reader
 * took it at face value and either dispatched at a model no configured
 * provider offers, wrote it into the CLI's config file, or, on the Built-in
 * Agent Runtime settings page, displayed it as the SDK sidecar's default, which
 * is the surface that made this visible.
 *
 * So the rule lives here once, and readers say which lane they are:
 *
 *   - the provider/built-in lane calls {@link resolveAppDefaultModel} with no
 *     agent id and gets the pair with a foreign default resolved away
 *   - the external lane passes its own agent id and gets the model back, never
 *     the marker, which is not a provider and is never handed downstream
 *   - a surface that wants to EXPLAIN the absence rather than just show one
 *     calls {@link externalAgentAppDefault} for the agent id holding it
 */

import type { AppSettings } from "@cognia/agent-config-types"

import {
  externalAgentIdFromProviderId,
  isExternalAgentProviderId,
} from "@/lib/ai/agent/external/session-models"

/** The two fields this module reads, so a caller need not hold all of AppSettings. */
export type AppDefaultModelSlice =
  Pick<AppSettings, "defaultModel" | "defaultProvider"> | null | undefined

export interface AppDefaultModelPair {
  /** `undefined` when the stored default belongs to a lane other than the caller's. */
  model: string | undefined
  /** Never the external-agent marker, which does not name a provider. */
  provider: string | undefined
}

export interface ExternalAgentAppDefault {
  /**
   * `null` for the legacy unscoped marker, which names no agent and is
   * therefore unsafe to replay. Mirrors {@link externalAgentIdFromProviderId}.
   */
  agentId: string | null
  model: string | undefined
  /** The marker verbatim, for a caller that has to write the row back. */
  provider: string
}

/** True when the app-wide default was chosen from some external agent's list. */
export function appDefaultBelongsToExternalAgent(settings: AppDefaultModelSlice): boolean {
  return isExternalAgentProviderId(settings?.defaultProvider ?? undefined)
}

/**
 * The app-wide default as an external-agent-owned pair, or `null` when it is
 * an ordinary provider default.
 *
 * Returns the pair even when `model` is empty. A marker with no model beside it
 * is a real state (the user cleared the model but not the lane) and a caller
 * explaining the absence still needs to name the agent.
 */
export function externalAgentAppDefault(
  settings: AppDefaultModelSlice
): ExternalAgentAppDefault | null {
  const provider = settings?.defaultProvider
  if (!provider || !isExternalAgentProviderId(provider)) return null
  return {
    agentId: externalAgentIdFromProviderId(provider),
    model: settings?.defaultModel?.trim() || undefined,
    provider,
  }
}

export interface ResolveAppDefaultModelOptions {
  /**
   * The external agent the caller is resolving FOR. A marked default is kept
   * only when it names this same agent, because one agent's vocabulary is not
   * another's and replaying it across agents asks for a model the receiving
   * agent never offered.
   *
   * Omit it (or pass `null`/`undefined`) on the provider / built-in lane.
   */
  forExternalAgentId?: string | null
}

/**
 * The app-wide default pair as the calling lane may actually use it.
 *
 * The provider half is dropped for ANY marked default, matched agent or not.
 * The marker is a lane stamp, and handing it downstream as a provider id is
 * what would send a turn to a base URL that does not exist.
 */
export function resolveAppDefaultModel(
  settings: AppDefaultModelSlice,
  options?: ResolveAppDefaultModelOptions
): AppDefaultModelPair {
  const model = settings?.defaultModel?.trim() || undefined
  const provider = settings?.defaultProvider || undefined
  if (!isExternalAgentProviderId(provider)) return { model, provider }

  const wanted = options?.forExternalAgentId
  const owner = externalAgentIdFromProviderId(provider)
  const matches = Boolean(wanted) && owner !== null && owner === wanted
  return { model: matches ? model : undefined, provider: undefined }
}

"use client"

/**
 * The single seam deciding whether a Sites control may act.
 *
 * Two independent things can stop an action, and the console has to say which:
 *
 *  - **Host.** Builds run through `sandbox_exec`, previews spawn a PTY,
 *    provider calls need the OS keyring and a non-CORS-blocked fetch, and the
 *    manifest lives on disk. None of that exists outside the Tauri shell. The
 *    console still renders everywhere — the panel used to blank itself behind
 *    one page-level `isTauri()`, which is why it looked like it had no
 *    features at all in the browser — but each host-privileged control is
 *    disabled with a reason instead.
 *  - **Authoring policy.** `CloudflareSitesService` asserts the policy on every
 *    mutation and throws. Without this gate a viewer sees enabled buttons that
 *    fail on click.
 *
 * Getting the host half wrong is worse than an error: outside Tauri the keyring
 * silently falls back to an in-memory store (a saved provider token would look
 * accepted and vanish on reload) and `readTextFile` falls back to `fetch`,
 * which turns a missing manifest into the dev server's 404 HTML. Those paths
 * must be closed here, not discovered downstream.
 */
import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { usePlatform, type Platform } from "@/hooks/use-platform"
import { canAuthorSite, type SiteAuthoringCapability } from "@/lib/sites/authoring-policy"
import type { SiteProjectRow } from "@/types/sites"

/**
 * What an action needs from the machine it runs on.
 *
 * `metadata` is the odd one out: creating a Site, editing its authoring policy,
 * and deleting its Cognia rows touch nothing but Dexie, so they work in every
 * shell against that shell's own local database.
 */
export type SiteActionCapability = "provider" | "build" | "preview" | "filesystem" | "metadata"

export type SiteGateReason =
  | "ok"
  | "requires-desktop"
  /** The host has no wrangler binary — upload cannot run, deploy still can. */
  | "requires-wrangler"
  | "requires-access"
  | "requires-owner"
  | "requires-editor"
  | "requires-deployer"
  | "lifecycle-locked"

export interface SiteGateDecision {
  allowed: boolean
  reason: SiteGateReason
}

export interface SiteGate extends SiteGateDecision {
  /** Localized explanation for the control's `title`, or undefined when allowed. */
  title: string | undefined
}

export type SiteActionGate = (
  capability: SiteActionCapability,
  authoring?: SiteAuthoringCapability
) => SiteGate

const REASON_FOR_CAPABILITY: Record<SiteAuthoringCapability, SiteGateReason> = {
  view: "requires-access",
  edit: "requires-editor",
  deploy: "requires-deployer",
  manage: "requires-owner",
}

export interface ResolveSiteGateInput {
  platform: Platform
  site: SiteProjectRow | null
  actorAccountId: string
  capability: SiteActionCapability
  authoring?: SiteAuthoringCapability
}

/**
 * Pure gate decision. Order matters: the host answer is reported first because
 * it is the one the user can act on without anyone's permission.
 */
export function resolveSiteGate(input: ResolveSiteGateInput): SiteGateDecision {
  const needsHost = input.capability !== "metadata"
  if (needsHost && input.platform !== "tauri") {
    return { allowed: false, reason: "requires-desktop" }
  }
  const site = input.site
  if (!site) return { allowed: true, reason: "ok" }
  // `deleting` means a purge is mid-flight and holds the lease; `deleted`
  // leaves only the metadata cleanup that `metadata` covers.
  const lifecycleLocked =
    site.lifecycle === "deleting" || (site.lifecycle === "deleted" && needsHost)
  if (lifecycleLocked) return { allowed: false, reason: "lifecycle-locked" }
  if (
    input.authoring &&
    !canAuthorSite(site.authoringPolicy, input.actorAccountId, input.authoring)
  ) {
    return { allowed: false, reason: REASON_FOR_CAPABILITY[input.authoring] }
  }
  return { allowed: true, reason: "ok" }
}

/**
 * Bind the gate to the current shell and actor.
 *
 * Call sites read as two props, which is the idiom already used across
 * settings: `disabled={busy || !gate.allowed}` and `title={gate.title}`.
 */
export function useSiteActionGate(
  site: SiteProjectRow | null,
  actorAccountId: string
): SiteActionGate {
  const platform = usePlatform()
  const t = useTranslations("sites")
  return useCallback(
    (capability, authoring) => {
      const decision = resolveSiteGate({ platform, site, actorAccountId, capability, authoring })
      return {
        ...decision,
        title: decision.allowed ? undefined : t(`host.reason.${decision.reason}`),
      }
    },
    [platform, site, actorAccountId, t]
  )
}

"use client"

/**
 * What the sidebar's account card knows about the person using it.
 *
 * Two planes, read as one. The local profile is the vault
 * (`stores/account/account-store`) and is always there. The cloud identity is
 * the ADR-0149 binding between that profile and a Logto session, and it exists
 * only once the user has signed in. The card needs a single answer, so this
 * hook folds them into a `standing` the UI can branch on once instead of three
 * separate loading states leaking into the render.
 *
 * The card is mounted for the whole session and neither read behind it is free,
 * so the two are paced differently. The cloud binding is read on mount, because
 * the card's RESTING row already names the standing and the person: deferring
 * it labelled a signed-in profile "on this device" until someone opened the
 * menu. The usage aggregate stays lazy, because it hits the same rate-limited
 * endpoints the status bar polls and nobody can see the number until the menu
 * is out. Both re-read on each open, so a sign-in from Settings lands.
 */

import { useEffect, useRef, useState } from "react"

import { readCloudSessionState, type CloudSessionState } from "@/lib/identity/cloud-session"
import { useAllConfiguredLimits } from "@/lib/subscription/limits/hooks"
import { loggers } from "@cognia/logging"

const log = loggers.ui

/** Where the profile stands, in the one word the card branches on. */
export type SidebarIdentityStanding = "local" | "cloud" | "org"

export interface SidebarIdentity {
  /** Cloud display name when bound, `null` when the local profile's name is the only one. */
  displayName: string | null
  /** Cloud address when the session carries one. */
  email: string | null
  standing: SidebarIdentityStanding
  /**
   * The binding is there but the token is not usable right now, so the card
   * offers the way back in without calling the profile local.
   *
   * `readCloudSessionState` reports four not-`active` states and only one of
   * them is "no account": `reauth-required` names a login that lapsed, and
   * `offline` / `error` name a token that could not be reached. Folding all
   * four into signed-out told a cloud user on a plane that their profile lives
   * on this device, and offered them a sign-in they had already done.
   */
  needsReauth: boolean
  /**
   * Worst meter across every configured subscription account, 0-100, or `null`
   * when nothing on this install is measured (web builds, no accounts, a user
   * who never opted into outbound quota queries).
   */
  usagePercent: number | null
}

const SIGNED_OUT: SidebarIdentity = {
  displayName: null,
  email: null,
  standing: "local",
  needsReauth: false,
  usagePercent: null,
}

/** Fold one `readCloudSessionState` answer into what the card draws. */
function identityFrom(state: CloudSessionState): SidebarIdentity {
  if (state.status === "active") {
    return {
      displayName: state.identity.displayName ?? null,
      email: state.identity.email ?? null,
      standing: state.identity.orgId ? "org" : "cloud",
      needsReauth: false,
      usagePercent: null,
    }
  }
  if (state.status === "signed-out") return SIGNED_OUT
  // Bound, but the token could not be used this time. The metadata is all that
  // survives a lapsed or unreachable session, and it carries no name or
  // address, so the card falls back to the local profile's name and to the
  // word for the tier rather than inventing a cloud identity.
  const metadata = state.sessionMetadata
  if (!metadata) return { ...SIGNED_OUT, needsReauth: state.status === "reauth-required" }
  return {
    displayName: null,
    email: null,
    standing: metadata.organizationId ? "org" : "cloud",
    // `offline` needs no action from the user, only patience. `reauth-required`
    // and a hard `error` are what a sign-in actually answers.
    needsReauth: state.status !== "offline",
    usagePercent: null,
  }
}

/**
 * @param active Whether the card's menu is open. The USAGE aggregate is read on
 * the first `true` and refreshed on each subsequent open, because it hits the
 * same rate-limited endpoints the status bar polls and nobody can see the
 * number until the menu is out.
 *
 * The cloud binding is not lazy: the card's resting row renders `standing` and
 * the name beside it, so deferring that read left a signed-in profile labelled
 * "on this device" until someone happened to open the menu. It is re-read on
 * each open too, so a sign-in from Settings lands.
 */
export function useSidebarIdentity(active: boolean): SidebarIdentity {
  const [identity, setIdentity] = useState<SidebarIdentity>(SIGNED_OUT)
  const { snapshots, refresh } = useAllConfiguredLimits()

  // `active` is a dependency so an open re-reads, but the first run happens on
  // mount whatever it is. A ref rather than a second state: this decides
  // whether an effect runs, and it must not itself schedule a render.
  const readOnce = useRef(false)
  useEffect(() => {
    if (!active && readOnce.current) return
    readOnce.current = true
    let alive = true
    void readCloudSessionState()
      .then((state) => {
        if (alive) setIdentity(identityFrom(state))
      })
      .catch((cause: unknown) => {
        // A profile whose binding cannot be read at all is not signed out, but
        // the card has nothing truthful to draw from it either. Keep the last
        // reading and say so in the log rather than inventing an identity.
        log.warn("sidebar identity read failed", { error: String(cause) })
      })
    return () => {
      alive = false
    }
  }, [active])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  // Derived rather than stored: `snapshots` is the hook's own state and folding
  // it into ours would leave two copies to keep in step.
  let worst = -1
  for (const snapshot of snapshots) {
    for (const meter of snapshot.meters) {
      if (meter.usedPct == null) continue
      if (meter.usedPct > worst) worst = meter.usedPct
    }
  }
  const usagePercent = worst >= 0 ? Math.max(0, Math.min(100, Math.round(worst))) : null

  return { ...identity, usagePercent }
}

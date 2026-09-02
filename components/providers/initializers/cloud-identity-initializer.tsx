"use client"

/**
 * Boot-time hygiene for the cloud identity of the unlocked profile.
 *
 * Two things run here, once per unlocked profile, and neither has a UI:
 *
 * 1. `discardLegacyGlobalLogtoSession`. The pre-ADR-0149 global keyring key
 *    held one login for every profile on the machine. The deleter was written
 *    with the per-profile key and then never called from anywhere, so a
 *    machine upgraded from that era kept a live refresh token under a key
 *    nothing reads. This is the production caller.
 *
 * 2. `resolveLogtoSession`. Resolving on boot is what turns "the token expired
 *    while the app was closed" into a marker the Account surface can show,
 *    instead of the first cloud request of the day failing with a 401. A
 *    refresh that succeeds here is also the refresh every later caller gets
 *    for free.
 *
 * Both are best effort. A keyring that is not reachable at boot is logged and
 * retried on the next unlock, never surfaced as a boot failure: local data does
 * not depend on the cloud, and the gate must never wait on it.
 */

import { useEffect, useRef } from "react"
import { loggers } from "@cognia/logging"

import { resolveLogtoSession } from "@/lib/logto/app-session"
import { discardLegacyGlobalLogtoSession } from "@/lib/logto/session-store"
import { useAccountStore } from "@/stores/account/account-store"

const log = loggers.shell

export function CloudIdentityInitializer() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const ranFor = useRef<string | null>(null)

  useEffect(() => {
    if (!unlockedAccountId) return
    if (ranFor.current === unlockedAccountId) return
    ranFor.current = unlockedAccountId

    void (async () => {
      try {
        const discarded = await discardLegacyGlobalLogtoSession()
        if (discarded) log.info("cloud-identity: discarded the pre-ADR-0149 global Logto session")
      } catch (error) {
        log.warn("cloud-identity: legacy session cleanup failed", { error: String(error) })
      }
      try {
        const resolved = await resolveLogtoSession({ localAccountId: unlockedAccountId })
        if (resolved.status === "reauth-required") {
          log.info("cloud-identity: sign-in required", { reason: resolved.reason })
        }
      } catch (error) {
        log.warn("cloud-identity: session resolution failed", { error: String(error) })
      }
    })()
  }, [unlockedAccountId])

  return null
}

export default CloudIdentityInitializer

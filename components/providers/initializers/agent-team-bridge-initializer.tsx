"use client"

/**
 * Mounts the Squad store's Dexie mirror.
 *
 * Keyed on `accountRevision` for the reason the canvas and artifact bridges
 * are: a mirror started against one account's database must not keep writing
 * into another's, and only a restart re-runs hydration against the database
 * that is actually selected now.
 *
 * Without this the squads would live only in memory from persist v8 on, since
 * that version is where they stopped being written to the `cognia-agent-teams`
 * localStorage blob.
 */

import { useEffect } from "react"

import { startAgentTeamDexieBridge } from "@/stores/agent/agent-team-store/dexie-bridge"
import { useAccountStore } from "@/stores/account/account-store"

export function AgentTeamBridgeInitializer() {
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)

  useEffect(() => {
    // A locked account has no database to mirror into, and starting anyway
    // would hydrate against whatever was selected last.
    if (!unlockedAccountId) return
    return startAgentTeamDexieBridge()
  }, [accountRevision, unlockedAccountId])

  return null
}

"use client"

/**
 * Mounts the ordered Squad bootstrap (ADR-0169).
 *
 * Replaces the pair `AgentTeamRuntimeInitializer` + `AgentTeamBridgeInitializer`,
 * which used to start the Dexie mirror and configure the runtime in two
 * unordered effects. Recovery could then run over definitions that were still
 * hydrating, and the first click after boot could reach an unconfigured
 * runtime. `runSquadBootstrap` owns the order now: hydrate, adapters, history
 * import, recovery, ready.
 *
 * Keyed on the unlocked account for the reason the canvas and artifact
 * bridges are: a mirror started against one account's database must not keep
 * writing into another's, and only a restart re-runs the sequence against the
 * database that is actually selected now.
 */

import { useEffect } from "react"

import { runSquadBootstrap } from "@/lib/agent-team/bootstrap"
import { useAccountStore } from "@/stores/account/account-store"

export function SquadBootstrapInitializer() {
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)

  useEffect(() => {
    // A locked account has no database to hydrate from. Nothing runs, and
    // the runtime stays idle until one is unlocked.
    if (!unlockedAccountId) return
    const handle = runSquadBootstrap()
    return () => handle.dispose()
  }, [accountRevision, unlockedAccountId])

  return null
}

export default SquadBootstrapInitializer

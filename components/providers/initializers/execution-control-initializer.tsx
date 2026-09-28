"use client"

import { useEffect } from "react"

import { startAgentStateExecutionBridge } from "@/lib/execution/agent-state-bridge"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { useAccountStore } from "@/stores/account/account-store"

import { installExecutionControlPlane } from "@/lib/execution/install-execution-control"

/**
 * Keeps the run-control dispatch table alive for the whole renderer session.
 *
 * The registration previously rode inside `installConnectorRuntime`, so every
 * Stop / Pause / Resume / Steer button in the product silently stopped working
 * in two ordinary states: while a remote Cognia host was active (the connector
 * runtime is deliberately disposed then) and in any window that lost the
 * runtime's Web Lock lease. `executeRunControlCommand` answered `unsupported`,
 * which a card cannot tell apart from "this kind is not controllable".
 *
 * Mounted in the core-chat capability chunk because run control is a chat-level
 * concern, not a connector one. The installer is refcounted, so the connector
 * runtime may keep taking its own reference (the headless brain has no React
 * tree and boots the control plane that way) without either owner being able to
 * tear the table out from under the other.
 */
export function ExecutionControlInitializer() {
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const { target, vaultState } = useRuntimeSnapshot()
  const targetId = target?.id
  useEffect(() => installExecutionControlPlane(), [])
  // Goal and Plan journals are portable. Their projection must keep running
  // when the connector lease belongs to another window or a remote host.
  useEffect(() => {
    if (vaultState !== "unlocked" || !targetId) return
    return startAgentStateExecutionBridge()
  }, [accountRevision, targetId, vaultState])
  return null
}

export default ExecutionControlInitializer

"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { resolveUserActionAvailability } from "@/lib/runtime/operation-availability"
import { AVAILABILITY_MESSAGE_KEY } from "@/lib/workspace/availability-messages"

/** Whether one command can run right now, and the sentence to show when it cannot. */
export interface WorkspaceCommandGate {
  available: boolean
  /** Null when available. A translated, actionable sentence otherwise. */
  reason: string | null
}

/**
 * Per-command availability for workspace and worktree controls.
 *
 * # Why per command and not per host
 *
 * These surfaces used to branch on `isTauri()`, which answers none of the
 * three questions that actually decide whether a click will work: is the
 * command published by this host, does this device hold the capability, and
 * can it obtain the `host.admin` lease an interactive command needs. A single
 * host-shaped boolean also cannot express that `git_worktree_prune` is
 * available while `task_workspace_managed_delete` is not, which is a real
 * state on a device granted `workspace.write` but not `host.admin`.
 *
 * # Why a reason and not just a boolean
 *
 * Hiding a control collapses three different answers into one appearance:
 * "this host never had it", "this is one grant away", and "the connection
 * dropped". Callers render the control disabled and put {@link
 * WorkspaceCommandGate.reason} on it, so the difference is visible.
 *
 * The returned function is stable while the runtime snapshot is, so it is safe
 * as a memo dependency.
 */
export function useWorkspaceCommandGate(): (command: string) => WorkspaceCommandGate {
  const t = useTranslations("workspace.actionErrors")
  const snapshot = useRuntimeSnapshot()
  return useCallback(
    (command: string) => {
      const availability = resolveUserActionAvailability(snapshot, command)
      if (availability.state === "available") return { available: true, reason: null }
      return {
        available: false,
        reason: t(AVAILABILITY_MESSAGE_KEY[availability.state], {
          grant: availability.requiredGrant ?? "",
        }),
      }
    },
    [snapshot, t]
  )
}

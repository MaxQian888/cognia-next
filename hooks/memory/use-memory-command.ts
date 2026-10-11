"use client"

/**
 * Run a memory command from a component, through the authority-routed door
 * (`runMemoryCommand`), with the feedback every caller owes the user.
 *
 * A rejected command (`{ ok: false, reason }`) surfaces as a toast instead of
 * failing silently, a `piiRedacted` result says the stored text was rewritten,
 * and a thrown error is a generic failure rather than an unhandled rejection.
 * The returned boolean is "did it land (or get queued for the host)", so a
 * dialog can stay open on failure.
 *
 * `authority` re-renders when the routing can change (taking over a remote
 * host, pairing a web companion), so a surface can label host-only details —
 * a mirror's health or vector coverage — without polling.
 */

import { useCallback, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type { ManageMemoryCommand } from "@/lib/memory/control-plane/manage"
import {
  memoryWriteAuthority,
  runMemoryCommand,
  subscribeMemoryWriteAuthority,
  type MemoryWriteAuthority,
} from "@/lib/memory/control-plane/routed-manage"

export interface UseMemoryCommandResult {
  run: (command: ManageMemoryCommand) => Promise<boolean>
  authority: MemoryWriteAuthority
}

export function useMemoryCommand(): UseMemoryCommandResult {
  const t = useTranslations("memory.panel")
  const tErrors = useTranslations("memory.errors")
  const tQueue = useTranslations("memory.queue")
  const authority = useSyncExternalStore(
    subscribeMemoryWriteAuthority,
    memoryWriteAuthority,
    () => "local" as const
  )

  const run = useCallback(
    async (command: ManageMemoryCommand): Promise<boolean> => {
      try {
        const result = await runMemoryCommand(command, {
          authority,
          label: tQueue(command.kind),
        })
        if (!result.ok) {
          toast.error(tErrors(result.reason))
          return false
        }
        // The control plane rewrites text that trips the PII gate. Saying so is
        // the difference between "saved" and "saved something slightly
        // different from what you typed".
        if ("piiRedacted" in result && result.piiRedacted) toast.warning(t("piiRedacted"))
        return true
      } catch {
        toast.error(tErrors("mutation_failed"))
        return false
      }
    },
    [authority, t, tErrors, tQueue]
  )

  return { run, authority }
}

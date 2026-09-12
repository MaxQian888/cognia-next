"use client"

/**
 * The accounts and connector adapters a credential slot can be bound to.
 *
 * One read for the whole detail pane rather than one per slot: a Bot with five
 * slots would otherwise open ten Dexie queries on every live-query tick, and
 * every one of them would return the same two tables. The narrowing per slot
 * is pure and happens in `buildCredentialCandidates`.
 *
 * Both tables are Dexie, so `useLiveQuery` alone keeps this current. There is
 * no registry overlay in the way, unlike the definitions.
 */

import { useBotHostRead } from "./use-bot-host-read"
import { useCallback } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import {
  buildCredentialCandidates,
  type BotCredentialCandidate,
} from "@/lib/bot/console/credential-candidates"
import { listAdapterInstances } from "@/lib/db/adapter-instances"
import { listAllIntegrationAccounts } from "@/lib/db/integrations"
import type { PluginBotCredentialSlot } from "@/types/plugin/plugin-bot"

export interface UseCredentialCandidatesResult {
  /** Candidates for one slot. Stable across renders for the same sources. */
  forSlot: (slot: Pick<PluginBotCredentialSlot, "id" | "integration">) => BotCredentialCandidate[]
  loading: boolean
  failed?: boolean
}

export function useCredentialCandidates(): UseCredentialCandidatesResult {
  const host = useBotHostRead<{ groups: Record<string, BotCredentialCandidate[]> }>("credentials")
  const sources = useLiveQuery(async () => {
    const [accounts, adapters] = await Promise.all([
      listAllIntegrationAccounts(),
      listAdapterInstances(),
    ])
    return { accounts, adapters }
  }, [])

  const forSlot = useCallback(
    (slot: Pick<PluginBotCredentialSlot, "id" | "integration">) =>
      host.remote
        ? (host.data?.groups[slot.integration ?? ""] ?? [])
        : buildCredentialCandidates({
            slot,
            accounts: sources?.accounts ?? [],
            adapters: sources?.adapters ?? [],
          }),
    [sources, host.remote, host.data]
  )

  return {
    forSlot,
    failed: host.failed,
    loading: host.remote ? host.loading : sources === undefined,
  }
}

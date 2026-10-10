"use client"

/**
 * One conversation's FileSpace, live (ADR-0222 §1).
 *
 * A Dexie live query over `loadConversationFileSpace`: the session row, its
 * uploads, its artifacts and its bound sandbox connection are all Dexie reads,
 * so any write to them re-resolves the FileSpace. The three inputs that live in
 * zustand stores instead — the workspace list, the host being driven and the
 * app-wide sandbox tier — are passed as dependencies so a change to them
 * re-runs the query too.
 *
 * Temporary (not yet persisted) session assets are held in memory by
 * `session-assets.ts`, outside Dexie's change tracking; they appear here once
 * their message is persisted, which is when they become part of the
 * conversation.
 */

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { loadConversationFileSpace, type LoadedConversationFileSpace } from "@/lib/filespace/load"
import { useProjectStore } from "@/stores/project/project-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

export function useConversationFileSpace(
  sessionId: string | null
): LoadedConversationFileSpace | null | undefined {
  const projects = useProjectStore((state) => state.projects)
  const activeHostId = useRemoteHostStore((state) => state.activeHostId)
  const activeHostState = useRemoteHostStore(
    (state) => state.hosts.find((host) => host.id === state.activeHostId)?.connectionState ?? null
  )
  const sandboxTier = useSettingsStore((state) => state.settings?.sandboxTier)
  return useClientLiveQuery<LoadedConversationFileSpace | null>(
    () => (sessionId ? loadConversationFileSpace(sessionId) : null),
    [sessionId, projects, activeHostId, activeHostState, sandboxTier],
    null
  )
}

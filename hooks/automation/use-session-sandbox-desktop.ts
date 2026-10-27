"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { resolveCharacterById } from "@/lib/db/characters"
import { getSession } from "@/lib/db/sessions"
import { getSandboxConnection } from "@/lib/db/sandbox-connections"
import { bindingRoutesGuiToConnection, resolveSandboxSessionBinding } from "@/lib/sandbox/binding"
import { projectSandboxConnectionCapabilities } from "@/lib/sandbox/runtime-availability"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** Reuse execution's settings ladder; this never provisions or starts a connection. */
export function useSessionSandboxDesktop(
  sessionId: string | null,
  targetConnectionId?: string | null
) {
  const sandboxTier = useSettingsStore((state) => state.settings?.sandboxTier)
  return useLiveQuery(async () => {
    if (!sessionId || targetConnectionId === null) return null
    const session = targetConnectionId ? undefined : await getSession(sessionId)
    if (!session && !targetConnectionId) return null
    const character = session?.characterId
      ? await resolveCharacterById(session.characterId)
      : undefined
    const binding = session
      ? resolveSandboxSessionBinding({
          session,
          character,
          appSettings: { sandboxTier },
        })
      : null
    if (!targetConnectionId && (!binding || !bindingRoutesGuiToConnection(binding))) return null
    const connectionId = targetConnectionId ?? binding!.connectionId!
    const connection = await getSandboxConnection(connectionId)
    const docker = connection?.config.provider === "docker" ? connection.config : undefined
    const lume = connection?.config.provider === "lume" && connection.config.contractVersion === 1
    return {
      connectionId,
      name: connection?.name,
      containerId: docker?.containerId,
      ...(lume && connection?.config.provider === "lume"
        ? {
            allowStreaming: false,
            transferTargetId: `lume:${connection.config.resourceId}:${connection.config.generation}:${connection.config.bootEpoch}`,
            transferFolder: "/workspace",
          }
        : {}),
      enabled: Boolean(
        connection &&
        (docker || lume) &&
        connection.state === "running" &&
        projectSandboxConnectionCapabilities(connection, isTauri()).gui
      ),
    }
  }, [sessionId, sandboxTier, targetConnectionId])
}

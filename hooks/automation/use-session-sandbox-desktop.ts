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
export function useSessionSandboxDesktop(sessionId: string | null) {
  const sandboxTier = useSettingsStore((state) => state.settings?.sandboxTier)
  return useLiveQuery(async () => {
    if (!sessionId) return null
    const session = await getSession(sessionId)
    if (!session) return null
    const character = session.characterId
      ? await resolveCharacterById(session.characterId)
      : undefined
    const binding = resolveSandboxSessionBinding({
      session,
      character,
      appSettings: { sandboxTier },
    })
    if (!bindingRoutesGuiToConnection(binding)) return null
    const connectionId = binding.connectionId!
    const connection = await getSandboxConnection(connectionId)
    const docker = connection?.config.provider === "docker" ? connection.config : undefined
    return {
      connectionId,
      containerId: docker?.containerId,
      enabled: Boolean(
        connection &&
        docker &&
        connection.state === "running" &&
        projectSandboxConnectionCapabilities(connection, isTauri()).gui
      ),
    }
  }, [sessionId, sandboxTier])
}

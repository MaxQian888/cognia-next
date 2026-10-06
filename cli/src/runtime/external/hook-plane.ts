import type { InstalledExternalAgentHookPlane } from "@/lib/ai/agent/external/host/installed-host"

/**
 * The CLI's external-agent hook plane: no settings hooks and no plugin event
 * hooks (ADR-0217).
 *
 * The desktop hook runtime depends on Tauri and persisted desktop hook state,
 * neither of which belongs in the standalone CLI host. Running no hook is the
 * deliberate CLI v1 policy until a CLI-native hook loader is introduced; the
 * shared bridge (`@/lib/ai/agent/external/agent-hooks`) still builds every
 * notice, so a loader only has to replace this plane.
 */
export const cliAgentHookPlane: InstalledExternalAgentHookPlane = Object.freeze({
  run: async () => null,
  pluginHooks: null,
})

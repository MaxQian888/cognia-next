import type { WorkflowNodeKind } from "@/types/workflow/visual"

const aliasesByPlugin = new Map<string, Map<string, string>>()

export function registerWorkflowKindAliases(
  pluginId: string,
  aliases: Record<string, string>
): void {
  const normalized = new Map<string, string>()
  for (const [legacyKind, currentKind] of Object.entries(aliases)) {
    if (!legacyKind.trim() || !currentKind.trim()) {
      throw new Error("Workflow kind aliases require non-empty source and target kinds")
    }
    if (
      currentKind !== "trigger.integration.event" &&
      !currentKind.startsWith(`${pluginId}.action.`)
    ) {
      throw new Error(
        `Workflow kind alias target "${currentKind}" must belong to plugin "${pluginId}"`
      )
    }
    normalized.set(legacyKind, currentKind)
  }
  aliasesByPlugin.set(pluginId, normalized)
}

export function unregisterWorkflowKindAliases(pluginId: string): void {
  aliasesByPlugin.delete(pluginId)
}

export function resolveWorkflowKindAlias(kind: string): WorkflowNodeKind {
  for (const aliases of aliasesByPlugin.values()) {
    const resolved = aliases.get(kind)
    if (resolved) return resolved as WorkflowNodeKind
  }
  return kind as WorkflowNodeKind
}

export function __resetWorkflowKindAliasesForTesting(): void {
  aliasesByPlugin.clear()
}

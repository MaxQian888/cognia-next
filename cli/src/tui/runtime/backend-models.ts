/**
 * The external agent's OWN model catalog, for `/model`.
 *
 * The picker used to render `collectModelOptions(config)` unconditionally — the
 * built-in provider's catalog — so hosting Codex offered a list of models Codex
 * cannot run, and picking one sent that id straight into `thread/start`
 * (unvalidated on the Codex side). This module is the honest source: the models
 * the connected agent reports for itself.
 *
 * Two agents answer without a session and they answer differently. Codex's
 * native app-server has `model/list`. Pi shells its own `pi --list-models`,
 * reached through the manager's `fetchAgentModelCatalog`, and asking only the
 * Codex adapter is why `/model` on a connected Pi reported no models at all
 * while `pi --list-models` printed dozens. Every other protocol scopes its
 * models to a live session and is answered there, by the session's own
 * `listModels`, not here.
 *
 * Fetched LAZILY, on first open. Neither route needs a session, so the picker
 * works before the first turn; the adapter caches the result, so reopening the
 * picker costs nothing. Doing it at connect instead would put a round-trip on
 * every startup for a menu most sessions never open.
 */
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"

/** One selectable model as the picker renders it. */
export interface ExternalModelOption {
  id: string
  /** Human label from the agent (`displayName`), when it supplies one. */
  name?: string
}

/** The slice of the manager this needs — named exactly as the real methods, so
 * a rename breaks the build here rather than at runtime (same contract as
 * {@link BackendConnectHost}). */
export interface BackendModelHost {
  listExternalModels(agentId: string): Promise<ExternalModelOption[]>
}

/**
 * Ask the connected agent for its models. Returns `[]` when the agent has no
 * model-list method or the call fails — the caller surfaces that as "this agent
 * does not offer model selection", never as a broken picker.
 */
export function defaultBackendModelHost(): BackendModelHost {
  return {
    async listExternalModels(agentId: string): Promise<ExternalModelOption[]> {
      const manager = getExternalAgentManager({ healthCheckInterval: 0 })
      try {
        // The shared catalog first: it is the route that answers for a
        // pull-based adapter (Pi), and it reports `unsupported` rather than
        // throwing for every agent with nothing to say before a session opens.
        const catalog = await manager.fetchAgentModelCatalog(agentId)
        if (catalog.status === "ok" && catalog.data.models.choices.length > 0) {
          return catalog.data.models.choices.map((choice) => ({
            id: choice.modelId,
            ...(choice.name && choice.name !== choice.modelId ? { name: choice.name } : {}),
          }))
        }
      } catch {
        // Fall through to the Codex route rather than failing the picker. The
        // two are independent sources, and one being wedged says nothing about
        // the other.
      }
      const adapter = manager.getCodexAppServerAdapter(agentId)
      if (!adapter) return []
      try {
        const models = await adapter.listModels()
        return models.map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }))
      } catch {
        // A wedged or half-connected agent must not take the picker down; an
        // empty list reads as "no models offered", which is what the user sees.
        return []
      }
    },
  }
}

/** Render label for one external model row: the agent's own display name, with
 * the raw id alongside it when they differ (the id is what actually gets sent). */
export function formatExternalModelLabel(model: ExternalModelOption): string {
  return model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id
}

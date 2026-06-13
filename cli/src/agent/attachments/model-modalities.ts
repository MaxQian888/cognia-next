/**
 * Look up a model's accepted input modalities from the bundled models.dev
 * snapshot to decide whether a PDF can be sent as a native attachment block.
 * Node-safe: imports only the JSON snapshot (no Dexie/Tauri). Unknown models
 * resolve to `[]` so the caller conservatively falls back to OCR.
 *
 * Snapshot shape: `snapshot[providerOrg].models[modelId].modalities.input`.
 */
import snapshot from "@/lib/ai/providers/models-dev-snapshot.json"

interface ModelEntry {
  modalities?: { input?: string[] }
}
interface ProviderEntry {
  models?: Record<string, ModelEntry>
}
const SNAPSHOT = snapshot as unknown as Record<string, ProviderEntry>

export function modelInputModalities(provider: string, model: string): string[] {
  const direct = SNAPSHOT[provider]?.models?.[model]?.modalities?.input
  if (direct) return direct
  // Gateway-style ids carry the org: "google/gemini-2.5-pro".
  if (model.includes("/")) {
    const slash = model.indexOf("/")
    const org = model.slice(0, slash)
    const id = model.slice(slash + 1)
    const viaOrg = SNAPSHOT[org]?.models?.[id]?.modalities?.input
    if (viaOrg) return viaOrg
  }
  // Last resort: an exact model-id match under any provider org.
  for (const p of Object.values(SNAPSHOT)) {
    const hit = p.models?.[model]?.modalities?.input
    if (hit) return hit
  }
  return []
}

export function modelSupportsPdfInput(provider: string, model: string): boolean {
  return modelInputModalities(provider, model).includes("pdf")
}

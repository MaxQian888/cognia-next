/**
 * Synchronous per-model capability lookups against the bundled models.dev
 * snapshot — the single offline source of truth for model *traits* (reasoning
 * support, accepted input modalities) shared by BOTH execution surfaces so they
 * judge a model identically:
 *   - the desktop/web + CLI reasoning-effort gate (`lib/ai/reasoning-capability.ts`),
 *   - the CLI attachment modality gate
 *     (`cli/src/agent/attachments/model-modalities.ts`).
 *
 * Node-safe: imports ONLY the JSON snapshot (no Dexie/Tauri), so it resolves in
 * the CLI's headless Node runtime and the browser bundle alike. A model the
 * snapshot doesn't carry resolves to `undefined` / `[]` so callers degrade
 * conservatively (a heuristic fallback, or OCR for an attachment).
 *
 * Snapshot shape: `snapshot[providerOrg].models[modelId]`.
 */
import snapshot from "./models-dev-snapshot.json"

interface SnapshotModel {
  reasoning?: boolean
  modalities?: { input?: string[]; output?: string[] }
}
interface SnapshotProvider {
  models?: Record<string, SnapshotModel>
}

const SNAPSHOT = snapshot as unknown as Record<string, SnapshotProvider>

/**
 * Resolve a model entry from the snapshot, trying in order:
 *   1. the provider's own models (`snapshot[provider].models[model]`),
 *   2. a gateway-style `org/model` id (`snapshot[org].models[id]`),
 *   3. an exact model-id match under ANY provider org (model ids are ~global).
 * Returns `undefined` when nothing matches.
 */
export function lookupSnapshotModel(provider: string, model: string): SnapshotModel | undefined {
  const direct = SNAPSHOT[provider]?.models?.[model]
  if (direct) return direct
  // Gateway-style ids carry the org: "google/gemini-2.5-pro".
  if (model.includes("/")) {
    const slash = model.indexOf("/")
    const viaOrg = SNAPSHOT[model.slice(0, slash)]?.models?.[model.slice(slash + 1)]
    if (viaOrg) return viaOrg
  }
  // Last resort: an exact model-id match under any provider org.
  for (const p of Object.values(SNAPSHOT)) {
    const hit = p.models?.[model]
    if (hit) return hit
  }
  return undefined
}

/**
 * The model's `reasoning` capability per models.dev, or `undefined` when the
 * snapshot doesn't carry the model — letting the caller fall back to a heuristic
 * (an id pattern) rather than guessing.
 */
export function snapshotModelReasoning(provider: string, model: string): boolean | undefined {
  return lookupSnapshotModel(provider, model)?.reasoning
}

/** The model's accepted input modalities per models.dev (`[]` when unknown). */
export function snapshotInputModalities(provider: string, model: string): string[] {
  return lookupSnapshotModel(provider, model)?.modalities?.input ?? []
}

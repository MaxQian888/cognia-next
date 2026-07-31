/**
 * Synchronous per-model capability lookups against the bundled models.dev
 * snapshot — the single offline source of truth for model *traits* (reasoning
 * support, accepted input modalities) shared by BOTH execution surfaces so they
 * judge a model identically:
 *   - the desktop/web + CLI reasoning-effort gate (`lib/ai/reasoning-capability.ts`),
 *   - the CLI attachment modality gate
 *     (`cli/src/agent/attachments/model-modalities.ts`).
 *
 * Node-safe: imports ONLY the compact capability index (no Dexie/Tauri), so it resolves in
 * the CLI's headless Node runtime and the browser bundle alike. A model the
 * snapshot doesn't carry resolves to `undefined` / `[]` so callers degrade
 * conservatively (a heuristic fallback, or OCR for an attachment).
 *
 * Capability index shape: `capabilities[providerOrg][modelId]`.
 */
import capabilities from "./models-dev-capabilities.json"

interface SnapshotModel {
  r?: boolean
  i?: string[]
}

const SNAPSHOT = capabilities as Record<string, Record<string, SnapshotModel>>
const MODEL_BY_ID = new Map<string, SnapshotModel>()
for (const provider of Object.values(SNAPSHOT)) {
  for (const [modelId, model] of Object.entries(provider)) {
    if (!MODEL_BY_ID.has(modelId)) MODEL_BY_ID.set(modelId, model)
  }
}

/**
 * Resolve a model entry from the snapshot, trying in order:
 *   1. the provider's own models (`snapshot[provider].models[model]`),
 *   2. a gateway-style `org/model` id (`snapshot[org].models[id]`),
 *   3. an exact model-id match under ANY provider org (model ids are ~global).
 * Returns `undefined` when nothing matches.
 */
export function lookupSnapshotModel(provider: string, model: string): SnapshotModel | undefined {
  const direct = SNAPSHOT[provider]?.[model]
  if (direct) return direct
  // Gateway-style ids carry the org: "google/gemini-2.5-pro".
  if (model.includes("/")) {
    const slash = model.indexOf("/")
    const viaOrg = SNAPSHOT[model.slice(0, slash)]?.[model.slice(slash + 1)]
    if (viaOrg) return viaOrg
  }
  return MODEL_BY_ID.get(model)
}

/**
 * The model's `reasoning` capability per models.dev, or `undefined` when the
 * snapshot doesn't carry the model — letting the caller fall back to a heuristic
 * (an id pattern) rather than guessing.
 */
export function snapshotModelReasoning(provider: string, model: string): boolean | undefined {
  return lookupSnapshotModel(provider, model)?.r
}

/** The model's accepted input modalities per models.dev (`[]` when unknown). */
export function snapshotInputModalities(provider: string, model: string): string[] {
  return lookupSnapshotModel(provider, model)?.i ?? []
}

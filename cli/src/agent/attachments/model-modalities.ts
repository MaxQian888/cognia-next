/**
 * Look up a model's accepted input modalities from the bundled models.dev
 * snapshot to decide whether an attachment can be sent as a native block
 * (image / PDF) or must fall back to OCR. Node-safe: the snapshot lookup imports
 * only the JSON snapshot (no Dexie/Tauri). Unknown models resolve to `[]` so the
 * caller conservatively falls back to OCR.
 *
 * The snapshot lookup lives in `@/lib/ai/providers/models-dev-snapshot-lookup`
 * so the CLI and the desktop/web reasoning-effort gate read the SAME models.dev
 * data through one resolver.
 */
import { snapshotInputModalities } from "@/lib/ai/providers/models-dev-snapshot-lookup"

export function modelInputModalities(provider: string, model: string): string[] {
  return snapshotInputModalities(provider, model)
}

export function modelSupportsPdfInput(provider: string, model: string): boolean {
  return modelInputModalities(provider, model).includes("pdf")
}

export function modelSupportsImageInput(provider: string, model: string): boolean {
  return modelInputModalities(provider, model).includes("image")
}

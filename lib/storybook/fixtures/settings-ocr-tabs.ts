// Storybook fixtures for the `components/settings/ocr/tabs/*` stories.
// Kept framework-agnostic (no JSX) so it can be imported from any *.stories.tsx.

import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"
import type { OcrResultRow } from "@/lib/db/ocr-results"
import type { AutoRouterProviderOption } from "@/components/settings/ocr/tabs/ocr-auto-router-panel"
import type { ModelStatus, OcrModelBridge } from "@/components/settings/ocr/tabs/ocr-models-tab"

/** Build a realistic settings blob from the shipped defaults. */
export function makeOcrSettings(overrides: Partial<UserOcrSettings> = {}): UserOcrSettings {
  return { ...DEFAULT_OCR_SETTINGS, ...overrides }
}

/** Provider options as surfaced in the Auto-Router default/fallback dropdowns. */
export const AUTO_ROUTER_PROVIDERS: AutoRouterProviderOption[] = [
  { id: "mistral-ocr", label: "Mistral OCR", isCloudOrVision: true },
  { id: "google-vision", label: "Google Cloud Vision", isCloudOrVision: true },
  { id: "anthropic-vision", label: "Claude Vision", isCloudOrVision: true },
  { id: "tesseract-wasm", label: "Tesseract (WASM)", isCloudOrVision: false },
  { id: "ocrs", label: "ocrs (local)", isCloudOrVision: false },
]

/** A single Dexie `ocrResults` cache row. */
export function makeOcrCacheRow(overrides: Partial<OcrResultRow> = {}): OcrResultRow {
  const providerId = overrides.providerId ?? "mistral-ocr"
  const langs = overrides.langs ?? "en"
  const id = overrides.id ?? `sha-${providerId}-${langs}-${Math.random().toString(36).slice(2)}`
  return {
    id,
    fileSha: overrides.fileSha ?? "deadbeef",
    providerId,
    langs,
    result: overrides.result ?? JSON.stringify({ providerId, pages: [], cached: false }),
    createdAt: overrides.createdAt ?? Date.now() - 3_600_000,
    bytesIn: overrides.bytesIn ?? 240_000,
  }
}

/**
 * In-memory stand-in for the Tauri model-manager bridge. Injected into
 * `OcrModelsTab` / `LocalModelManager` so stories render the Rust-backed UI
 * without a Tauri runtime.
 */
export function makeOcrModelBridge(initial: Partial<ModelStatus> = {}): OcrModelBridge {
  const status: ModelStatus = {
    backend: "ocrs",
    installed: false,
    model_dir: "/home/user/.cognia/ocr-models/ocrs",
    files: [
      { file_name: "text-detection.rten", installed: false, expected_bytes: 8_300_000 },
      { file_name: "text-recognition.rten", installed: false, expected_bytes: 14_700_000 },
    ],
    total_bytes: 0,
    ...initial,
  }
  return {
    async status() {
      return status
    },
    async download() {
      return {
        ...status,
        installed: true,
        total_bytes: status.files.reduce((sum, f) => sum + f.expected_bytes, 0),
        files: status.files.map((f) => ({ ...f, installed: true, actual_bytes: f.expected_bytes })),
      }
    },
    onProgress: () => () => {},
  }
}

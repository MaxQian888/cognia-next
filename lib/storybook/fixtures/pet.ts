// Storybook-only fixture builders for the Settings → Pet Live2D components.
// `makePetModelRow` shapes a `petModels` Dexie row for the config dialog, and
// `makeDiscoveredModels` produces the `DiscoveredModel[]` the import dialog
// lists (a mix of valid + invalid groups, so the disabled/error rows show).
import type { PetModelRow } from "@/lib/db/pet-models"
import type { DiscoveredModel } from "@/lib/pet/live2d/discover-models"
import type { ModelFileEntry } from "@/lib/pet/live2d/types"

/** A realistic installed-model row with motion groups + expressions to map. */
export function makePetModelRow(over: Partial<PetModelRow> = {}): PetModelRow {
  return {
    id: "pm_story_hiyori",
    name: "Hiyori",
    source: "import",
    settingsPath: "Hiyori/Hiyori.model3.json",
    motionGroups: ["Idle", "TapBody", "FlickHead"],
    expressionIds: ["F01", "F02", "F03"],
    totalBytes: 4_812_204,
    createdAt: Date.UTC(2026, 5, 20, 10, 0),
    ...over,
  }
}

/** A tiny placeholder entry — only the path/size metadata matters for the UI. */
function entry(path: string): ModelFileEntry {
  return { path, blob: new Blob(["x"], { type: "application/octet-stream" }) }
}

/**
 * Two valid models + one invalid group, as produced by `discoverLive2dModels`
 * over a multi-model bundle. The invalid row renders disabled with its error.
 */
export function makeDiscoveredModels(): DiscoveredModel[] {
  return [
    {
      key: "Hiyori/Hiyori.model3.json",
      name: "Hiyori",
      settingsPath: "Hiyori/Hiyori.model3.json",
      entries: [entry("Hiyori/Hiyori.model3.json"), entry("Hiyori/Hiyori.moc3")],
      totalBytes: 4_812_204,
      valid: true,
    },
    {
      key: "Mao/Mao.model3.json",
      name: "Mao",
      settingsPath: "Mao/Mao.model3.json",
      entries: [entry("Mao/Mao.model3.json"), entry("Mao/Mao.moc3")],
      totalBytes: 6_104_880,
      valid: true,
    },
    {
      key: "Broken/Broken.model3.json",
      name: "Broken",
      settingsPath: "Broken/Broken.model3.json",
      entries: [entry("Broken/Broken.model3.json")],
      totalBytes: 1_024,
      valid: false,
      errorCode: "missingReferenced",
    },
  ]
}

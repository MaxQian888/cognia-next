/**
 * Dexie persistence for the workflow-editor performance-tier setting.
 *
 * Reads `AppSettings.workflowEditorPerformanceTier` (`undefined` → `"auto"`)
 * and writes through `saveSettings`, which already serializes concurrent
 * writes via its read-modify-write queue.
 */

import { getSettings, saveSettings } from "@/lib/db/settings"
import { isPerformanceTier, type PerformanceTier } from "@/lib/workflow/editor/performance-tier"

export async function loadPerformanceTierPref(): Promise<PerformanceTier> {
  const s = await getSettings()
  const raw = s.workflowEditorPerformanceTier
  return isPerformanceTier(raw) ? raw : "auto"
}

export async function savePerformanceTierPref(tier: PerformanceTier): Promise<void> {
  await saveSettings({ workflowEditorPerformanceTier: tier })
}

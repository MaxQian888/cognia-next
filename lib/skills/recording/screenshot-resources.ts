/**
 * Project a recording trace's inline screenshots into skill resource drafts.
 *
 * Pure (no DB). Screenshots become `asset` resources (base64 PNG) under
 * `assets/step-NN.png`, giving the generated skill visual reference without ever
 * sending images to the model. Capped so a long recording can't bloat IndexedDB.
 */

import type { SkillResourceDraft } from "@/lib/db/skill-resources"
import { inlineScreenshotBytes, type RecordingTrace } from "./types"

export const MAX_SCREENSHOT_RESOURCES = 24

export type ScreenshotResourceDraft = Omit<SkillResourceDraft, "skillId">

export function buildScreenshotResources(
  trace: RecordingTrace,
  max: number = MAX_SCREENSHOT_RESOURCES
): ScreenshotResourceDraft[] {
  const out: ScreenshotResourceDraft[] = []
  for (const obs of trace.observations) {
    if (out.length >= max) break
    const bytes = inlineScreenshotBytes(obs)
    if (!bytes) continue
    const n = String(out.length + 1).padStart(2, "0")
    out.push({
      kind: "asset",
      name: `step-${n}.png`,
      path: `assets/step-${n}.png`,
      content: bytes,
      encoding: "base64",
      mimeType: "image/png",
    })
  }
  return out
}

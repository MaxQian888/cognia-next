/**
 * Turning selected frames into skill resources, and linking them from the body.
 *
 * The naming is `assets/recording-step-###.png`, three-digit zero-padded so a
 * directory listing sorts in step order past 99. The prefix distinguishes these
 * from resources a user added by hand — deleting a recording's frames should not
 * take their screenshots with it.
 *
 * Links are inserted **under the step they belong to** rather than appended in a
 * block: a skill body where every image sits at the bottom tells the reader
 * nothing about which step it illustrates.
 */

import type { SkillResourceDraft } from "@/lib/db/skill-resources"

import { includedSteps, type RecordedStepView } from "./step-model"

export const MAX_PROMOTED_SCREENSHOTS = 24
export const ASSET_PREFIX = "recording-step"

export type ScreenshotResourceDraft = Omit<SkillResourceDraft, "skillId">

export interface PromotedAsset {
  /** The step whose frame this is. */
  seq: number
  assetId: string
  path: string
  name: string
}

export function assetFileName(index: number): string {
  return `${ASSET_PREFIX}-${String(index + 1).padStart(3, "0")}.png`
}

/**
 * Which frames to promote, in timeline order.
 *
 * Capped: a 400-step recording would otherwise put hundreds of megabytes of
 * base64 into IndexedDB, and a skill nobody can open is not a useful artifact.
 * The cap is reported so the UI can say what was left out.
 */
export function planPromotion(
  views: readonly RecordedStepView[],
  max: number = MAX_PROMOTED_SCREENSHOTS
): { assets: PromotedAsset[]; skipped: number } {
  const selected = includedSteps(views).filter(
    (view) => view.screenshotSelected && view.captured?.assetId
  )
  const assets = selected.slice(0, max).map((view, index) => ({
    seq: view.seq,
    assetId: view.captured!.assetId!,
    name: assetFileName(index),
    path: `assets/${assetFileName(index)}`,
  }))
  return { assets, skipped: Math.max(0, selected.length - assets.length) }
}

/** Pair each planned asset with its base64 bytes, fetched by the caller. */
export function buildResourceDrafts(
  assets: readonly PromotedAsset[],
  bytesById: ReadonlyMap<string, string>
): ScreenshotResourceDraft[] {
  const drafts: ScreenshotResourceDraft[] = []
  for (const asset of assets) {
    const content = bytesById.get(asset.assetId)
    // A frame we could not read is skipped rather than written empty: an
    // `<img>` pointing at a zero-byte resource is worse than no image.
    if (!content) continue
    drafts.push({
      kind: "asset",
      name: asset.name,
      path: asset.path,
      content,
      encoding: "base64",
      mimeType: "image/png",
    })
  }
  return drafts
}

const STEP_LINE = /^(\s*)(\d+)\.\s/

/**
 * Insert relative image links under the numbered steps in `## Steps`.
 *
 * Matching is positional — the Nth numbered line gets the asset planned for the
 * Nth included step — because the model rewrites step text freely but preserves
 * the ordering it was given. Anything beyond the assets we have is left alone.
 */
export function injectImageLinks(
  markdown: string,
  assets: readonly PromotedAsset[],
  altFor: (index: number) => string
): string {
  if (assets.length === 0) return markdown

  const lines = markdown.split("\n")
  const out: string[] = []
  let inSteps = false
  let stepIndex = 0

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      // `## Steps` is the only section whose numbered lines are steps; the same
      // pattern in `## Verify` is a checklist.
      inSteps = /steps/i.test(line)
      out.push(line)
      continue
    }
    out.push(line)
    if (!inSteps) continue
    const match = STEP_LINE.exec(line)
    if (!match) continue
    const asset = assets[stepIndex]
    stepIndex += 1
    if (!asset) continue
    out.push("", `${match[1]}   ![${altFor(stepIndex - 1)}](${asset.path})`, "")
  }
  return out.join("\n")
}

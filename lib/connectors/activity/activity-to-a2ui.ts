/**
 * Build the live-activity A2UI surface (Feature A card + Feature B diff).
 * Pure function — mirrors `buildCumulativeStatusSurface` in
 * `workflow-to-a2ui.ts`: one `Card` whose children are `Text` lines while
 * running and `Collapsible`-per-edit at the terminal state.
 *
 * Component vocabulary (Card / Text / Collapsible) is the same one the
 * A2UI mapper (`adapters/_shared/a2ui-mapper.ts`) projects to platform-native
 * rich content (Lark interactive cards, Slack Block Kit, Telegram, Discord).
 * Adapters that can't render a component fall back to `widget.fallbackText`,
 * which `a2ui-to-segments.ts:buildA2UISegment` bakes into the segment's
 * `plainTextMirror` — so every adapter gets a readable card either way.
 */
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { diffHunksToUnifiedText } from "./diff-producer"
import type { ActivityI18n } from "./i18n"
import type { TurnActivitySnapshot } from "./turn-activity-tracker"

/** Max unified-diff lines per file in the terminal expandable body. */
const DIFF_MAX_LINES = 30

function seconds(elapsedMs: number): number {
  return Math.max(0, Math.round(elapsedMs / 1000))
}

/**
 * Render the activity snapshot as an A2UI surface.
 *
 *   - `running` — title shows tool count · edit count · elapsed, plus a
 *     current-tool line. Edits are NOT detailed (keep the live card compact).
 *   - `done` / `failed` — title shows the verb + elapsed; every accumulated
 *     file edit becomes a `Collapsible` whose label is the `+N −M` summary
 *     and whose body is the truncated unified diff (or a "too large" note).
 */
export function buildActivitySurface(
  snapshot: TurnActivitySnapshot,
  i18n: ActivityI18n
): A2UISegmentContent {
  const secs = seconds(snapshot.elapsedMs)
  const isRunning = snapshot.status === "running"
  const headerIcon = snapshot.status === "done" ? "✓" : snapshot.status === "failed" ? "✗" : "🔧"
  const title = isRunning
    ? `${headerIcon} ${i18n.tools(snapshot.toolCount)} · ${i18n.edits(snapshot.editCount)} · ${i18n.elapsed(secs)}`
    : `${headerIcon} ${
        snapshot.status === "done" ? i18n.done : i18n.failed
      } · ${i18n.elapsed(secs)}`

  const components: Record<string, unknown> = {
    root: { component: "Card", title, children: [] as string[] },
  }
  const childIds: string[] = []
  const mirrorLines: string[] = [`# ${title}`]

  if (isRunning) {
    if (snapshot.currentTool) {
      const line = i18n.currentTool(snapshot.currentTool)
      components.currentTool = { component: "Text", text: line }
      childIds.push("currentTool")
      mirrorLines.push(line)
    }
  } else {
    for (let i = 0; i < snapshot.edits.length; i++) {
      const edit = snapshot.edits[i]
      const label =
        edit.kind === "write"
          ? i18n.fileCreated(edit.filePath, edit.added)
          : i18n.fileEdited(edit.filePath, edit.added, edit.removed)
      const bodyText =
        edit.tooLarge || edit.hunks.length === 0
          ? i18n.diffSkipped
          : diffHunksToUnifiedText(edit.hunks, edit.filePath, DIFF_MAX_LINES).text
      const bodyId = `edit_${i}_body`
      const collId = `edit_${i}`
      components[bodyId] = { component: "Text", text: bodyText }
      components[collId] = {
        component: "Collapsible",
        label: `✏️ ${label}`,
        children: [bodyId],
      }
      childIds.push(collId)
      mirrorLines.push(`✏️ ${label}`)
      mirrorLines.push(bodyText)
    }
  }

  ;(components.root as { children: string[] }).children = childIds

  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: { fallbackText: mirrorLines.join("\n") },
  }
}

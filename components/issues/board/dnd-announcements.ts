/**
 * Localized dnd-kit announcements for the issue board.
 *
 * dnd-kit ships English-only default announcements and screen-reader
 * instructions, and they are read aloud — so they are user-facing strings like
 * any other and have to come from the message catalog. Same reasoning, and the
 * same shape, as `components/chat/run-panel.tsx`.
 *
 * The announcements are built from the SAME `resolveIssueDropPreview` the
 * insertion indicator uses, so what a screen reader hears and what a sighted
 * user sees can never disagree about where the card is about to land — and a
 * refused column announces the refusal rather than staying silent.
 */

import type { Announcements } from "@dnd-kit/core"

import type { IssueDropPreview } from "@/lib/issues/board-model"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"

export interface IssueDndAnnouncementContext {
  itemsById: ReadonlyMap<string, UnifiedIssueItem>
  /** How many cards a column holds, for "position 2 of 5". */
  columnSize: (status: IssueStatus) => number
  /** Localized column name. */
  statusLabel: (status: IssueStatus) => string
  /** The board's own preview resolver, already bound to the run context. */
  preview: (activeId: string, overId: string | null) => IssueDropPreview | null
  /** Message lookup under `issues.board.dnd.*`. */
  t: (key: string, values?: Record<string, string | number>) => string
}

/** dnd-kit hands ids as `UniqueIdentifier`; normalize to the string we use. */
function idOf(value: { id: string | number } | null | undefined): string | null {
  return value ? String(value.id) : null
}

export function buildIssueDndAnnouncements(ctx: IssueDndAnnouncementContext): Announcements {
  const describe = (activeId: string | null, overId: string | null, phase: "over" | "end") => {
    if (!activeId) return undefined
    const item = ctx.itemsById.get(activeId)
    if (!item) return undefined

    if (!overId) {
      return ctx.t("cancelled", {
        identifier: item.identifier,
        column: ctx.statusLabel(item.status),
      })
    }

    const preview = ctx.preview(activeId, overId)
    if (!preview) {
      // The column exists but refuses this card — say so rather than going
      // quiet, which a screen-reader user would read as "nothing happened".
      return ctx.t("denied", { identifier: item.identifier })
    }

    // `preview.index` is an insertion index into the column WITHOUT the dragged
    // card; spoken position is 1-based and the total includes the card itself.
    const total = ctx.columnSize(preview.status) + (preview.status === item.status ? 0 : 1)
    return ctx.t(phase === "over" ? "over" : "dropped", {
      identifier: item.identifier,
      column: ctx.statusLabel(preview.status),
      position: preview.index + 1,
      total,
    })
  }

  return {
    onDragStart: ({ active }) => {
      const item = ctx.itemsById.get(String(active.id))
      if (!item) return undefined
      return ctx.t("pickedUp", {
        identifier: item.identifier,
        column: ctx.statusLabel(item.status),
      })
    },
    onDragOver: ({ active, over }) => describe(String(active.id), idOf(over), "over"),
    onDragEnd: ({ active, over }) => describe(String(active.id), idOf(over), "end"),
    onDragCancel: ({ active }) => {
      const item = ctx.itemsById.get(String(active.id))
      if (!item) return undefined
      return ctx.t("cancelled", {
        identifier: item.identifier,
        column: ctx.statusLabel(item.status),
      })
    },
  }
}

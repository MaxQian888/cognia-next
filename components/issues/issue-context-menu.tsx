"use client"

/**
 * Right-click menu for an issue, shared by the list rows and the board cards.
 *
 * This is the main surface where six previously-unreachable writes became
 * reachable — status, priority, assignee, labels, container, delete. It speaks
 * `IssueBulkAction` even for a single issue so there is exactly ONE vocabulary
 * and exactly ONE capability gate (`canApplyBulkAction`) between the context
 * menu, the bulk toolbar and the detail panel.
 *
 * A THIN SHELL: what the menu offers, what is disabled and what is ticked all
 * come from `lib/issues/menu-model.ts`. Keep it that way — ADR-0132 requires
 * board decisions to stay out of the components, and there is a second reason
 * here: Radix nested submenus do not fire their selection events under jsdom,
 * so an entry built inline could be proved to render but never proved to carry
 * the right action.
 *
 * Refused actions are DISABLED, not hidden. ADR-0132 is explicit that the UI
 * disables honestly rather than failing at write time, and a menu whose shape
 * changes per row is a menu users stop trusting.
 */

import { CheckIcon } from "lucide-react"
import { useMemo } from "react"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { IssueBulkAction } from "@/lib/issues/bulk-actions"
import { buildIssueMenuSections, canDeleteIssue } from "@/lib/issues/menu-model"
import type { IssueProject } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import type { AssigneeOption } from "./assignee-picker"
import { useMenuEntryPresentation } from "./editors/menu-entry-presentation"

export interface IssueContextMenuProps {
  item: UnifiedIssueItem
  /** A run is in flight, which locks the status submenu. */
  running?: boolean
  labels: readonly LabelRow[]
  projects: readonly IssueProject[]
  assigneeOptions: readonly AssigneeOption[]
  onAction: (action: IssueBulkAction) => void
  onOpen?: () => void
  /** Opens the confirmation dialog; deletion never happens from the menu itself. */
  onRequestDelete?: () => void
  children: ReactNode
}

export function IssueContextMenu({
  item,
  running = false,
  labels,
  projects,
  assigneeOptions,
  onAction,
  onOpen,
  onRequestDelete,
  children,
}: IssueContextMenuProps) {
  const t = useTranslations("issues")

  const sections = useMemo(
    () => buildIssueMenuSections({ item, running, labels, projects, assigneeOptions }),
    [item, running, labels, projects, assigneeOptions]
  )
  const presentation = useMenuEntryPresentation({ labels, projects, assigneeOptions })

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild data-testid={`issue-context-trigger-${item.unifiedId}`}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {onOpen ? (
          <>
            <ContextMenuItem onSelect={onOpen} data-testid="issue-context-open">
              {t("context.open")}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}

        {sections.map((section) => (
          <ContextMenuSub key={section.id}>
            <ContextMenuSubTrigger data-testid={`issue-context-${section.id}`}>
              {presentation.sectionLabel(section.id)}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-52">
              {section.entries.map((entry) => (
                <ContextMenuItem
                  key={entry.id}
                  disabled={entry.disabled}
                  onSelect={() => onAction(entry.action)}
                  data-testid={`issue-context-${section.id}-${entry.id}`}
                >
                  {presentation.entryIcon(section.id, entry)}
                  <span className="flex-1 truncate">
                    {presentation.entryLabel(section.id, entry)}
                  </span>
                  {entry.checked ? <CheckIcon className="size-3.5" /> : null}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ))}

        {onRequestDelete ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={!canDeleteIssue(item, running)}
              onSelect={onRequestDelete}
              data-testid="issue-context-delete"
            >
              {t("context.delete")}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}

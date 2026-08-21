"use client"

/**
 * One editable property in the inspector, as a dropdown.
 *
 * Same entries, same capability gating and same action payloads as the
 * right-click menu — both render `buildIssueMenuSections`. Two components exist
 * only because Radix's context menu and dropdown menu are different
 * primitives, not because the two surfaces make different decisions.
 *
 * Labels keep the menu open after a pick: applying three labels should be
 * three clicks, not three round-trips through a closed menu.
 */

import { CheckIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { IssueBulkAction } from "@/lib/issues/bulk-actions"
import type { IssueMenuSection } from "@/lib/issues/menu-model"
import { cn } from "@/lib/utils"
import type { MenuEntryPresentation } from "./menu-entry-presentation"

export interface IssuePropertyMenuProps {
  section: IssueMenuSection
  presentation: MenuEntryPresentation
  onAction: (action: IssueBulkAction) => void
  /** What the closed menu shows — the property's current value. */
  children: ReactNode
  /** Every entry is refused; render the value without a trigger. */
  disabled?: boolean
  testId: string
}

export function IssuePropertyMenu({
  section,
  presentation,
  onAction,
  children,
  disabled,
  testId,
}: IssuePropertyMenuProps) {
  // A trigger that can do nothing is worse than no trigger: it invites a click
  // that opens a menu where every row is greyed out.
  if (disabled) {
    return (
      <span className="inline-flex items-center gap-1.5" data-testid={`${testId}-static`}>
        {children}
      </span>
    )
  }

  const keepOpen = section.id === "labels"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2 h-7 min-w-0 justify-start gap-1.5 px-2 font-normal"
          data-testid={testId}
        >
          {children}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>{presentation.sectionLabel(section.id)}</DropdownMenuLabel>
        {section.entries.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            disabled={entry.disabled}
            onSelect={(event) => {
              if (keepOpen) event.preventDefault()
              onAction(entry.action)
            }}
            data-testid={`${testId}-${entry.id}`}
          >
            {presentation.entryIcon(section.id, entry)}
            <span className="min-w-0 flex-1 truncate">
              {presentation.entryLabel(section.id, entry)}
            </span>
            <CheckIcon className={cn("size-3.5", !entry.checked && "invisible")} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

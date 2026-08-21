"use client"

/**
 * One collapsible band of the issue rail.
 *
 * Extracted because the rail has three of them and they were about to be three
 * copies of the same disclosure + header + count markup. Purely presentational:
 * open state is the caller's, so the rail can decide what persists.
 */

import { ChevronDownIcon } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface IssueRailSectionProps {
  id: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Optional trailing control, e.g. "manage labels". Exactly one of `onSelect`
   * or `href` — a header control either does something here or goes somewhere,
   * and a button that navigates is a link wearing the wrong hat.
   */
  action?: {
    label: string
    icon: ReactNode
    testId?: string
  } & ({ onSelect: () => void; href?: never } | { href: string; onSelect?: never })
  /** Rendered instead of the children when there is nothing to list. */
  emptyText?: string
  isEmpty?: boolean
  children: ReactNode
}

export function IssueRailSection({
  id,
  title,
  open,
  onOpenChange,
  action,
  emptyText,
  isEmpty,
  children,
}: IssueRailSectionProps) {
  const bodyId = `issue-rail-section-${id}`

  return (
    <section className="flex flex-col gap-0.5" data-testid={bodyId}>
      <header className="flex items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid={`issue-rail-toggle-${id}`}
          className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-[3px]"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground",
              "motion-safe:transition-transform motion-safe:duration-150",
              !open && "-rotate-90"
            )}
          />
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
        </button>
        {action ? (
          <Button
            asChild={Boolean(action.href)}
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            aria-label={action.label}
            title={action.label}
            onClick={action.onSelect}
            data-testid={action.testId}
          >
            {/*
              The test id goes on the child as well: under `asChild` the Slot
              hands its props to the child, and a wrapper-only id would vanish.
            */}
            {action.href ? (
              <Link href={action.href} data-testid={action.testId}>
                {action.icon}
              </Link>
            ) : (
              action.icon
            )}
          </Button>
        ) : null}
      </header>

      {open ? (
        <div className="flex flex-col gap-0.5 px-1 pb-1">
          {isEmpty && emptyText ? (
            <p className="px-2 py-1.5 text-xs italic text-muted-foreground">{emptyText}</p>
          ) : (
            children
          )}
        </div>
      ) : null}
    </section>
  )
}

"use client"

/**
 * The tracker's destination switcher, shared by `/issues` and `/projects`.
 *
 * The two routes are one subsystem: `/issues` is the board and `/projects` is
 * the console for the containers that board groups by. They shipped as
 * unrelated pages in two different navigation groups, with different chrome
 * and no shared rail, so moving between them read as leaving one feature for
 * another rather than as changing what you are looking at.
 *
 * Destinations, not filters, which is why this sits above `IssueRail`'s
 * sections rather than inside them: every row in those sections narrows the
 * board in place, and mixing a navigation into them is how a user loses the
 * board they were reading (see the note at the top of `issue-rail.tsx`).
 */

import { CircleDotIcon, FolderKanbanIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

export type TrackerDestination = "issues" | "projects"

export interface TrackerNavProps {
  /** Which route is rendering this. */
  active: TrackerDestination
}

const DESTINATIONS = [
  { id: "issues", href: "/issues", icon: CircleDotIcon, labelKey: "title" },
  { id: "projects", href: "/projects", icon: FolderKanbanIcon, labelKey: "projects.title" },
] as const satisfies readonly {
  id: TrackerDestination
  href: string
  icon: typeof CircleDotIcon
  labelKey: string
}[]

export function TrackerNav({ active }: TrackerNavProps) {
  const t = useTranslations("issues")

  return (
    <nav
      aria-label={t("rail.trackerNav")}
      className="flex flex-col gap-0.5 border-b border-border/60 p-2"
      data-testid="tracker-nav"
    >
      {DESTINATIONS.map((destination) => {
        const Icon = destination.icon
        const current = destination.id === active
        return (
          <Link
            key={destination.id}
            href={destination.href}
            // `aria-current` rather than a pressed state: these are links, and
            // the active one is where you already are, not something toggled.
            aria-current={current ? "page" : undefined}
            data-testid={`tracker-nav-${destination.id}`}
            className={cn(
              "focus-visible:ring-ring/50 flex min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-sm",
              "focus-visible:outline-none focus-visible:ring-[3px]",
              current
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{t(destination.labelKey)}</span>
          </Link>
        )
      })}
    </nav>
  )
}

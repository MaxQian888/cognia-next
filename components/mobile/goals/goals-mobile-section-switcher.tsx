"use client"

/**
 * GoalsMobileSectionSwitcher — the mobile Goals view's read-only section nav:
 * a horizontally-scrollable chip strip over Overview / History / Analytics
 * (authoring / templates / tracker stay desktop-only). Mirrors the look of
 * `CategoryChipStrip` (which is coupled to the discover layout, so it can't be
 * reused directly) so the two mobile surfaces feel identical.
 *
 * The strip is the shared Radix `Tabs`, so it behaves as a tab list: one tab
 * stop, arrow keys move focus and selection together, and each tab controls
 * the panel the caller renders through `GoalsMobileSectionPanel` (passed as
 * `children`, anywhere below the strip — e.g. inside a pull-to-refresh).
 */

import type { ComponentProps, ReactNode } from "react"
import { useTranslations } from "next-intl"
import { BarChart3Icon, HistoryIcon, LayoutDashboardIcon } from "lucide-react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export type GoalMobileSection = "overview" | "history" | "analytics"

const SECTIONS: { id: GoalMobileSection; icon: typeof LayoutDashboardIcon }[] = [
  { id: "overview", icon: LayoutDashboardIcon },
  { id: "history", icon: HistoryIcon },
  { id: "analytics", icon: BarChart3Icon },
]

const SECTION_IDS = new Set<string>(SECTIONS.map(({ id }) => id))

function isGoalMobileSection(value: string): value is GoalMobileSection {
  return SECTION_IDS.has(value)
}

export interface GoalsMobileSectionSwitcherProps {
  active: GoalMobileSection
  onSelect: (section: GoalMobileSection) => void
  className?: string
  /** The section panels (`GoalsMobileSectionPanel`), rendered after the strip. */
  children?: ReactNode
}

export function GoalsMobileSectionSwitcher({
  active,
  onSelect,
  className,
  children,
}: GoalsMobileSectionSwitcherProps) {
  const t = useTranslations("goal")

  return (
    // `contents` keeps the strip and the panels direct children of the page's
    // column, so its gap and order are unchanged.
    <Tabs
      value={active}
      onValueChange={(value) => {
        if (isGoalMobileSection(value)) onSelect(value)
      }}
      className="contents"
    >
      <TabsList
        aria-label={t("console.sectionsAria")}
        data-testid="mobile-goals-switcher"
        className={cn(
          "flex w-full snap-x snap-mandatory justify-start gap-2 overflow-x-auto rounded-none bg-transparent p-0",
          "px-4 pb-1 group-data-[orientation=horizontal]/tabs:h-auto [&::-webkit-scrollbar]:hidden",
          className
        )}
      >
        {SECTIONS.map(({ id, icon: Icon }) => (
          <TabsTrigger
            key={id}
            value={id}
            data-testid={`mobile-goals-section-${id}`}
            className={cn(
              // The look of a small outline Button, a primary one when chosen.
              "h-8 flex-none shrink-0 snap-start gap-1.5 px-3 font-normal whitespace-nowrap has-[>svg]:px-2.5",
              "border-border bg-[var(--control-bg,var(--background))] text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground",
              "dark:border-input dark:bg-input/30 dark:text-foreground dark:hover:bg-input/50",
              "data-[state=active]:border-transparent data-[state=active]:bg-primary data-[state=active]:font-medium data-[state=active]:text-primary-foreground data-[state=active]:hover:bg-primary/90 data-[state=active]:hover:text-primary-foreground",
              "group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none",
              "dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-primary dark:data-[state=active]:text-primary-foreground dark:data-[state=active]:hover:bg-primary/90"
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {t(`console.tabs.${id}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  )
}

GoalsMobileSectionSwitcher.displayName = "GoalsMobileSectionSwitcher"

export interface GoalsMobileSectionPanelProps extends Omit<
  ComponentProps<typeof TabsContent>,
  "value"
> {
  section: GoalMobileSection
}

/** The panel a section tab controls; render it inside `GoalsMobileSectionSwitcher`. */
export function GoalsMobileSectionPanel({
  section,
  className,
  ...props
}: GoalsMobileSectionPanelProps) {
  return <TabsContent value={section} className={cn("flex-none", className)} {...props} />
}

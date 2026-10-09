// The /pet console's tab navigation, one Radix tablist for every width.
//
// The rail used to be a `role="tablist"` of plain buttons with no tabpanels
// behind them (no `aria-controls`, no arrow keys), and below `md` it was swapped
// for a hamburger Sheet, so switching tabs on a phone took two taps and a
// drawer. One `TabsList` now changes shape with the viewport instead:
//
// - phone (<md): a sticky, horizontally scrolling strip with a hairline between
//   groups; one tap switches.
// - tablet (md–lg): a narrow icon rail; the label stays the tab's accessible
//   name (`sr-only`) and shows as a tooltip.
// - desktop (≥lg): the 13rem rail with group labels.
//
// It renders inside the console's `<Tabs>` root, which owns the value and the
// orientation (horizontal on the strip, vertical on the rail), so the arrow
// keys follow the direction the tabs are laid out in.
//
// On a paired phone (remote care, ADR-0219) the tabs that only run on the
// desktop stay in the list with a small "Desktop" badge, so the reader learns
// they exist and where, instead of the nav quietly shrinking.

"use client"

import { Fragment, type ComponentType } from "react"
import { useTranslations } from "next-intl"
import {
  BookOpenIcon,
  HeartIcon,
  LibraryIcon,
  MessageCircleIcon,
  MonitorIcon,
  PaletteIcon,
  PlugIcon,
  ScanLineIcon,
  ShoppingBagIcon,
  TrophyIcon,
  UsersIcon,
} from "lucide-react"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { PetConsoleTab } from "@/lib/pet/console-tabs"

export const PET_CONSOLE_TAB_ICONS: Record<PetConsoleTab, ComponentType<{ className?: string }>> = {
  nurture: HeartIcon,
  chat: MessageCircleIcon,
  shop: ShoppingBagIcon,
  customize: PaletteIcon,
  binding: UsersIcon,
  insights: ScanLineIcon,
  journal: BookOpenIcon,
  dex: LibraryIcon,
  achievements: TrophyIcon,
  plugins: PlugIcon,
}

export type PetConsoleNavGroupId = "nurture" | "personalize" | "records" | "extensions"

export const PET_CONSOLE_NAV_GROUPS: readonly {
  id: PetConsoleNavGroupId
  tabs: readonly PetConsoleTab[]
}[] = [
  { id: "nurture", tabs: ["nurture", "chat", "shop"] },
  { id: "personalize", tabs: ["customize", "binding"] },
  { id: "records", tabs: ["insights", "journal", "dex", "achievements"] },
  { id: "extensions", tabs: ["plugins"] },
]

export interface PetConsoleNavProps {
  /** Tabs this console offers (the plugins tab only while a plugin fills it). */
  visibleTabs: readonly PetConsoleTab[]
  /** Tabs that only run on the desktop in this mode; badged, still selectable. */
  desktopOnlyTabs?: ReadonlySet<PetConsoleTab>
  className?: string
}

export function PetConsoleNav({ visibleTabs, desktopOnlyTabs, className }: PetConsoleNavProps) {
  const t = useTranslations("pet")
  const groups = PET_CONSOLE_NAV_GROUPS.map((group) => ({
    ...group,
    tabs: group.tabs.filter((id) => visibleTabs.includes(id)),
  })).filter((group) => group.tabs.length > 0)

  return (
    <TabsList
      variant="line"
      data-testid="pet-console-nav"
      aria-label={t("console.navigation")}
      className={cn(
        // Phone: a sticky scrolling strip under the header.
        "sticky top-0 z-10 h-auto w-full shrink-0 justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-none border-b bg-background px-2 py-1",
        // Tablet + desktop: a full-height rail beside the pane.
        "md:static md:h-full md:w-auto md:flex-col md:items-stretch md:gap-0.5 md:overflow-x-hidden md:overflow-y-auto md:border-r md:border-b-0 md:p-2 lg:p-3",
        className
      )}
    >
      {groups.map((group, index) => (
        <Fragment key={group.id}>
          {index > 0 ? (
            <span
              aria-hidden
              data-nav-separator={group.id}
              className="mx-1 h-5 w-px shrink-0 self-center bg-border md:mx-1 md:my-1.5 md:h-px md:w-auto lg:hidden"
            />
          ) : null}
          <span
            aria-hidden
            data-nav-group={group.id}
            className={cn(
              "hidden px-2 pb-1 text-xs font-medium text-muted-foreground lg:block",
              index > 0 && "lg:pt-4"
            )}
          >
            {t(`console.groups.${group.id}`)}
          </span>
          {group.tabs.map((id) => {
            const Icon = PET_CONSOLE_TAB_ICONS[id]
            const label = t(`console.tabs.${id}`)
            const desktopOnly = desktopOnlyTabs?.has(id) === true
            const badge = t("console.desktopOnly.badge")
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <TabsTrigger
                    value={id}
                    data-tab={id}
                    data-desktop-only={desktopOnly || undefined}
                    className={cn(
                      // ≥44px tall touch targets on the strip.
                      "relative h-11 flex-none justify-start gap-2 px-3 data-[state=active]:font-semibold",
                      "md:h-9 md:w-full md:justify-center md:px-0",
                      "lg:justify-start lg:px-2"
                    )}
                  >
                    <Icon className="size-4" />
                    <span className="truncate md:sr-only lg:not-sr-only">{label}</span>
                    {desktopOnly ? (
                      <>
                        {/* Text on the strip and the full rail; the icon rail
                            has no room, so it gets a corner glyph and the
                            tooltip carries the word. */}
                        <span
                          data-testid="pet-console-desktop-badge"
                          className="shrink-0 rounded-sm bg-muted px-1 py-px text-[10px] leading-none font-medium text-muted-foreground md:sr-only lg:not-sr-only lg:ms-auto"
                        >
                          {badge}
                        </span>
                        <MonitorIcon
                          aria-hidden
                          className="absolute end-1 top-1 hidden size-2.5 text-muted-foreground md:block lg:hidden"
                        />
                      </>
                    ) : null}
                  </TabsTrigger>
                </TooltipTrigger>
                {/* Only the icon rail hides the label, so only it needs this. */}
                <TooltipContent side="right" className="hidden md:block lg:hidden">
                  {desktopOnly ? `${label} · ${badge}` : label}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </Fragment>
      ))}
    </TabsList>
  )
}

"use client"

/**
 * The expanded sidebar's bottom block: the account card, plus whatever plugins
 * pin to the rail's bottom slot.
 *
 * It used to be a Settings row. The gear moved into the account card's menu
 * (`sidebar-user-card.tsx`) because the footer was the last unclaimed line of
 * the rail and a person belongs there more than a preferences shortcut does:
 * the profile, the cloud identity bound to it, the usage it is spending and the
 * lock that closes it were spread across a status-bar glyph and two settings
 * sections, with nothing on the rail naming whose workspace this is.
 *
 * The 56px icon column keeps its own gear (`guild-rail.tsx`), so collapsing the
 * sidebar still finds Settings in the same corner.
 */

import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { cn } from "@/lib/utils"
import { SidebarUserCard } from "./sidebar-user-card"

export function SidebarFooter({ className }: { className?: string }) {
  return (
    <div
      data-testid="sidebar-footer"
      className={cn("flex shrink-0 flex-col gap-px border-t px-2 py-1", className)}
    >
      {/* Icon strip, matching the declared `icon` form factor and the icon
          column's own footer (see `sidebar-nav-section.tsx`). */}
      <PluginExtensionSlot
        point="sidebar.left.bottom"
        className="flex flex-wrap items-center gap-1 pb-1 empty:hidden"
      />
      <SidebarUserCard />
    </div>
  )
}

"use client"

import * as React from "react"
import { SlidersHorizontalIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { StatusBarZone } from "@/components/desktop/status-bar-zone"
import { ShellLayoutDialog } from "@/components/shell/shell-layout-dialog"
import { useBarLayout } from "@/components/shell/use-bar-layout"
import { PerfCaptureShellStatus } from "@/components/performance/perf-capture-shell-status"
import { useEdgePanelTransition } from "@/hooks/shell/use-edge-panel-transition"
import { SHELL_DOCK_TIMING_CLASS } from "@/lib/ui/shell-dock-motion"
import { cn } from "@/lib/utils"
import { STATUS_BAR_HEIGHT_PX } from "@/types/shell/bars"

/**
 * VSCode-style status bar mounted at the bottom of the desktop shell.
 *
 * Ambient status only: connectivity, sync, git branch, notifications, running
 * jobs, hidden agent threads, plan usage, account, and the turn's run state.
 * Controls that merely had a second home here — the sidebar toggle, the
 * permission picker, the account button's twin in the title bar — moved to
 * their single owner, and the low-frequency preferences (theme / zoom /
 * locale) live in the title bar's Views menu and the native View menu.
 *
 * Which segments appear, and in what order, is user customization persisted on
 * `AppSettings.statusBarLayout` and resolved by `useBarLayout("status")` — the
 * same settings-backed path the nav rail uses. Edit it from
 * `/settings?section=sidebar` (Bottom bar tab), the bar's own right-click menu,
 * or the title bar's Views menu. The zones are structural: `start` and `end`
 * hug the window edges and `center` is the flexible middle, so an item moves
 * within its own zone rather than across the bar.
 *
 * The `statusbar.*` plugin extension slots are NOT customizable — they are
 * owned by whichever plugin contributes to them, and each already self-hides
 * when empty. Desktop-only segments (sync / perf / usage) drop out of the
 * catalog entirely off the Tauri shell, so no per-segment `isTauri()` gate is
 * needed here.
 *
 * ## Collapsing
 *
 * The View menu's "hide the status bar" used to unmount it, which dropped 24px
 * out of the window in one frame and pushed everything above it down. It now
 * animates its own height to zero on the shell's shared edge-panel clock
 * (`useEdgePanelTransition`), with the bar's row held at its full height behind
 * a clip so the segments slide past the window edge instead of being squashed
 * toward each other by `items-center`.
 */
export function StatusBar({ collapsed = false }: { collapsed?: boolean }) {
  const t = useTranslations("desktop.shellLayout")
  const { resolved } = useBarLayout("status")
  const [customizeOpen, setCustomizeOpen] = React.useState(false)
  const barRef = React.useRef<HTMLElement | null>(null)
  const animating = useEdgePanelTransition(collapsed, { element: barRef })

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <footer
            ref={barRef}
            data-app-chrome
            data-collapsed={collapsed || undefined}
            // Tint, no border — see `guild-rail.tsx`. Same rule as the title bar it
            // mirrors at the other edge of the window.
            className={cn(
              "hidden shrink-0 bg-muted/40 text-[11px] select-none md:block",
              // Clipped only while it is shut or moving, so a segment's popover
              // arrow and focus ring are not shaved off the resting bar.
              (collapsed || animating) && "overflow-hidden",
              animating && `transition-[height] ${SHELL_DOCK_TIMING_CLASS}`
            )}
            style={{ height: collapsed ? 0 : STATUS_BAR_HEIGHT_PX }}
            aria-hidden={collapsed || undefined}
            inert={collapsed || undefined}
            data-testid="status-bar"
          >
            {/* Fixed-height row, anchored to the bar's top edge so the segments
                travel down with it rather than crushing together. */}
            <div className="flex h-6 items-center gap-0">
              {/* No "Tauri" / "Web" badge: it never changes for a given install, so it
          spent a permanent slot restating something the user already knows.
          No session name either — the chat header shows it three rows up, in
          bigger type, where the conversation actually is. */}

              <StatusBarZone items={resolved.zones.start} />

              <PluginExtensionSlot
                point="statusbar.left"
                className="flex h-6 items-center gap-1 px-1 empty:hidden"
              />

              {/* No permission-mode picker here. The composer's `PermissionModeIndicator`
          is the single entry point: it sits where the mode is about to take
          effect and doubles as the "what will this turn run as" readout, which a
          bottom-bar copy could only duplicate. The elevated modes it refuses to
          cycle through (bypassPermissions / dontAsk / auto) stay reachable in the
          session settings sheet and the agent-runtime defaults tab. */}

              {/* The flexible middle. It is the spacer that pushes the end cluster to
          the right edge AND the home of the centre zone. `flex-1` lives on this
          wrapper rather than on a fallback span, so the spacing survives a
          plugin contributing to the slot. */}
              <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
                <PerfCaptureShellStatus className="flex min-w-0 items-center gap-1" />
                <PluginExtensionSlot
                  point="statusbar.center"
                  className="flex h-6 items-center gap-1 empty:hidden"
                />
                <StatusBarZone items={resolved.zones.center} />
              </div>

              <StatusBarZone items={resolved.zones.end} />

              {/* Theme, zoom and locale moved to the title bar's Views menu (and stay in
          the native View menu / ⌘±). Three permanent slots for preferences a
          user sets once and then leaves alone was the clearest case of the
          bottom bar charging rent for configuration rather than status. */}

              <PluginExtensionSlot
                point="statusbar.right"
                className="flex h-6 items-center gap-1 px-1 empty:hidden"
              />
            </div>
          </footer>
        </ContextMenuTrigger>
        {/* Right-click is where a VSCode user reaches for this, and unlike a
            permanent gear it costs the bar no width. */}
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => setCustomizeOpen(true)}
            data-testid="status-bar-customize"
          >
            <SlidersHorizontalIcon className="size-4" aria-hidden />
            {t("customizeStatusBar")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <ShellLayoutDialog open={customizeOpen} onOpenChange={setCustomizeOpen} surface="status" />
    </>
  )
}

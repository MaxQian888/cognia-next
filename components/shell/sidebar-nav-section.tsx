"use client"

/**
 * The shell navigation as labelled rows — the expanded sidebar's top block.
 *
 * Same destinations as the 56px icon column (`guild-rail.tsx`), read from the
 * same `useShellNav`; only the rendering differs: an icon+label row per entry
 * instead of a tooltip'd square. Order and grouping mirror the rail so the
 * two states of the sidebar feel like one thing folding and unfolding:
 *
 *   Canvas · plugin view containers          ← workspace modes (chat guilds)
 *   ─────
 *   pinned features (right-click to customize) · More…
 *
 * Direct Messages and the teams are not here — they are the accordion
 * sections beneath (`sidebar-guild-sections.tsx`), because they own the list.
 */

import { useState, type ComponentPropsWithRef, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronRightIcon,
  EllipsisIcon,
  EyeOffIcon,
  PencilRulerIcon,
  PinIcon,
  PinOffIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { MotionSelectionIndicator } from "@/components/chat/motion/motion-reveal"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { ResolvedRailIcon } from "@/components/shell/plugin-view-container-panel"
import { ShellLayoutDialog } from "./shell-layout-dialog"
import { useShellNav } from "./use-shell-nav"

/** One highlight travels between every row of the expanded sidebar. */
export const SIDEBAR_SELECTION_GROUP = "sidebar-nav-selection"

export interface SidebarRowProps extends Omit<
  ComponentPropsWithRef<"button">,
  "children" | "onClick"
> {
  active?: boolean
  onClick?: () => void
  /** Leading glyph — an icon, an avatar, a chevron. */
  icon: ReactNode
  label: string
  /** Trailing content (count, chevron), drawn after the label. */
  trailing?: ReactNode
  /** Sets `aria-current="page"` when active; `false` for pure toggles. */
  current?: boolean
  testId?: string
}

/**
 * The sidebar's row: 32px, icon + label, the shared travelling highlight
 * behind it. Used by the nav section, the guild accordion headers and the
 * footer so all three read as one list. Rest props (and `ref`) reach the
 * button, so it can be a Radix `asChild` trigger directly.
 */
export function SidebarRow({
  active = false,
  onClick,
  icon,
  label,
  trailing,
  current = true,
  className,
  testId,
  ...rest
}: SidebarRowProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      {...rest}
      onClick={onClick}
      aria-current={active && current ? "page" : undefined}
      data-active={active || undefined}
      data-testid={testId}
      className={cn(
        "relative h-8 w-full min-w-0 justify-start gap-2.5 rounded-md px-2 text-[13px] font-normal",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        className
      )}
    >
      <MotionSelectionIndicator
        groupId={SIDEBAR_SELECTION_GROUP}
        active={active}
        className="absolute inset-0 rounded-md bg-primary/10"
      />
      <span className="relative flex size-4 shrink-0 items-center justify-center [&>svg]:size-4">
        {icon}
      </span>
      <span className="relative min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing ? <span className="relative flex shrink-0 items-center">{trailing}</span> : null}
    </Button>
  )
}

export function SidebarNavSection({ className }: { className?: string }) {
  const t = useTranslations("desktop.guildRail")
  const pluginT = useTranslations()
  const {
    isCanvasActive,
    isViewContainerActive,
    isFeatureActive,
    overflowActive,
    railContainers,
    layout: { resolved, pin, unpin, hide },
    switchToCanvas,
    switchToViewContainer,
    goToFeature,
  } = useShellNav()
  const [moreOpen, setMoreOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)

  const openOverflowItem = (route: string) => {
    setMoreOpen(false)
    goToFeature(route)
  }
  const openCustomize = () => {
    setMoreOpen(false)
    setCustomizeOpen(true)
  }

  return (
    <nav
      aria-label={t("navigation")}
      data-testid="sidebar-nav"
      className={cn("flex shrink-0 flex-col gap-px px-2 pt-2 pb-1", className)}
    >
      <PluginExtensionSlot point="sidebar.left.top" className="flex flex-col gap-px empty:hidden" />
      <SidebarRow
        active={isCanvasActive}
        onClick={switchToCanvas}
        icon={<PencilRulerIcon />}
        label={t("canvas")}
        testId="sidebar-nav-canvas"
      />
      {railContainers.map((c) => {
        const title = resolvePluginLabel(pluginT as never, c.pluginId, c.def.titleKey, c.def.title)
        return (
          <SidebarRow
            key={c.fullId}
            active={isViewContainerActive(c.fullId)}
            onClick={() => switchToViewContainer(c.fullId)}
            icon={<ResolvedRailIcon name={c.def.icon} className="size-4" />}
            label={title}
            testId={`sidebar-nav-view-container-${c.fullId}`}
          />
        )
      })}

      {resolved.pinned.length > 0 || resolved.overflow.length > 0 ? (
        <Separator className="my-1" aria-label={t("featuresGroup")} />
      ) : null}

      {resolved.pinned.map((item) => (
        <ContextMenu key={item.id}>
          <ContextMenuTrigger asChild>
            <div>
              <SidebarRow
                active={isFeatureActive(item.route)}
                onClick={() => goToFeature(item.route)}
                icon={<item.Icon />}
                label={t(item.i18nKey)}
                testId={`sidebar-nav-feature-${item.id}`}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => void unpin(item.id)}>
              <PinOffIcon className="size-4" />
              {t("customize.moveToMore")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void hide(item.id)}>
              <EyeOffIcon className="size-4" />
              {t("customize.hideItem")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => setCustomizeOpen(true)}>
              <SlidersHorizontalIcon className="size-4" />
              {t("customize.title")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}

      {resolved.overflow.length > 0 ? (
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild>
            <SidebarRow
              active={overflowActive}
              icon={<EllipsisIcon />}
              label={t("more")}
              trailing={<ChevronRightIcon className="size-3.5 text-muted-foreground/70" />}
              current={false}
              testId="sidebar-nav-more"
            />
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="w-56 p-1">
            <div className="flex flex-col">
              {resolved.overflow.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center rounded hover:bg-accent",
                    isFeatureActive(item.route) && "bg-primary/10 text-foreground"
                  )}
                >
                  <Button
                    variant="ghost"
                    onClick={() => openOverflowItem(item.route)}
                    data-testid={`sidebar-nav-more-item-${item.id}`}
                    className="h-auto min-w-0 flex-1 justify-start rounded px-2 py-1.5 font-normal"
                  >
                    <item.Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-left">{t(item.i18nKey)}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("customize.pinItem", { item: t(item.i18nKey) })}
                    data-testid={`sidebar-nav-more-pin-${item.id}`}
                    onClick={() => void pin(item.id)}
                    className="mr-1 size-7 shrink-0"
                  >
                    <PinIcon className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Separator className="my-1" />
              <Button
                variant="ghost"
                onClick={openCustomize}
                data-testid="sidebar-nav-more-customize"
                className="h-auto w-full justify-start rounded px-2 py-1.5 font-normal"
              >
                <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
                <span className="flex-1 text-left">{t("customize.title")}</span>
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}

      <ShellLayoutDialog open={customizeOpen} onOpenChange={setCustomizeOpen} surface="sidebar" />
    </nav>
  )
}

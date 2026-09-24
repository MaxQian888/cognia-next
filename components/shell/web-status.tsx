"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { StatusBarZone } from "@/components/desktop/status-bar-zone"
import { useBarLayout } from "@/components/shell/use-bar-layout"
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"
import { splitStatusBarScopes } from "@/lib/shell/bar-items"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { useUIStore } from "@/stores/ui/ui-store"
import { DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"

type SessionHost = "context" | "composer" | "header"
const HOST_PRIORITY: Record<SessionHost, number> = { context: 0, composer: 1, header: 2 }

const SESSION_CLASSES: Record<SessionHost, string> = {
  context:
    "flex items-center gap-0.5 empty:hidden [&_button]:h-7 [&_button]:px-2 [&_button]:rounded-md [&_button]:text-xs [&_svg]:size-3.5",
  composer:
    "flex items-center gap-0.5 empty:hidden [&_button]:h-7 [&_button]:px-2 [&_button]:rounded-md [&_button]:text-[11px] [&_svg]:size-3.5",
  header:
    "flex items-center gap-0.5 border-l border-border/50 ps-1.5 ms-1 empty:hidden [&_button]:h-7 [&_button]:rounded-md [&_button]:px-1.5 [&_button]:text-[11px] [&_svg]:size-3.5",
}
const RAIL_STACK =
  "flex flex-col items-center gap-1 pb-1.5 empty:hidden " +
  "[&_button]:size-9 [&_button]:justify-center [&_button]:gap-0 [&_button]:rounded-panel " +
  "[&_button]:px-0 [&_button]:text-[0px] [&_button_svg]:size-[18px] " +
  "[&_[data-slot=badge]]:text-[9px] [&_[data-testid=account-bar-button]_span]:text-[10px]"
const PILL_CLUSTER =
  "flex items-center gap-0.5 [&_button]:h-7 [&_button]:px-1.5 [&_button]:rounded-full [&_button]:text-[11px] [&_button_svg]:size-3.5"

interface WebStatusContextValue {
  scopes: ReturnType<typeof splitStatusBarScopes>
  owner: string | undefined
  register: (id: string, host: SessionHost) => () => void
  /** The inline host that has taken the global scope from the corner pill. */
  globalOwner: string | undefined
  registerGlobal: (id: string) => () => void
}
const WebStatusContext = createContext<WebStatusContextValue | null>(null)

/**
 * Real hosts register their lifetime, not DOM anchors. One owner wins by host
 * priority, then mount order, so split panes cannot duplicate global readouts.
 * Kept separate from title-bar outlets: these segments render locally and must
 * never be projected into an unrelated column's React context.
 */
export function WebStatusProvider({
  enabled,
  children,
}: {
  enabled: boolean
  children: ReactNode
}) {
  return enabled ? <EnabledWebStatusProvider>{children}</EnabledWebStatusProvider> : children
}

function EnabledWebStatusProvider({ children }: { children: ReactNode }) {
  const { resolved } = useBarLayout("status")
  const scopes = useMemo(() => splitStatusBarScopes(resolved), [resolved])
  const [hosts, setHosts] = useState<{ id: string; host: SessionHost }[]>([])
  const register = useCallback((id: string, host: SessionHost) => {
    setHosts((previous) => [...previous, { id, host }])
    return () => setHosts((previous) => previous.filter((entry) => entry.id !== id))
  }, [])
  const owner = [...hosts].sort((a, b) => HOST_PRIORITY[a.host] - HOST_PRIORITY[b.host])[0]?.id
  // Inline hosts for the GLOBAL scope, in mount order. The first one takes it;
  // with none mounted it falls back to the corner pill.
  const [globalHosts, setGlobalHosts] = useState<string[]>([])
  const registerGlobal = useCallback((id: string) => {
    setGlobalHosts((previous) => [...previous, id])
    return () => setGlobalHosts((previous) => previous.filter((entry) => entry !== id))
  }, [])
  const globalOwner = globalHosts[0]
  const value = useMemo(
    () => ({ scopes, owner, register, globalOwner, registerGlobal }),
    [scopes, owner, register, globalOwner, registerGlobal]
  )
  return <WebStatusContext.Provider value={value}>{children}</WebStatusContext.Provider>
}

/** With no web-shell provider (Tauri, mobile, bypass routes), mounts are inert. */
export function WebSessionStatus({ host }: { host: SessionHost }) {
  const context = useContext(WebStatusContext)
  const register = context?.register
  const id = useId()
  useIsomorphicLayoutEffect(() => register?.(id, host), [register, id, host])
  if (!context || context.owner !== id) return null
  return (
    <div className={SESSION_CLASSES[host]} data-testid={`web-status-${host}`}>
      <StatusBarZone items={context.scopes.session} />
    </div>
  )
}

export function WebGlobalStatusRail({ collapsed }: { collapsed: boolean }) {
  const context = useContext(WebStatusContext)
  if (!context || collapsed) return null
  return (
    <div className={RAIL_STACK} data-testid="web-status-rail">
      <StatusBarZone items={context.scopes.global} />
    </div>
  )
}

/** Store owns visibility; measurement follows the dock's actual animation/size. */
function useBottomDockClearance() {
  const open = useTerminalStore((s) => s.panelOpen && s.panelPosition === "bottom" && !s.maximized)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (!open) return
    const dock = document.querySelector<HTMLElement>(
      '[data-testid="terminal-dock-region"][data-position="bottom"][data-open="true"]'
    )
    if (!dock) return
    const measure = () => setHeight(dock.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [open])
  return (open ? height : 0) + 10
}

/**
 * Whether the global scope needs a home outside the rail: the rail is folded
 * away (or the sidebar hosts navigation instead), and the user has not
 * collapsed the status bar. On web, statusBarCollapsed hides only this
 * fallback, never host chrome.
 */
function useGlobalScopeUnhoused(): boolean {
  const railCollapsed = useUIStore((s) => s.guildRailCollapsed)
  const sidebarHostsNav = useShellColumnsStore((s) => s.sidebarHostsNav)
  const collapsed = useUIStore((s) => s.statusBarCollapsed)
  return (railCollapsed || sidebarHostsNav) && !collapsed
}

/**
 * The global scope, carried by a docked host — the chat composer's status
 * line — instead of the corner pill.
 *
 * The pill is `fixed` to the viewport's bottom corner, which is exactly where
 * a docked composer puts its toolbar's "⋯": in the default web layout, on any
 * window short of ~1400px, the pill sat on top of that button (and every
 * control folded behind it), and lifting the pill would only have moved it
 * onto the send button. So a surface that owns that corner takes the global
 * items into its own row and the pill stands down while it is mounted — same
 * items, same condition, one place.
 */
export function WebGlobalStatusInline({ className }: { className?: string }) {
  const context = useContext(WebStatusContext)
  const registerGlobal = context?.registerGlobal
  const id = useId()
  const unhoused = useGlobalScopeUnhoused()
  useIsomorphicLayoutEffect(() => registerGlobal?.(id), [registerGlobal, id])
  if (!context || context.globalOwner !== id || !unhoused) return null
  return (
    <div className={cn(SESSION_CLASSES.composer, className)} data-testid="web-status-global-inline">
      <StatusBarZone items={context.scopes.global} />
    </div>
  )
}

/** Fallback home of the global scope when neither the rail nor an inline host has it. */
export function WebGlobalStatusPill() {
  const context = useContext(WebStatusContext)
  const unhoused = useGlobalScopeUnhoused()
  return context && unhoused && !context.globalOwner ? (
    <CornerPill items={context.scopes.global} />
  ) : null
}

function CornerPill({ items }: { items: WebStatusContextValue["scopes"]["global"] }) {
  const side = useSettingsStore((s) => s.settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE)
  const bottom = useBottomDockClearance()
  return (
    <div
      className={cn(
        PILL_CLUSTER,
        "fixed z-40 rounded-full border border-border/60 bg-popover/90 px-1.5 py-1 shadow-md backdrop-blur empty:hidden",
        side === "right" ? "left-3" : "right-3"
      )}
      style={{ bottom }}
      data-testid="web-status-corner-pill"
    >
      <StatusBarZone items={items} />
    </div>
  )
}

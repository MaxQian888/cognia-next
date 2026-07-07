"use client"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { loggers } from "@/lib/logging"
import { isTauri } from "@/lib/tauri"
import {
  applyZoom,
  clampZoom,
  DEFAULT_ZOOM,
  formatZoomPercent,
  ZOOM_STEP,
} from "@/lib/tauri/webview-zoom"
import { cn } from "@/lib/utils"
import { useChatStore, type PermissionMode } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"
import { useBarItemVisible, useUIStore } from "@/stores/ui/ui-store"
import { useActiveSessionLabel } from "@/hooks/chat/use-active-session-label"
import {
  GlobeIcon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PlusIcon,
  RotateCcwIcon,
  SunIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { StatusBarBranch } from "@/components/source-control/status-bar-branch"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { JobCenterPanel } from "@/components/desktop/job-center-panel"
import { StatusBarConnectivity } from "@/components/desktop/status-bar-connectivity"
import { StatusBarSync } from "@/components/desktop/status-bar-sync"
import { StatusBarPerf } from "@/components/desktop/status-bar-perf"
import { StatusBarUsage } from "@/components/desktop/status-bar-usage"
import { AccountBarButton } from "@/components/account/account-bar-button"

import {
  ADVANCED_MODES,
  permissionRiskMarker,
  SAFE_CYCLE_MODES,
} from "@/lib/settings/permission-mode-meta"

const log = loggers.ui

/**
 * VSCode-style status bar mounted at the bottom of the desktop shell.
 * Each segment is an interactive button — sidebar toggle, session,
 * permission, theme, zoom, locale, notifications.
 */
export function StatusBar() {
  const t = useTranslations("desktop.statusBar")

  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])
  const isDesktop = mounted && isTauri()

  const status = useChatStore((s) => s.status)
  const permissionMode = useChatStore((s) => s.permissionMode)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)

  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)

  // Optional segments — each self-hides when its data source is absent; here we
  // additionally gate mounting so a hidden segment sets up no subscriptions
  // (critical for perf, which starts native sampling on mount).
  const showConnectivity = useBarItemVisible("connectivity")
  const showSync = useBarItemVisible("sync")
  const showPerf = useBarItemVisible("perf")
  const showUsage = useBarItemVisible("usage")
  const showAccount = useBarItemVisible("accountStatus")

  const persistedZoom = useSettingsStore((s) => s.settings?.webviewZoom)
  const language = useSettingsStore((s) => s.language)
  const setLanguage = useSettingsStore((s) => s.setLanguage)
  const saveSettings = useSettingsStore((s) => s.save)

  const { theme, setTheme } = useTheme()

  const { label } = useActiveSessionLabel()
  const sessionLabel = label ?? t("noSession")
  const statusLabel = statusLabelFor(status, t)
  const zoom = clampZoom(persistedZoom ?? DEFAULT_ZOOM)

  const cycleTheme = () => {
    const order: ("light" | "dark" | "system")[] = ["light", "dark", "system"]
    const cur = (theme as "light" | "dark" | "system" | undefined) ?? "system"
    const next = order[(order.indexOf(cur) + 1) % order.length]
    log.info("status-bar cycleTheme", { from: cur, to: next })
    setTheme(next)
    // Persist to settings as well — otherwise SettingsSyncProvider re-applies
    // the stale persisted theme on the next settings change/reload and reverts
    // this choice. Mirrors the appearance ThemeTab (setTheme + save).
    void saveSettings({ theme: next }).catch((err) =>
      log.warn("status-bar theme persist failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    )
  }

  const cycleLocale = () => {
    const next = language === "en" ? "zh-CN" : "en"
    log.info("status-bar cycleLocale", { from: language, to: next })
    void setLanguage(next).catch((err) =>
      log.warn("setLanguage failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    )
  }

  const openCommandPalette = () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))
  }

  const handleZoomChange = async (kind: "in" | "out" | "reset") => {
    const base = zoom
    const target =
      kind === "reset" ? DEFAULT_ZOOM : kind === "in" ? base + ZOOM_STEP : base - ZOOM_STEP
    const next = await applyZoom(target)
    try {
      await saveSettings({ webviewZoom: next })
    } catch (err) {
      log.warn("status-bar zoom persist failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const localeShort = language === "zh-CN" ? "中" : "EN"

  return (
    <footer
      data-app-chrome
      className="hidden h-6 shrink-0 items-center gap-0 border-t bg-muted/40 text-[11px] select-none md:flex"
      data-testid="status-bar"
    >
      <StatusItem onClick={toggleSidebar} aria-label={t("toggleSidebar")} testId="status-sidebar">
        <PanelLeftIcon
          aria-hidden
          className={cn("size-3", sidebarCollapsed ? "opacity-60" : "opacity-100")}
        />
      </StatusItem>

      <StatusItem testId="status-runtime" aria-label={isDesktop ? t("tauri") : t("web")}>
        {isDesktop ? (
          <MonitorIcon aria-hidden className="size-3" />
        ) : (
          <GlobeIcon aria-hidden className="size-3" />
        )}
        <span>{isDesktop ? t("tauri") : t("web")}</span>
      </StatusItem>

      {showConnectivity && <StatusBarConnectivity />}

      <StatusBarBranch />

      {isDesktop && showSync && <StatusBarSync />}

      <StatusItem
        onClick={openCommandPalette}
        aria-label={t("openCommandPalette")}
        testId="status-session"
      >
        <span className="max-w-[18ch] truncate text-muted-foreground">{sessionLabel}</span>
      </StatusItem>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="status-permission"
            className="flex h-6 shrink-0 items-center gap-1.5 px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t("permissionMode")}: {permissionLabelFor(permissionMode, t)}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={4} className="w-52 p-1">
          <div className="flex flex-col gap-0.5">
            {SAFE_CYCLE_MODES.map((mode) => (
              <PermissionModeOption
                key={mode}
                mode={mode}
                active={permissionMode === mode || (mode === "default" && permissionMode === null)}
                onSelect={setPermissionMode}
                t={t}
              />
            ))}
            <div className="my-1 flex items-center gap-2 px-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {t("permissionAdvanced")}
              <span className="h-px flex-1 bg-border" />
            </div>
            {ADVANCED_MODES.map((mode) => (
              <PermissionModeOption
                key={mode}
                mode={mode}
                active={permissionMode === mode}
                onSelect={setPermissionMode}
                t={t}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <PluginExtensionSlot
        point="statusbar.left"
        className="flex h-6 items-center gap-1 px-1 empty:hidden"
      />

      <PluginExtensionSlot
        point="statusbar.center"
        className="flex h-6 items-center gap-1 empty:hidden"
        fallback={<span className="flex-1 min-w-0" />}
      />

      <NotificationBell />

      <JobCenterPanel />

      {isDesktop && showPerf && <StatusBarPerf />}

      {isDesktop && showUsage && <StatusBarUsage />}

      {showAccount && <AccountBarButton />}

      <StatusItem testId="status-status" aria-label={statusLabel}>
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            status === "streaming" && "animate-pulse bg-primary",
            status === "awaiting_approval" && "bg-amber-500",
            status === "error" && "bg-destructive",
            status === "idle" && "bg-muted-foreground/50"
          )}
        />
        <span>{statusLabel}</span>
      </StatusItem>

      <StatusItem onClick={cycleTheme} aria-label={t("themeNext")} testId="status-theme">
        {mounted && theme === "light" ? (
          <SunIcon aria-hidden className="size-3" />
        ) : mounted && theme === "dark" ? (
          <MoonIcon aria-hidden className="size-3" />
        ) : (
          <MonitorIcon aria-hidden className="size-3" />
        )}
      </StatusItem>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="status-zoom"
            aria-label={t("zoom")}
            className="flex h-6 shrink-0 items-center gap-1 px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {formatZoomPercent(zoom)}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={4} className="w-44 p-1">
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void handleZoomChange("out")}
              aria-label={t("zoomOut")}
              data-testid="status-zoom-out"
            >
              <MinusIcon className="size-3.5" />
            </Button>
            <span className="text-xs font-medium" data-testid="status-zoom-value">
              {formatZoomPercent(zoom)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void handleZoomChange("in")}
              aria-label={t("zoomIn")}
              data-testid="status-zoom-in"
            >
              <PlusIcon className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void handleZoomChange("reset")}
              aria-label={t("zoomReset")}
              data-testid="status-zoom-reset"
            >
              <RotateCcwIcon className="size-3.5" />
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <StatusItem onClick={cycleLocale} aria-label={t("switchLocale")} testId="status-locale">
        <span>{localeShort}</span>
      </StatusItem>

      <PluginExtensionSlot
        point="statusbar.right"
        className="flex h-6 items-center gap-1 px-1 empty:hidden"
      />
    </footer>
  )
}

function StatusItem({
  onClick,
  children,
  className,
  testId,
  ...props
}: React.HTMLAttributes<HTMLButtonElement> & { testId?: string }) {
  const interactive = typeof onClick === "function"
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      tabIndex={interactive ? 0 : -1}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1.5 px-2 text-muted-foreground transition-colors",
        interactive && "hover:bg-accent hover:text-foreground",
        !interactive && "cursor-default",
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

function permissionLabelFor(mode: PermissionMode | null, t: (key: string) => string): string {
  switch (mode) {
    case "plan":
      return t("permissionPlan")
    case "acceptEdits":
      return t("permissionAcceptEdits")
    case "bypassPermissions":
      return t("permissionBypass")
    case "dontAsk":
      return t("permissionDontAsk")
    case "auto":
      return t("permissionAuto")
    case "default":
    default:
      return t("permissionDefault")
  }
}

/** A single selectable permission mode inside the status-bar popover. Advanced
 * (elevated / danger) modes carry a risk marker so a power mode never reads the
 * same as a safe one. */
function PermissionModeOption({
  mode,
  active,
  onSelect,
  t,
}: {
  mode: PermissionMode
  active: boolean
  onSelect: (mode: PermissionMode) => void
  t: (key: string) => string
}) {
  const marker = permissionRiskMarker(mode)
  return (
    <button
      type="button"
      onClick={() => {
        log.info("status-bar setPermissionMode", { mode })
        onSelect(mode)
      }}
      className={cn(
        "flex items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-accent",
        active && "bg-accent"
      )}
      data-testid={`status-permission-${mode}`}
    >
      <span className="flex items-center gap-1.5">
        {marker && (
          <span aria-hidden className={cn(marker === "⚠" && "text-rose-500")}>
            {marker}
          </span>
        )}
        {permissionLabelFor(mode, t)}
      </span>
      {active && <span aria-hidden className="size-1.5 rounded-full bg-primary" />}
    </button>
  )
}

function statusLabelFor(
  status: "idle" | "streaming" | "awaiting_approval" | "error",
  t: (key: string) => string
): string {
  switch (status) {
    case "streaming":
      return t("streaming")
    case "awaiting_approval":
      return t("awaitingApproval")
    case "error":
      return t("error")
    default:
      return t("idle")
  }
}

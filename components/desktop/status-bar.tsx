"use client"

import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"
import { useBarItemVisible } from "@/stores/ui/ui-store"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { StatusBarBranch } from "@/components/source-control/status-bar-branch"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { JobCenterPanel } from "@/components/desktop/job-center-panel"
import { AttentionPanel } from "@/components/attention/attention-panel"
import { StatusBarConnectivity } from "@/components/desktop/status-bar-connectivity"
import { StatusBarSync } from "@/components/desktop/status-bar-sync"
import { StatusBarPerf } from "@/components/desktop/status-bar-perf"
import { StatusBarUsage } from "@/components/desktop/status-bar-usage"
import { AccountBarButton } from "@/components/account/account-bar-button"

/**
 * VSCode-style status bar mounted at the bottom of the desktop shell.
 *
 * Ambient status only: connectivity, sync, git branch, notifications, running
 * jobs, plan usage, account, and the turn's run state. Controls that merely had
 * a second home here — the sidebar toggle, the permission picker, the account
 * button's twin in the title bar — moved to their single owner, and the
 * low-frequency preferences (theme / zoom / locale) live in the title bar's
 * Views menu and the native View menu.
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

  // Optional segments — each self-hides when its data source is absent; here we
  // additionally gate mounting so a hidden segment sets up no subscriptions
  // (critical for perf, which starts native sampling on mount).
  const showConnectivity = useBarItemVisible("connectivity")
  const showSync = useBarItemVisible("sync")
  const showPerf = useBarItemVisible("perf")
  const showUsage = useBarItemVisible("usage")
  const showAccount = useBarItemVisible("accountStatus")

  const statusLabel = statusLabelFor(status, t)

  return (
    <footer
      data-app-chrome
      // Tint, no border — see `guild-rail.tsx`. Same rule as the title bar it
      // mirrors at the other edge of the window.
      className="hidden h-6 shrink-0 items-center gap-0 bg-muted/40 text-[11px] select-none md:flex"
      data-testid="status-bar"
    >
      {/* No "Tauri" / "Web" badge: it never changes for a given install, so it
          spent a permanent slot restating something the user already knows.
          No session name either — the chat header shows it three rows up, in
          bigger type, where the conversation actually is. */}

      {showConnectivity && <StatusBarConnectivity />}

      <StatusBarBranch />

      {isDesktop && showSync && <StatusBarSync />}

      {/* No permission-mode picker here. The composer's `PermissionModeIndicator`
          is the single entry point: it sits where the mode is about to take
          effect and doubles as the "what will this turn run as" readout, which a
          bottom-bar copy could only duplicate. The elevated modes it refuses to
          cycle through (bypassPermissions / dontAsk / auto) stay reachable in the
          session settings sheet and the agent-runtime defaults tab. */}

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

      <AttentionPanel />

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

      {/* Theme, zoom and locale moved to the title bar's Views menu (and stay in
          the native View menu / ⌘±). Three permanent slots for preferences a
          user sets once and then leaves alone was the clearest case of the
          bottom bar charging rent for configuration rather than status. */}

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

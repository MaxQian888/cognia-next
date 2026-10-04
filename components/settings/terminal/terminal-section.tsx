"use client"

/**
 * Settings → Terminal.
 *
 * Loaded lazily by `settings-shell.tsx` via the existing `dynamic(...
 * ssr:false)` pattern, so the heavy xterm modules never block the initial
 * bundle.
 *
 * Same shell as Connectivity, Logs and Gateway: a grouped rail, one panel, the
 * panel id in the URL (`?terminalPanel=`). That last part is the point. The
 * section used to be a single card, and every place that sent a user here to
 * fix an SSH host (the dock, the device console, the port-forward panel) could
 * only open it at the top. `lib/terminal/terminal-settings-link.ts` builds the
 * links, and the SSH panel also opens the host a link names (`?sshHost=`).
 */

import { useCallback, useMemo } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { TerminalSquareIcon } from "lucide-react"

import { PanelTransition } from "@/components/settings/common/panel-transition"
import {
  SETTINGS_DETAIL_PANE_CLASS,
  SettingsMasterDetail,
} from "@/components/settings/common/settings-master-detail"
import type { SettingsNavBadge } from "@/components/settings/common/settings-panel-nav"
import { selectSavedSshHosts } from "@/lib/terminal/saved-ssh-hosts"
import { SSH_HOST_PARAM } from "@/lib/terminal/terminal-settings-link"
import { useSettingsStore } from "@/stores/settings"

import { TerminalNav } from "./components/terminal-nav"
import {
  resolveTerminalPanel,
  TERMINAL_NAV_GROUPS,
  TERMINAL_PANEL_PARAM,
  type TerminalPanelId,
} from "./nav-config"
import { SshHosts } from "./ssh-hosts"
import { TerminalCard } from "./terminal-card"
import { TerminalProfiles } from "./terminal-profiles"
import { TerminalProjectOverride } from "./terminal-project-override"

export function TerminalSection() {
  const t = useTranslations("settings.terminal")
  const router = useRouter()
  const searchParams = useSearchParams()
  const activePanel = resolveTerminalPanel(searchParams.get(TERMINAL_PANEL_PARAM))
  const sshHosts = useSettingsStore(selectSavedSshHosts)
  const sshCount = sshHosts?.length ?? 0

  const onSelect = useCallback(
    (id: TerminalPanelId) => {
      const next = new URLSearchParams(searchParams.toString())
      next.set(TERMINAL_PANEL_PARAM, id)
      // A host named by a link belongs to the SSH panel; carrying it to another
      // panel would re-open that host the next time SSH is picked.
      if (id !== "ssh") next.delete(SSH_HOST_PARAM)
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  const badges = useMemo<Partial<Record<TerminalPanelId, SettingsNavBadge>>>(
    () =>
      sshCount > 0
        ? {
            ssh: {
              text: String(sshCount),
              variant: "secondary",
              ariaLabel: t("nav.sshCountAria", { count: sshCount }),
            },
          }
        : {},
    [sshCount, t]
  )

  const renderNav = (idPrefix: string) => (
    <TerminalNav
      groups={TERMINAL_NAV_GROUPS}
      activeId={activePanel}
      onSelect={onSelect}
      badges={badges}
      idPrefix={idPrefix}
    />
  )

  const panel = (() => {
    switch (activePanel) {
      case "appearance":
      case "shell":
      case "behavior":
      case "productivity":
      case "ai":
      case "host":
      case "agents":
        return <TerminalCard panel={activePanel} />
      case "profiles":
        return <TerminalProfiles />
      case "ssh":
        return <SshHosts />
      case "project":
        return <TerminalProjectOverride />
    }
  })()

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="terminal-section">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border/60 pb-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <TerminalSquareIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-base font-semibold tracking-tight">{t("heading")}</h2>
            <p className="text-xs text-pretty text-muted-foreground">{t("subheading")}</p>
          </div>
        </div>
      </div>

      <SettingsMasterDetail
        nav={(slot) => (slot === "rail" ? renderNav("terminal") : renderNav("terminal-sheet"))}
        navTitle={t("nav.title")}
        mobileTriggerLabel={t("nav.mobileTrigger")}
        activeKey={activePanel}
        activeLabel={t(`nav.items.${activePanel}.label`)}
        navWidth={240}
        triggerTestId="terminal-mobile-nav-trigger"
      >
        <div className={SETTINGS_DETAIL_PANE_CLASS}>
          <section
            aria-labelledby={`terminal-panel-${activePanel}`}
            className="min-h-0 flex-1 overflow-y-auto p-4"
            data-testid="terminal-panel-body"
            data-panel={activePanel}
          >
            <div className="mb-3 space-y-0.5">
              <h3 id={`terminal-panel-${activePanel}`} className="text-sm font-semibold">
                {t(`nav.items.${activePanel}.label`)}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t(`nav.items.${activePanel}.description`)}
              </p>
            </div>
            <PanelTransition activeKey={activePanel}>{panel}</PanelTransition>
          </section>
        </div>
      </SettingsMasterDetail>
    </div>
  )
}

export default TerminalSection

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"

import { CrashLogSettings } from "@/components/settings/system/crash-log-settings"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

import { SandboxAuditCard } from "./sandbox-audit-card"
import { SidecarRestartCard } from "./sidecar-restart-card"
import { InboxTelemetryCard } from "./inbox-telemetry-card"
import { NativeCrashReportsCard } from "./native-crash-reports-card"
import { DeveloperFlagsCard } from "./developer-flags-card"
import { PluginMessagingCard } from "./plugin-messaging-card"

type DiagnosticsTab = "crash-logs" | "native-reports" | "system"

const TAB_ORDER: DiagnosticsTab[] = ["crash-logs", "native-reports", "system"]

const TAB_LABEL_KEY: Record<DiagnosticsTab, string> = {
  "crash-logs": "crashLogs",
  "native-reports": "nativeReports",
  system: "system",
}

/**
 * Settings → Observability → Diagnostics.
 *
 * Fill-height tabbed surface (registered in `FILL_HEIGHT_SECTIONS`):
 * - Crash logs — incident list + detail two-pane filling the viewport
 * - Native reports — the Rust crash subsystem's saved reports
 * - System — ADR-0028 Phase 14 cards (sandbox audit, sidecar restarts)
 *   and the v49 inbox telemetry exporter
 */
export function DiagnosticsSection() {
  const t = useTranslations("settings.diagnostics.tabs")
  const [activeTab, setActiveTab] = useState<DiagnosticsTab>("crash-logs")

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="diagnostics-section">
      <div
        role="tablist"
        aria-label={t("label")}
        className="inline-flex w-fit shrink-0 items-center gap-0.5 rounded-lg bg-muted p-[3px]"
      >
        {TAB_ORDER.map((tab) => {
          const active = activeTab === tab
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(TAB_LABEL_KEY[tab])}
            </button>
          )
        })}
      </div>

      {activeTab === "crash-logs" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <CrashLogSettings />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-5xl space-y-4">
            {activeTab === "native-reports" ? (
              <NativeCrashReportsCard />
            ) : (
              <>
                <DeveloperFlagsCard />
                <SandboxAuditCard />
                <PluginMessagingCard />
                <SidecarRestartCard />
                <InboxTelemetryCard />
              </>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

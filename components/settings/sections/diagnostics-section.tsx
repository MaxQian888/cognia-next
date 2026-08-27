"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

import { SandboxAuditCard } from "./sandbox-audit-card"
import { SidecarRestartCard } from "./sidecar-restart-card"
import { InboxTelemetryCard } from "./inbox-telemetry-card"
import { NativeCrashReportsCard } from "./native-crash-reports-card"
import { DiagnosticServiceCard } from "./diagnostic-service-card"
import { DeveloperFlagsCard } from "./developer-flags-card"
import { PluginMessagingCard } from "./plugin-messaging-card"

type DiagnosticsTab = "native-reports" | "system"

const TAB_ORDER: DiagnosticsTab[] = ["native-reports", "system"]

const TAB_LABEL_KEY: Record<DiagnosticsTab, string> = {
  "native-reports": "nativeReports",
  system: "system",
}

/**
 * Settings → Observability → Diagnostics.
 *
 * Two tabs, both settings:
 * - Native reports — where reports go, and the Rust crash subsystem's saved ones
 * - System — ADR-0028 Phase 14 cards (sandbox audit, sidecar restarts) and the
 *   v49 inbox telemetry exporter
 *
 * The third tab was "Crash logs": a fill-height two-pane crash inspector,
 * hosted in a settings pane, for logs the route named `/logs` already exists to
 * show. It is the Diagnostics channel of that workspace now
 * (`CrashDiagnosticsWorkspace`), so reading a crash no longer means leaving the
 * logs page for Settings and back.
 */
export function DiagnosticsSection() {
  const t = useTranslations("settings.diagnostics.tabs")
  const [activeTab, setActiveTab] = useState<DiagnosticsTab>("native-reports")

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
            <Button
              key={tab}
              type="button"
              role="tab"
              variant="ghost"
              size="sm"
              aria-selected={active}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "h-auto rounded-md px-2.5 py-1 text-xs",
                active
                  ? "bg-background text-foreground shadow-sm hover:bg-background"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(TAB_LABEL_KEY[tab])}
            </Button>
          )
        })}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          {activeTab === "native-reports" ? (
            <>
              {/* Where these reports go, above the list of what is here. */}
              <DiagnosticServiceCard />
              <NativeCrashReportsCard />
            </>
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
    </div>
  )
}

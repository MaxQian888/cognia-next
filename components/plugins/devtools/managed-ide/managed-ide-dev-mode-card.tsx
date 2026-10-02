"use client"

/**
 * Plugin DevTools → Managed IDE Dev Mode (managed IDE operations, "Dev Mode").
 *
 * The switch is the host's (`plugin_managed_ide_dev_mode_set`). On, the host
 * records the broker trace, honours `local-dev` receipts for registered
 * folders, and accepts temporary proxies; this card shows the trace, edits
 * the session's permission simulations, and manages the folders. Off, all of
 * that stops, committed proxies come back, and plugins trusted only for the
 * session are disabled (reported here).
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BugIcon } from "lucide-react"
import { toast } from "sonner"

import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Surface } from "@/components/surface/surface"
import { useBrokerTrace } from "@/hooks/plugins/use-broker-trace"
import { useManagedIdeDevMode } from "@/hooks/plugins/use-managed-ide-dev-mode"
import { codeServerClient } from "@/lib/codeserver/client"
import { enterManagedIdeDevMode, leaveManagedIdeDevMode } from "@/lib/plugin/ide/dev-mode-session"
import { isTauri } from "@/lib/tauri"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { cn } from "@/lib/utils"

import { BrokerTraceTable } from "./broker-trace-table"
import { DevFoldersSection } from "./dev-folders-section"
import { PermissionSimulationSection } from "./permission-simulation-section"

export function ManagedIdeDevModeCard({ className }: { className?: string }) {
  const t = useTranslations("plugins.devtools.managedIde")
  const desktop = isTauri()
  const { status, simulations, folders } = useManagedIdeDevMode()
  const pluginMap = usePluginStore((state) => state.plugins)
  const plugins = useMemo(() => Object.values(pluginMap), [pluginMap])
  const [busy, setBusy] = useState(false)
  // The host resets payload recording on every switch, so this is per session.
  const [payloads, setPayloads] = useState({ session: 0, include: false })
  const [session, setSession] = useState(0)
  const includePayloads = payloads.session === session && payloads.include
  const trace = useBrokerTrace(status.enabled)

  const toggle = useCallback(
    async (next: boolean) => {
      setBusy(true)
      try {
        if (next) {
          await enterManagedIdeDevMode()
        } else {
          const left = await leaveManagedIdeDevMode()
          if (left.disabled.length > 0) {
            toast.info(t("leftDisabled", { count: left.disabled.length }))
          }
          for (const failure of left.failed) {
            toast.error(t("leftFailed", { pluginId: failure.pluginId, error: failure.error }))
          }
        }
        setSession((current) => current + 1)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toast.error(next ? t("enterFailed", { message }) : t("leaveFailed", { message }))
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  const configurePayloads = useCallback(
    async (next: boolean) => {
      try {
        const mode = await codeServerClient.configureBrokerTrace(next)
        setPayloads({ session, include: mode.includePayloads })
      } catch (error) {
        toast.error(
          t("trace.configureFailed", {
            message: error instanceof Error ? error.message : String(error),
          })
        )
      }
    },
    [session, t]
  )

  return (
    <Card
      className={cn("gap-0 overflow-hidden border-border/70 py-0", className)}
      data-testid="managed-ide-dev-mode-card"
    >
      <div className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Surface
              layer="raised"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg border"
            >
              <BugIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            </Surface>
            <div className="min-w-0 space-y-1">
              <h3 className="truncate text-sm font-semibold tracking-tight">{t("title")}</h3>
              <p className="text-xs text-muted-foreground">{t("description")}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Label htmlFor="managed-ide-dev-mode-toggle" className="sr-only">
              {t("toggleLabel")}
            </Label>
            <Switch
              id="managed-ide-dev-mode-toggle"
              checked={status.enabled}
              onCheckedChange={(next) => void toggle(next)}
              disabled={!desktop || busy}
              aria-label={t("toggleLabel")}
            />
          </div>
        </div>

        {!desktop ? (
          <p className="text-xs text-muted-foreground" data-testid="managed-ide-desktop-only">
            {t("desktopOnly")}
          </p>
        ) : !status.enabled ? (
          <p className="text-xs text-muted-foreground" data-testid="managed-ide-off">
            {t("off")}
          </p>
        ) : (
          <Tabs defaultValue="trace" className="gap-3">
            <TabsList>
              <TabsTrigger value="trace">{t("tabs.trace")}</TabsTrigger>
              <TabsTrigger value="simulation">{t("tabs.simulation")}</TabsTrigger>
              <TabsTrigger value="folders">{t("tabs.folders")}</TabsTrigger>
            </TabsList>
            <TabsContent value="trace" className="space-y-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="managed-ide-trace-payloads"
                  checked={includePayloads}
                  onCheckedChange={(next) => void configurePayloads(next)}
                  aria-label={t("trace.payloadsLabel")}
                />
                <Label htmlFor="managed-ide-trace-payloads" className="text-xs">
                  {t("trace.payloadsLabel")}
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">{t("trace.payloadsHint")}</p>
              <BrokerTraceTable
                rows={trace.rows}
                includePayloads={includePayloads}
                error={trace.error}
              />
            </TabsContent>
            <TabsContent value="simulation">
              <PermissionSimulationSection plugins={plugins} simulations={simulations} />
            </TabsContent>
            <TabsContent value="folders">
              <DevFoldersSection folders={folders} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </Card>
  )
}

"use client"

/**
 * FleetMonitorCard — controls for monitoring externally-launched coding
 * agents (Claude Code first; Codex/OpenCode follow the same card).
 *
 * Lives in the hooks settings tab because the Claude integration IS a set of
 * settings.json hooks: installing them goes through the shared catalog
 * (`lib/claude/hooks/fleet-hooks.ts`) and the single settings writer, exactly
 * like the built-in hooks card above it. Three switches:
 *
 * 1. Monitor — starts/stops the local ingress (companion API + token file).
 * 2. Claude Code hooks — install/uninstall the forwarder entries in
 *    `~/.claude/settings.json` (+ the generated `claude-hook.sh`).
 * 3. Codex notify — point `~/.codex/config.toml`'s `notify` at a forwarder
 *    (observe-only: one turn-complete event per turn, no trust step).
 * 4. Island overlay — the Dynamic-Island-style status window.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import {
  installFleetHooks,
  readFleetHooksStatus,
  uninstallFleetHooks,
  type FleetHooksInstallState,
} from "@/lib/claude/hooks/fleet-hooks"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  closeIslandWindow,
  fleetCodexInstall,
  fleetCodexStatus,
  fleetCodexUninstall,
  fleetMonitorStart,
  fleetMonitorStatus,
  fleetMonitorStop,
  fleetOpencodeInstall,
  fleetOpencodeStatus,
  fleetOpencodeUninstall,
  isIslandWindowOpen,
  islandListMonitors,
  islandSetMonitor,
  openIslandWindow,
  type CodexStatus,
  type IslandMonitorInfo,
  type OpencodeStatus,
} from "@/lib/tauri/fleet"
import { subscribeClaudeSettings } from "@/lib/claude/settings"
import { FleetHistoryPanel } from "./fleet-history-panel"
import { createLogger } from "@/lib/logging"

const log = createLogger("settings.hooks.fleet")

export function FleetMonitorCard() {
  const t = useTranslations("settings.hooks.fleet")
  const [loaded, setLoaded] = useState(false)
  const [monitorEnabled, setMonitorEnabled] = useState(false)
  const [monitorPort, setMonitorPort] = useState<number | null>(null)
  const [installState, setInstallState] = useState<FleetHooksInstallState>("not-installed")
  const [scriptStale, setScriptStale] = useState(false)
  const [codexStatus, setCodexStatus] = useState<CodexStatus>("not-installed")
  const [opencodeStatus, setOpencodeStatus] = useState<OpencodeStatus>("not-installed")
  const [islandOpen, setIslandOpen] = useState(false)
  const [islandMonitors, setIslandMonitors] = useState<IslandMonitorInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  // Read the three status sources without touching React state — the caller
  // applies the result after its own alive-check, so the async read and the
  // state write stay on the right side of the effect's await boundary.
  const fetchStatus = useCallback(async () => {
    try {
      const [monitor, hooks, codex, opencode, island, monitors] = await Promise.all([
        fleetMonitorStatus(),
        readFleetHooksStatus(),
        fleetCodexStatus(),
        fleetOpencodeStatus(),
        isIslandWindowOpen(),
        islandListMonitors(),
      ])
      return {
        monitorEnabled: monitor.enabled,
        monitorPort: monitor.port,
        installState: hooks.install,
        scriptStale: hooks.scripts.claudeScript === "stale",
        codexStatus: codex.status,
        opencodeStatus: opencode.status,
        islandOpen: island,
        islandMonitors: monitors,
      }
    } catch (e) {
      log.error("refresh_failed", { error: String(e) })
      return null
    }
  }, [])

  const applyStatus = useCallback((s: Awaited<ReturnType<typeof fetchStatus>>) => {
    if (s) {
      setMonitorEnabled(s.monitorEnabled)
      setMonitorPort(s.monitorPort)
      setInstallState(s.installState)
      setScriptStale(s.scriptStale)
      setCodexStatus(s.codexStatus)
      setOpencodeStatus(s.opencodeStatus)
      setIslandOpen(s.islandOpen)
      setIslandMonitors(s.islandMonitors)
    }
    setLoaded(true)
  }, [])

  const refresh = useCallback(async () => {
    applyStatus(await fetchStatus())
  }, [fetchStatus, applyStatus])

  useEffect(() => {
    let alive = true
    // Fetch first, then apply — the state write follows the await, so it runs
    // in a microtask (no synchronous render cascade).
    void (async () => {
      const status = await fetchStatus()
      if (alive) applyStatus(status)
    })()
    // Another writer (hooks editor, external tool) touched settings.json —
    // re-derive the install state instead of trusting our last write.
    let unlisten: (() => void) | undefined
    void subscribeClaudeSettings(() => void refresh()).then((fn) => {
      unlisten = fn
    })
    return () => {
      alive = false
      unlisten?.()
    }
  }, [fetchStatus, applyStatus, refresh])

  const toggleMonitor = useCallback(
    async (next: boolean) => {
      if (busy) return
      setBusy(true)
      try {
        if (next) {
          const status = await fleetMonitorStart()
          if (!status) throw new Error("monitor start failed")
          setMonitorEnabled(status.enabled)
          setMonitorPort(status.port)
        } else {
          const status = await fleetMonitorStop()
          setMonitorEnabled(status.enabled)
          setMonitorPort(status.port)
        }
        toast.success(t("saved"))
      } catch (e) {
        log.error("monitor_toggle_failed", { next, error: String(e) })
        toast.error(t("error", { detail: String(e) }))
      } finally {
        setBusy(false)
      }
    },
    [busy, t]
  )

  const toggleClaudeHooks = useCallback(
    async (next: boolean) => {
      if (busy) return
      setBusy(true)
      try {
        if (next) {
          await installFleetHooks()
        } else {
          await uninstallFleetHooks()
        }
        await refresh()
        toast.success(t("saved"))
      } catch (e) {
        log.error("claude_hooks_toggle_failed", { next, error: String(e) })
        toast.error(t("error", { detail: String(e) }))
      } finally {
        setBusy(false)
      }
    },
    [busy, refresh, t]
  )

  const toggleCodex = useCallback(
    async (next: boolean) => {
      if (busy) return
      setBusy(true)
      try {
        // Install/uninstall throw on conflict (foreign `notify`) — surface it.
        if (next) {
          await fleetCodexInstall()
        } else {
          await fleetCodexUninstall()
        }
        await refresh()
        toast.success(t("saved"))
      } catch (e) {
        log.error("codex_toggle_failed", { next, error: String(e) })
        toast.error(t("error", { detail: String(e) }))
      } finally {
        setBusy(false)
      }
    },
    [busy, refresh, t]
  )

  const toggleOpencode = useCallback(
    async (next: boolean) => {
      if (busy) return
      setBusy(true)
      try {
        if (next) {
          await fleetOpencodeInstall()
        } else {
          await fleetOpencodeUninstall()
        }
        await refresh()
        toast.success(t("saved"))
      } catch (e) {
        log.error("opencode_toggle_failed", { next, error: String(e) })
        toast.error(t("error", { detail: String(e) }))
      } finally {
        setBusy(false)
      }
    },
    [busy, refresh, t]
  )

  const toggleIsland = useCallback(
    async (next: boolean) => {
      if (busy) return
      setBusy(true)
      try {
        const ok = next ? await openIslandWindow() : await closeIslandWindow()
        if (ok) setIslandOpen(next)
      } finally {
        setBusy(false)
      }
    },
    [busy]
  )

  // "primary" is the Select sentinel for "no persisted preference" — Radix
  // Select can't represent a null value, and Rust maps it back to `None`.
  const selectedIslandMonitor = islandMonitors.find((m) => m.selected)?.name ?? "primary"

  const changeIslandMonitor = useCallback(
    async (value: string) => {
      if (busy) return
      setBusy(true)
      try {
        const ok = await islandSetMonitor(value === "primary" ? null : value)
        if (ok) await refresh()
      } finally {
        setBusy(false)
      }
    },
    [busy, refresh]
  )

  const codexBadge = (() => {
    switch (codexStatus) {
      case "installed":
        return { key: "installed", variant: "default" as const }
      case "conflict":
        return { key: "codexConflict", variant: "destructive" as const }
      case "unavailable":
        return { key: "codexUnavailable", variant: "outline" as const }
      default:
        return null
    }
  })()

  const opencodeBadge = (() => {
    switch (opencodeStatus) {
      case "installed":
        return { key: "installed", variant: "default" as const }
      case "stale":
        return { key: "stale", variant: "destructive" as const }
      case "unavailable":
        return { key: "opencodeUnavailable", variant: "outline" as const }
      default:
        return null
    }
  })()

  const installBadge = (() => {
    if (scriptStale) return { key: "stale", variant: "destructive" as const }
    switch (installState) {
      case "installed":
        return { key: "installed", variant: "default" as const }
      case "partial":
        return { key: "partial", variant: "secondary" as const }
      case "unavailable":
        return { key: "unavailable", variant: "outline" as const }
      default:
        return null
    }
  })()

  const activeCount = [
    monitorEnabled,
    installState === "installed",
    codexStatus === "installed",
    opencodeStatus === "installed",
    islandOpen,
  ].filter(Boolean).length

  return (
    <Card className="p-3" data-testid="fleet-monitor-card" data-loaded={loaded ? "true" : "false"}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 text-left"
            data-testid="fleet-monitor-toggle"
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">{t("title")}</h3>
                <Badge
                  variant={activeCount > 0 ? "default" : "secondary"}
                  className="text-[10px]"
                  aria-label={t("summaryAria", { count: activeCount })}
                >
                  {activeCount}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{t("description")}</p>
            </div>
            <ChevronDownIcon
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                open && "rotate-180"
              )}
              aria-hidden
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 pt-3">
            <div className="flex items-start justify-between gap-3" data-testid="fleet-monitor-row">
              <div className="space-y-0.5">
                <Label htmlFor="fleet-monitor" className="text-xs font-medium">
                  {t("monitor.label")}
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  {monitorEnabled && monitorPort !== null
                    ? t("monitor.running", { port: monitorPort })
                    : t("monitor.desc")}
                </p>
              </div>
              <Switch
                id="fleet-monitor"
                checked={monitorEnabled}
                disabled={busy || !loaded}
                onCheckedChange={(v) => void toggleMonitor(v)}
                aria-label={t("monitor.label")}
                data-testid="fleet-monitor-switch"
              />
            </div>

            <div className="flex items-start justify-between gap-3" data-testid="fleet-claude-row">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Label htmlFor="fleet-claude-hooks" className="text-xs font-medium">
                    {t("claude.label")}
                  </Label>
                  {installBadge ? (
                    <Badge
                      variant={installBadge.variant}
                      className="h-4 px-1.5 text-[10px]"
                      data-testid={`fleet-claude-badge-${installBadge.key}`}
                    >
                      {t(`status.${installBadge.key}`)}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] text-muted-foreground">{t("claude.desc")}</p>
              </div>
              <Switch
                id="fleet-claude-hooks"
                checked={installState === "installed"}
                disabled={busy || !loaded || installState === "unavailable"}
                onCheckedChange={(v) => void toggleClaudeHooks(v)}
                aria-label={t("claude.label")}
                data-testid="fleet-claude-switch"
              />
            </div>

            <div className="flex items-start justify-between gap-3" data-testid="fleet-codex-row">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Label htmlFor="fleet-codex" className="text-xs font-medium">
                    {t("codex.label")}
                  </Label>
                  {codexBadge ? (
                    <Badge
                      variant={codexBadge.variant}
                      className="h-4 px-1.5 text-[10px]"
                      data-testid={`fleet-codex-badge-${codexBadge.key}`}
                    >
                      {t(`status.${codexBadge.key}`)}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] text-muted-foreground">{t("codex.desc")}</p>
              </div>
              <Switch
                id="fleet-codex"
                checked={codexStatus === "installed"}
                disabled={
                  busy || !loaded || codexStatus === "unavailable" || codexStatus === "conflict"
                }
                onCheckedChange={(v) => void toggleCodex(v)}
                aria-label={t("codex.label")}
                data-testid="fleet-codex-switch"
              />
            </div>

            <div
              className="flex items-start justify-between gap-3"
              data-testid="fleet-opencode-row"
            >
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Label htmlFor="fleet-opencode" className="text-xs font-medium">
                    {t("opencode.label")}
                  </Label>
                  {opencodeBadge ? (
                    <Badge
                      variant={opencodeBadge.variant}
                      className="h-4 px-1.5 text-[10px]"
                      data-testid={`fleet-opencode-badge-${opencodeBadge.key}`}
                    >
                      {t(`status.${opencodeBadge.key}`)}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[11px] text-muted-foreground">{t("opencode.desc")}</p>
              </div>
              <Switch
                id="fleet-opencode"
                checked={opencodeStatus === "installed"}
                disabled={busy || !loaded || opencodeStatus === "unavailable"}
                onCheckedChange={(v) => void toggleOpencode(v)}
                aria-label={t("opencode.label")}
                data-testid="fleet-opencode-switch"
              />
            </div>

            <div className="flex items-start justify-between gap-3" data-testid="fleet-island-row">
              <div className="space-y-0.5">
                <Label htmlFor="fleet-island" className="text-xs font-medium">
                  {t("island.label")}
                </Label>
                <p className="text-[11px] text-muted-foreground">{t("island.desc")}</p>
              </div>
              <Switch
                id="fleet-island"
                checked={islandOpen}
                disabled={busy || !loaded}
                onCheckedChange={(v) => void toggleIsland(v)}
                aria-label={t("island.label")}
                data-testid="fleet-island-switch"
              />
            </div>

            {islandMonitors.length > 1 ? (
              <div
                className="flex items-center justify-between gap-3"
                data-testid="fleet-island-monitor-row"
              >
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("island.monitor.label")}
                </Label>
                <Select
                  value={selectedIslandMonitor}
                  disabled={busy || !loaded}
                  onValueChange={(v) => void changeIslandMonitor(v)}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-56 text-xs"
                    aria-label={t("island.monitor.label")}
                    data-testid="fleet-island-monitor-trigger"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary">{t("island.monitor.primary")}</SelectItem>
                    {islandMonitors
                      .filter((m) => m.name !== null)
                      .map((m) => (
                        <SelectItem key={m.name} value={m.name as string}>
                          {t("island.monitor.option", {
                            name: m.name as string,
                            width: m.width,
                            height: m.height,
                          })}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <div className="mt-3 border-t pt-3">
            <FleetHistoryPanel />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

export default FleetMonitorCard

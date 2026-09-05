"use client"

/**
 * FleetSection — dedicated settings page for the Agent Fleet subsystem:
 * monitoring externally-launched coding agents (Claude Code / Codex / OpenCode)
 * and the Dynamic-Island-style status overlay.
 *
 * This used to live as a collapsible card inside the Hooks settings tab because
 * the Claude integration IS a set of settings.json hooks. It was split into its
 * own section (ADR: Fleet agent-monitor island) so Hooks stays purely about
 * authoring lifecycle hooks — Fleet is monitoring + a desktop overlay + session
 * history, a different mental model. The install toggles still write hook
 * entries via the shared catalog (`lib/claude/hooks/fleet-hooks.ts`) and config
 * files, so a change here is reflected back through `subscribeClaudeSettings`.
 *
 * Toggles:
 * 1. Monitor — starts/stops the local ingress (companion API + token file).
 * 2. Claude Code hooks — install/uninstall the forwarder entries in
 *    `~/.claude/settings.json` (+ the generated `claude-hook.sh`).
 * 3. Codex hooks — register the forwarder in `~/.codex/hooks.json` (merged, so
 *    a foreign tool's hooks survive). This replaced the `notify` integration,
 *    which never produced a single fleet row: Codex's notify payload names its
 *    session `thread-id`, not `session_id`, so every event was dropped at the
 *    door while this card kept reporting a healthy install. Toggling the row
 *    also clears any leftover `notify` entry, so the two can't double-report.
 * 4. OpenCode plugin — install the observe/approve plugin.
 * 5. Island overlay — the Dynamic-Island-style status window (+ display picker).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/sonner"
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
  fleetCodexHooksCapabilities,
  fleetCodexHooksInstall,
  fleetCodexHooksStatus,
  fleetCodexHooksUninstall,
  fleetCodexStatus,
  fleetCodexUninstall,
  fleetMonitorStart,
  fleetMonitorStatus,
  fleetMonitorStop,
  fleetOpencodeInstall,
  fleetOpencodeOutboxRepair,
  fleetOpencodeOutboxStatus,
  fleetOpencodeStatus,
  fleetOpencodeUninstall,
  islandDebugGeometry,
  isIslandWindowOpen,
  islandGetHideOnFullscreen,
  islandListMonitors,
  islandSetHideOnFullscreen,
  islandSetMonitor,
  openIslandWindow,
  type CodexHooksStatus,
  type CodexHookCapabilityReport,
  type IslandMonitorInfo,
  type OpencodeStatus,
  type OpencodeOutboxStatus,
} from "@/lib/tauri/fleet"
import { subscribeClaudeSettings } from "@/lib/claude/settings"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"
import { FleetHistoryPanel } from "./fleet-history-panel"
import { AgentLivenessChip } from "./agent-liveness-chip"
import { useFleetSnapshot } from "@/hooks/fleet/use-fleet-snapshot"
import { createLogger } from "@cognia/logging"
import { useIslandStore } from "@/lib/island/store"
import { ISLAND_DETAIL_VISIBILITIES, type IslandDetailVisibility } from "@/lib/island/types"
import { ExecutionWorkersCard } from "./execution-workers-card"

const log = createLogger("settings.fleet")

export function FleetSection() {
  const t = useTranslations("settings.fleet")
  // Liveness rides the same snapshot stream the island uses — no second poll.
  const { snapshot } = useFleetSnapshot()
  const livenessFor = (agent: string) => snapshot.liveness?.find((l) => l.agent === agent)
  const opencodeCapabilities = snapshot.runtimeCapabilities?.find(
    (capability) => capability.agent === "opencode"
  )
  const opencodeCapabilityState = !opencodeCapabilities
    ? "unproven"
    : opencodeCapabilities.sendMessage &&
        opencodeCapabilities.interrupt &&
        opencodeCapabilities.answersQuestions
      ? "proven"
      : "degraded"
  const [loaded, setLoaded] = useState(false)
  const [monitorEnabled, setMonitorEnabled] = useState(false)
  const [monitorPort, setMonitorPort] = useState<number | null>(null)
  const [installState, setInstallState] = useState<FleetHooksInstallState>("not-installed")
  const [scriptStale, setScriptStale] = useState(false)
  const [codexStatus, setCodexStatus] = useState<CodexHooksStatus>("not-installed")
  const [codexCapabilities, setCodexCapabilities] = useState<CodexHookCapabilityReport | null>(null)
  const [opencodeStatus, setOpencodeStatus] = useState<OpencodeStatus>("not-installed")
  const [opencodeOutbox, setOpencodeOutbox] = useState<OpencodeOutboxStatus | null>(null)
  const islandPreferences = useIslandStore((state) => state.preferences)
  const islandHydrated = useIslandStore((state) => state.hydrated)
  const hydrateIsland = useIslandStore((state) => state.hydrate)
  const setIslandPreferences = useIslandStore((state) => state.setPreferences)
  const [islandOpen, setIslandOpen] = useState(false)
  const [islandMonitors, setIslandMonitors] = useState<IslandMonitorInfo[]>([])
  const [islandHideOnFullscreen, setIslandHideOnFullscreen] = useState(false)
  const [busy, setBusy] = useState(false)

  // Read the status sources without touching React state — the caller applies
  // the result after its own alive-check, so the async read and the state write
  // stay on the right side of the effect's await boundary.
  const fetchStatus = useCallback(async () => {
    try {
      const [
        monitor,
        hooks,
        codex,
        codexProbe,
        opencode,
        outbox,
        island,
        monitors,
        hideOnFullscreen,
      ] = await Promise.all([
        fleetMonitorStatus(),
        readFleetHooksStatus(),
        fleetCodexHooksStatus(),
        fleetCodexHooksCapabilities(),
        fleetOpencodeStatus(),
        fleetOpencodeOutboxStatus(),
        isIslandWindowOpen(),
        islandListMonitors(),
        islandGetHideOnFullscreen(),
      ])
      return {
        monitorEnabled: monitor.enabled,
        monitorPort: monitor.port,
        installState: hooks.install,
        scriptStale: hooks.scripts.claudeScript === "stale",
        codexStatus: codex,
        codexCapabilities: codexProbe,
        opencodeStatus: opencode.status,
        opencodeOutbox: outbox,
        islandOpen: island,
        islandMonitors: monitors,
        islandHideOnFullscreen: hideOnFullscreen,
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
      setCodexCapabilities(s.codexCapabilities)
      setOpencodeStatus(s.opencodeStatus)
      setOpencodeOutbox(s.opencodeOutbox)
      setIslandOpen(s.islandOpen)
      setIslandMonitors(s.islandMonitors)
      setIslandHideOnFullscreen(s.islandHideOnFullscreen)
    }
    setLoaded(true)
  }, [])

  const refresh = useCallback(async () => {
    applyStatus(await fetchStatus())
  }, [fetchStatus, applyStatus])

  // Island preferences live in their own persisted store rather than in
  // `AppSettings`, because the main window has to know the detail policy before
  // it builds the very first projection. Hydrating is idempotent.
  useEffect(() => {
    void hydrateIsland()
  }, [hydrateIsland])

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
        if (next) {
          await fleetCodexHooksInstall()
        } else {
          await fleetCodexHooksUninstall()
        }
        // Either way, drop any leftover `notify` entry from the retired
        // integration. Left in place it would keep firing `agent-turn-complete`
        // alongside the hooks, double-counting every turn — and turning this
        // row off has to actually disconnect Codex, not half of it. Gated on
        // the status read so we never rewrite config.toml on the overwhelming
        // majority of machines that have nothing of ours in it.
        if ((await fleetCodexStatus()).status === "installed") {
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

  const repairOpencodeOutbox = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const status = await fleetOpencodeOutboxRepair()
      setOpencodeOutbox(status)
      toast.success(t("opencode.outbox.repaired"))
    } catch (error) {
      log.error("opencode_outbox_repair_failed", { error: String(error) })
      toast.error(t("error", { detail: String(error) }))
    } finally {
      setBusy(false)
    }
  }, [busy, t])

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

  /**
   * Opt into the island yielding the top strip to full-screen apps.
   *
   * Optimistic: the switch reflects the new value before the round-trip so the
   * toggle doesn't lag, and reverts if Rust refused. Unlike the monitor picker
   * this does NOT `refresh()` — the whole status fan-out for one boolean the
   * caller already knows.
   */
  const toggleIslandHideOnFullscreen = useCallback(
    async (next: boolean) => {
      if (busy) return
      setBusy(true)
      setIslandHideOnFullscreen(next)
      try {
        const ok = await islandSetHideOnFullscreen(next)
        if (!ok) setIslandHideOnFullscreen(!next)
        else toast.success(t("saved"))
      } finally {
        setBusy(false)
      }
    },
    [busy, t]
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

  /**
   * Copy every input the island's placement math reads to the clipboard.
   *
   * Island placement bugs are the one class this codebase cannot chase with a
   * test: `island_window.rs`'s live window ops don't run under
   * `tauri::test::mock_app()`, and the quantities that go wrong
   * (`NSScreen.safeAreaInsets` under a hidden menu bar, the Space-dependent
   * work area) only exist on a real desktop in a real Space. Sampling this on a
   * normal Space, on a full-screen Space, and on an external display turns
   * "the island looks wrong" into numbers.
   */
  const copyDiagnostics = useCallback(async () => {
    const dump = await islandDebugGeometry()
    if (!dump) {
      toast.error(t("island.diagnostics.unavailable"))
      return
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(dump, null, 2))
      toast.success(t("island.diagnostics.copied"))
    } catch (err) {
      log.warn("copying island diagnostics failed", { err })
      toast.error(t("island.diagnostics.copyFailed"))
    }
  }, [t])

  const codexBadge = (() => {
    switch (codexStatus) {
      case "installed":
        return { key: "installed", variant: "default" as const }
      // Our handler is registered but under a different command. Codex keys
      // hook trust to the command text, so a drifted entry is an untrusted one
      // — it will not fire until reinstalled and re-approved.
      case "stale":
        return { key: "codexStale", variant: "destructive" as const }
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
    <div className="space-y-4" data-testid="fleet-section" data-loaded={loaded ? "true" : "false"}>
      <RelatedSectionsStrip current="fleet" targets={CLAUDE_CODE_RELATED} />

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{t("title")}</h2>
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

      <Card className="space-y-2 p-3">
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
              <AgentLivenessChip
                agent="claude-code"
                liveness={livenessFor("claude-code")}
                installed={installState === "installed"}
              />
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
              <AgentLivenessChip
                agent="codex"
                liveness={livenessFor("codex")}
                installed={codexStatus === "installed" || codexStatus === "stale"}
              />
              {codexStatus === "installed" ? (
                <Badge
                  variant={codexCapabilities?.state === "probed" ? "default" : "outline"}
                  className="h-4 px-1.5 text-[10px]"
                  data-testid={`fleet-codex-capabilities-${codexCapabilities?.state ?? "degraded"}`}
                >
                  {t(
                    codexCapabilities?.state === "probed"
                      ? "capabilities.proven"
                      : "capabilities.degraded"
                  )}
                </Badge>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">{t("codex.desc")}</p>
            {codexStatus === "installed" || codexStatus === "stale" ? (
              <p className="text-[11px] text-amber-600 dark:text-amber-500" role="note">
                {t("codex.trustHint")}
              </p>
            ) : null}
          </div>
          <Switch
            id="fleet-codex"
            // `stale` reads as off so the switch stays actionable: flipping it
            // on rewrites the entry, which is what re-earns Codex's trust.
            checked={codexStatus === "installed"}
            disabled={busy || !loaded || codexStatus === "unavailable"}
            onCheckedChange={(v) => void toggleCodex(v)}
            aria-label={t("codex.label")}
            data-testid="fleet-codex-switch"
          />
        </div>

        <div className="flex items-start justify-between gap-3" data-testid="fleet-opencode-row">
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
              <AgentLivenessChip
                agent="opencode"
                liveness={livenessFor("opencode")}
                installed={opencodeStatus === "installed" || opencodeStatus === "stale"}
              />
              {opencodeStatus === "installed" ? (
                <Badge
                  variant={opencodeCapabilityState === "proven" ? "default" : "outline"}
                  className="h-4 px-1.5 text-[10px]"
                  data-testid={`fleet-opencode-capabilities-${opencodeCapabilityState}`}
                >
                  {t(`capabilities.${opencodeCapabilityState}`)}
                </Badge>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">{t("opencode.desc")}</p>
            {opencodeOutbox && opencodeOutbox.health !== "healthy" ? (
              <div className="flex items-center gap-2" data-testid="fleet-opencode-outbox-warning">
                <p className="text-[11px] text-destructive">
                  {t(`opencode.outbox.${opencodeOutbox.health}`)}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || opencodeOutbox.path === null}
                  onClick={() => void repairOpencodeOutbox()}
                  data-testid="fleet-opencode-outbox-repair"
                >
                  {t("opencode.outbox.repair")}
                </Button>
              </div>
            ) : null}
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

        {/*
         * Opt-in, not the default: the island's NSPanel already floats over
         * every Space, and withdrawing there unconditionally made it look
         * broken outside Cognia's own desktop. The copy names macOS because
         * only macOS has the full-screen Space model this reads — elsewhere
         * `display_is_fullscreen` is a constant `false` and the switch is inert.
         */}
        <div
          className="flex items-start justify-between gap-3"
          data-testid="fleet-island-fullscreen-row"
        >
          <div className="space-y-0.5">
            <Label htmlFor="fleet-island-fullscreen" className="text-xs font-medium">
              {t("island.hideOnFullscreen.label")}
            </Label>
            <p className="text-[11px] text-muted-foreground">{t("island.hideOnFullscreen.desc")}</p>
          </div>
          <Switch
            id="fleet-island-fullscreen"
            checked={islandHideOnFullscreen}
            disabled={busy || !loaded}
            onCheckedChange={(v) => void toggleIslandHideOnFullscreen(v)}
            aria-label={t("island.hideOnFullscreen.label")}
            data-testid="fleet-island-fullscreen-switch"
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

        {/*
         * Privacy, not cosmetics. The island runs in a window that anyone
         * walking past a desk can read, so this decides how much of a task
         * crosses into it at all. `click-to-reveal` is the default and the
         * main window refuses a detail request outright under `summary-only`,
         * rather than sending it and trusting the overlay to hide it.
         */}
        <div
          className="flex items-center justify-between gap-3"
          data-testid="fleet-island-detail-row"
        >
          <div className="space-y-0.5">
            <Label className="text-xs font-medium text-muted-foreground">
              {t("island.detailVisibility.label")}
            </Label>
            <p className="text-[11px] text-muted-foreground">{t("island.detailVisibility.desc")}</p>
          </div>
          <Select
            value={islandPreferences.detailVisibility}
            disabled={!islandHydrated}
            onValueChange={(value) =>
              setIslandPreferences({ detailVisibility: value as IslandDetailVisibility })
            }
          >
            <SelectTrigger
              size="sm"
              className="w-44 shrink-0 text-xs"
              aria-label={t("island.detailVisibility.label")}
              data-testid="fleet-island-detail-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ISLAND_DETAIL_VISIBILITIES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`island.detailVisibility.options.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div
          className="flex items-center justify-between gap-3"
          data-testid="fleet-island-diagnostics-row"
        >
          <div className="space-y-0.5">
            <Label className="text-xs font-medium text-muted-foreground">
              {t("island.diagnostics.label")}
            </Label>
            <p className="text-[11px] text-muted-foreground">{t("island.diagnostics.desc")}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 text-xs"
            onClick={() => void copyDiagnostics()}
            data-testid="fleet-island-diagnostics-copy"
          >
            {t("island.diagnostics.copy")}
          </Button>
        </div>
      </Card>

      <ExecutionWorkersCard hosts={snapshot.hosts ?? []} />

      <Card className="p-3">
        <FleetHistoryPanel />
      </Card>
    </div>
  )
}

export default FleetSection

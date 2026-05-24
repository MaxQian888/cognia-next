"use client"

/**
 * Settings → Automation. Five-tab shell (`?autoTab=`) — Overview, Permissions,
 * Whitelist, Audit, Inspector.
 *
 * The data plane:
 *   - Capabilities + settings load from the Rust state on mount.
 *   - The kill switch goes through `desktop.killSwitch()` which engages the
 *     Rust-side gate in <1s.
 *   - Audit rows live in Dexie (table `automationAuditLog`); the in-memory
 *     Rust ring is a debug-only fallback.
 *   - ADR-0020 W1 — Overview now also surfaces `automation:backend-init-failed`
 *     (drained + live-listened on mount) plus three audit-derived counter
 *     cards (24h totals, top failing commands, last screenshot).
 */

import { useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  AlertOctagonIcon,
  CameraIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"

import { transport, isTauri } from "@/lib/tauri"
import {
  desktop,
  defaultAutomationSettings,
  type AutomationSettings,
  type Surface,
  type Tier,
} from "@/lib/automation/client"
import type { Capabilities } from "@/lib/automation/types"
import { listAuditRows } from "@/lib/automation/audit"

import { AutomationAuditTable } from "./automation-audit-table"
import { WhitelistTab } from "./whitelist-tab"
import { InspectorTab } from "./inspector-tab"
import { ScreenOffCard } from "./screen-off-card"

interface BackendInitFailure {
  platform: string
  error: string
}

interface OverviewMetrics {
  total: number
  allow: number
  deny: number
  consent: number
  topFailing: Array<{ command: string; count: number }>
  lastScreenshotTs: number | null
  // Wall-clock timestamp at the moment this snapshot was computed. Captured
  // here (not at render) so the "last screenshot" label can stay a pure
  // derivation — `Date.now()` during render trips React Compiler's purity rule.
  loadedAt: number
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
const METRICS_REFRESH_MS = 60_000

type TabId = "overview" | "permissions" | "whitelist" | "audit" | "inspector"

const TAB_IDS: TabId[] = ["overview", "permissions", "whitelist", "audit", "inspector"]

function isTabId(v: string | null): v is TabId {
  return v !== null && (TAB_IDS as readonly string[]).includes(v)
}

export function AutomationSection() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get("autoTab")
  const activeTab: TabId = isTabId(requested) ? requested : "overview"
  const tHeader = useTranslations("automation.header")
  const tTabs = useTranslations("automation.tabs")

  const setTab = (tab: TabId) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set("autoTab", tab)
    router.replace(`/settings?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold">{tHeader("title")}</h2>
        <p className="text-sm text-muted-foreground">{tHeader("description")}</p>
      </header>

      <Tabs value={activeTab} onValueChange={(t) => setTab(t as TabId)}>
        <TabsList>
          <TabsTrigger value="overview">{tTabs("overview")}</TabsTrigger>
          <TabsTrigger value="permissions">{tTabs("permissions")}</TabsTrigger>
          <TabsTrigger value="whitelist">{tTabs("whitelist")}</TabsTrigger>
          <TabsTrigger value="audit">{tTabs("audit")}</TabsTrigger>
          <TabsTrigger value="inspector">{tTabs("inspector")}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="permissions" className="pt-4">
          <PermissionsTab />
        </TabsContent>
        <TabsContent value="whitelist" className="pt-4">
          <WhitelistTab />
        </TabsContent>
        <TabsContent value="audit" className="pt-4">
          <AutomationAuditTable />
        </TabsContent>
        <TabsContent value="inspector" className="pt-4">
          <InspectorTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function OverviewTab() {
  const t = useTranslations("automation.overview")
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [settings, setSettings] = useState<AutomationSettings | null>(() =>
    isTauri() ? null : defaultAutomationSettings()
  )
  const [loading, setLoading] = useState(() => isTauri())
  const [savingEnabled, setSavingEnabled] = useState(false)
  const [initFailure, setInitFailure] = useState<BackendInitFailure | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    Promise.all([desktop.capabilities(), desktop.settingsGet()])
      .then(([c, s]) => {
        setCaps(c)
        setSettings(s)
      })
      .catch((err) => {
        toast.error("Failed to read automation state", {
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setLoading(false))
  }, [])

  // ADR-0020 W1 — surface backend init failures the operator might
  // otherwise miss. Two paths converge here:
  //   1. `automation_drain_init_failure` pulls a pending failure that
  //      was stashed before the renderer attached an event listener
  //      (the common case for failures during app boot).
  //   2. `automation:backend-init-failed` listener catches any new
  //      failure (e.g. after a worker-restart that tried to reinit).
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    transport
      .call<BackendInitFailure | null>("automation_drain_init_failure", {})
      .then((failure) => {
        if (!cancelled && failure) setInitFailure(failure)
      })
      .catch(() => {})
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<BackendInitFailure>("automation:backend-init-failed", (event) => {
        setInitFailure(event.payload)
      }).then((u) => {
        if (cancelled) {
          u()
        } else {
          unlisten = u
        }
      })
    })
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

  async function toggleEnabled(next: boolean) {
    if (!settings) return
    setSavingEnabled(true)
    try {
      const updated: AutomationSettings = { ...settings, enabled: next }
      await desktop.settingsSet(updated)
      setSettings(updated)
      toast.success(next ? "Automation engine enabled" : "Automation engine disabled")
    } catch (err) {
      toast.error("Update failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSavingEnabled(false)
    }
  }

  async function engageKillSwitch() {
    try {
      await desktop.killSwitch()
      const fresh = await desktop.settingsGet()
      setSettings(fresh)
      toast.warning("Kill switch engaged — all in-flight calls rejected")
    } catch (err) {
      toast.error("Kill switch failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!isTauri()) {
    return (
      <Alert>
        <ShieldAlertIcon className="size-4" />
        <AlertDescription>
          Desktop automation requires the Tauri desktop runtime. Web mode shows the settings shell
          but the actual engine only runs under <code>pnpm tauri dev</code> /{" "}
          <code>pnpm tauri build</code>.
        </AlertDescription>
      </Alert>
    )
  }

  if (loading || !settings) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  const yes = t("yes")
  const no = t("no")
  const planned = t("noPlanned")

  return (
    <div className="space-y-4">
      {initFailure && (
        <Alert variant="destructive">
          <AlertOctagonIcon className="size-4" />
          <AlertTitle>{t("initFailure.title")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              {t("initFailure.body", {
                platform: initFailure.platform,
                error: initFailure.error,
              })}
            </p>
            <Button size="sm" variant="outline" onClick={() => setInitFailure(null)}>
              {t("initFailure.dismiss")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <OverviewMetricsCard />

      <ScreenOffCard platform={caps?.platform} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4" />
            {t("engineStatus")}
          </CardTitle>
          <CardDescription>{t("engineStatusDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="automation-enabled" className="font-medium">
                {t("engineToggle")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("engineToggleHint")}</p>
            </div>
            <Switch
              id="automation-enabled"
              checked={settings.enabled}
              onCheckedChange={toggleEnabled}
              disabled={savingEnabled}
            />
          </div>

          <Button variant="destructive" onClick={engageKillSwitch} className="w-full">
            {t("killSwitch")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("killSwitchHint")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CameraIcon className="size-4" />
            {t("platformCapabilities")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {caps ? (
            <div className="flex flex-wrap gap-2">
              <CapBadge label={t("capabilities.platform")} value={caps.platform} />
              <CapBadge label={t("capabilities.uia")} value={caps.hasUia ? yes : no} />
              <CapBadge
                label={t("capabilities.inputSimulation")}
                value={caps.hasInputSim ? yes : no}
              />
              <CapBadge
                label={t("capabilities.screenshot")}
                value={caps.hasScreenshot ? yes : no}
              />
              <CapBadge label={t("capabilities.events")} value={caps.hasEvents ? yes : planned} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("capabilityProbeFailed")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CapBadge({ label, value }: { label: string; value: string }) {
  return (
    <Badge variant="secondary" className="gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </Badge>
  )
}

function PermissionsTab() {
  const t = useTranslations("automation.permissions")
  const tAuditFilters = useTranslations("automation.audit.filters")
  const [settings, setSettings] = useState<AutomationSettings | null>(() =>
    isTauri() ? null : defaultAutomationSettings()
  )
  const [loading, setLoading] = useState(() => isTauri())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    desktop
      .settingsGet()
      .then(setSettings)
      .catch((err) => toast.error("Read failed", { description: String(err) }))
      .finally(() => setLoading(false))
  }, [])

  async function update(next: AutomationSettings) {
    setSaving(true)
    try {
      await desktop.settingsSet(next)
      setSettings(next)
    } catch (err) {
      toast.error("Update failed", { description: String(err) })
    } finally {
      setSaving(false)
    }
  }

  if (loading || !settings) {
    return <Skeleton className="h-64 w-full" />
  }

  // Sandbox is an audit-only tag (calls go through `sandbox_exec`, never
  // through `command_body!`); exclude it from the per-surface picker so
  // the index into `PerSurfacePolicies` stays exhaustive.
  type AutomationConfigurableSurface = Exclude<Surface, "sandbox">
  const surfaces: Array<{
    id: AutomationConfigurableSurface
    label: string
    description: string
  }> = [
    {
      id: "workflow",
      label: t("tier.off") /* placeholder; overridden below */,
      description: t("surfaces.workflowDescription"),
    },
    {
      id: "computerUse",
      label: "",
      description: t("surfaces.computerUseDescription"),
    },
    {
      id: "mcp",
      label: "",
      description: t("surfaces.mcpDescription"),
    },
    {
      id: "plugin",
      label: "",
      description: t("surfaces.pluginDescription"),
    },
  ]
  // Surface labels reuse the audit filter strings already in i18n.
  surfaces[0].label = tAuditFilters("surfaceWorkflow")
  surfaces[1].label = tAuditFilters("surfaceComputerUse")
  surfaces[2].label = tAuditFilters("surfaceMcp")
  surfaces[3].label = tAuditFilters("surfacePlugin")

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("defaultTier")}</CardTitle>
          <CardDescription>{t("defaultTierDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <TierSelect
            value={settings.defaultTier}
            onChange={(v) => update({ ...settings, defaultTier: v })}
            disabled={saving}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("perSurface")}</CardTitle>
          <CardDescription>{t("perSurfaceDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {surfaces.map((s) => {
            const policy = settings.perSurface[s.id]
            return (
              <div key={s.id} className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <Label className="font-medium">{s.label}</Label>
                  <p className="text-xs text-muted-foreground">{s.description}</p>
                </div>
                <TierSelect
                  value={policy.tier}
                  onChange={(v) => {
                    const nextSurface = { ...policy, tier: v }
                    const next: AutomationSettings = {
                      ...settings,
                      perSurface: { ...settings.perSurface, [s.id]: nextSurface },
                    }
                    update(next)
                  }}
                  disabled={saving}
                />
              </div>
            )
          })}
        </CardContent>
      </Card>

      <PerPluginOverridesCard settings={settings} onChange={update} saving={saving} />
    </div>
  )
}

function TierSelect({
  value,
  onChange,
  disabled,
}: {
  value: Tier
  onChange: (v: Tier) => void
  disabled?: boolean
}) {
  const t = useTranslations("automation.permissions.tier")
  const labelFor = (tier: Tier): string => {
    switch (tier) {
      case "off":
        return t("off")
      case "whitelist":
        return t("whitelist")
      case "perCall":
        return t("perCall")
    }
  }
  return (
    <div className="flex gap-2">
      {(["off", "whitelist", "perCall"] as Tier[]).map((tier) => (
        <Button
          key={tier}
          variant={value === tier ? "default" : "outline"}
          size="sm"
          disabled={disabled}
          onClick={() => onChange(tier)}
        >
          {labelFor(tier)}
        </Button>
      ))}
    </div>
  )
}

// ADR-0020 W2 — per-plugin tier overrides.
//
// `AutomationSettings.perSurface.plugin.perPluginOverrides` was present
// on the Rust gate + TS types since the original ADR but had no UI
// editor — the code path was unreachable from the product. W2 makes
// it editable: every enabled plugin that declares the `native:input`
// permission gets a row with its own TierSelect that writes back to
// `perPluginOverrides[pluginId].tier`. Plugins without an override
// inherit the surface tier (today's behaviour).
function PerPluginOverridesCard({
  settings,
  onChange,
  saving,
}: {
  settings: AutomationSettings
  onChange: (next: AutomationSettings) => Promise<void>
  saving: boolean
}) {
  const t = useTranslations("automation.permissions.perPlugin")
  const tSurfaceLabel = useTranslations("automation.permissions.tier")
  const [eligible, setEligible] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)

  // Late-import the plugin store so this component is safe to mount in
  // jsdom / Storybook contexts where the Zustand store would explode on
  // a missing IDB shim.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { usePluginStore } = await import("@/stores/plugin-runtime/plugin-store")
        // `native:*` permissions are declared by plugins (e.g. computer-use) but
        // smuggled past `PluginPermission` via an `as never` cast in their
        // manifest. Compare against a string set so the union doesn't reject
        // the lookup at compile time.
        const NATIVE_AUTOMATION_PERMS: ReadonlySet<string> = new Set([
          "native:input",
          "native:screen",
        ])
        const plugins = Object.values(usePluginStore.getState().plugins)
        const rows = plugins
          .filter((p) => p.status === "enabled")
          .filter((p) =>
            (p.manifest.permissions ?? []).some((perm) => NATIVE_AUTOMATION_PERMS.has(perm))
          )
          .map((p) => ({ id: p.manifest.id, name: p.manifest.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
        if (!cancelled) setEligible(rows)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const overrides = settings.perSurface.plugin.perPluginOverrides ?? {}

  function setPluginTier(pluginId: string, tier: Tier): void {
    const nextOverrides: Record<string, { tier: Tier }> = { ...overrides }
    nextOverrides[pluginId] = { tier }
    const next: AutomationSettings = {
      ...settings,
      perSurface: {
        ...settings.perSurface,
        plugin: {
          ...settings.perSurface.plugin,
          perPluginOverrides: nextOverrides,
        },
      },
    }
    void onChange(next)
  }

  function clearPluginOverride(pluginId: string): void {
    const nextOverrides: Record<string, { tier: Tier }> = { ...overrides }
    delete nextOverrides[pluginId]
    const next: AutomationSettings = {
      ...settings,
      perSurface: {
        ...settings.perSurface,
        plugin: {
          ...settings.perSurface.plugin,
          perPluginOverrides: nextOverrides,
        },
      },
    }
    void onChange(next)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Skeleton className="h-12 w-full" />
        ) : eligible.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          eligible.map((plugin) => {
            const override = overrides[plugin.id]
            return (
              <div
                key={plugin.id}
                className="flex items-start justify-between gap-4 rounded-md border bg-muted/20 p-2"
              >
                <div className="space-y-0.5">
                  <Label className="font-medium text-xs">{plugin.name}</Label>
                  <p className="text-[10px] text-muted-foreground">
                    {override
                      ? t("rowOverridden", { tier: tSurfaceLabel(override.tier) })
                      : t("rowInheriting")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <TierSelect
                    value={override?.tier ?? settings.perSurface.plugin.tier}
                    onChange={(v) => setPluginTier(plugin.id, v)}
                    disabled={saving}
                  />
                  {override && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => clearPluginOverride(plugin.id)}
                      disabled={saving}
                    >
                      {t("clearOverride")}
                    </Button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}

// ADR-0020 W1 — Last-24h activity counters + top failing commands +
// last screenshot timestamp. Reads from the existing Dexie
// `automationAuditLog` table (no new schema); refreshes on tab mount
// and every 60s while mounted.
function OverviewMetricsCard() {
  const t = useTranslations("automation.overview.metrics")
  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null)
  const [loadError, setLoadError] = useState(false)

  const reload = useCallback(async () => {
    try {
      // listAuditRows is newest-first; pulling 5000 (the LRU cap) gives
      // us the full window the Dexie store retains. The 24h cutoff is
      // applied client-side because Dexie's `where("ts").above(cutoff)`
      // can't be chained with `reverse()` cleanly across our index set.
      const rows = await listAuditRows({ limit: 5000 })
      const cutoff = Date.now() - TWENTY_FOUR_HOURS_MS
      const recent = rows.filter((r) => r.ts >= cutoff)
      const total = recent.length
      let allow = 0
      let deny = 0
      let consent = 0
      const denyByCommand = new Map<string, number>()
      let lastScreenshotTs: number | null = null
      for (const r of recent) {
        if (r.decision === "allow") {
          allow++
          if (r.command === "screenshot" && (lastScreenshotTs == null || r.ts > lastScreenshotTs)) {
            lastScreenshotTs = r.ts
          }
        } else if (r.decision === "deny") {
          deny++
          denyByCommand.set(r.command, (denyByCommand.get(r.command) ?? 0) + 1)
        } else {
          consent++
        }
      }
      const topFailing = [...denyByCommand.entries()]
        .map(([command, count]) => ({ command, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
      setMetrics({
        total,
        allow,
        deny,
        consent,
        topFailing,
        lastScreenshotTs,
        loadedAt: Date.now(),
      })
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    // The eager fetch is deferred via setTimeout(0) so React Compiler treats
    // it the same as the interval callback — calling reload() synchronously
    // in the effect body trips react-hooks/set-state-in-effect.
    const initialId = window.setTimeout(() => {
      void reload()
    }, 0)
    const intervalId = window.setInterval(() => {
      void reload()
    }, METRICS_REFRESH_MS)
    return () => {
      window.clearTimeout(initialId)
      window.clearInterval(intervalId)
    }
  }, [reload])

  // Derived at render. React Compiler memoizes automatically; an explicit
  // useMemo here tripped preserve-manual-memoization on `metrics?.lastScreenshotTs`.
  let lastScreenshotLabel: string
  if (!metrics?.lastScreenshotTs) {
    lastScreenshotLabel = t("lastScreenshotNever")
  } else {
    const seconds = Math.max(0, Math.round((metrics.loadedAt - metrics.lastScreenshotTs) / 1000))
    if (seconds < 60) {
      lastScreenshotLabel = t("lastScreenshotRelative", { seconds })
    } else if (seconds < 3600) {
      lastScreenshotLabel = t("lastScreenshotMinutes", { minutes: Math.floor(seconds / 60) })
    } else {
      lastScreenshotLabel = t("lastScreenshotHours", { hours: Math.floor(seconds / 3600) })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ActivityIcon className="size-4" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <p className="text-xs text-destructive">{t("loadFailed")}</p>
        ) : metrics ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <CounterCell label={t("total")} value={metrics.total} />
              <CounterCell label={t("allow")} value={metrics.allow} accent="success" />
              <CounterCell label={t("deny")} value={metrics.deny} accent="destructive" />
              <CounterCell label={t("consent")} value={metrics.consent} accent="warning" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("topFailingTitle")}</Label>
              <p className="text-[10px] text-muted-foreground">{t("topFailingDescription")}</p>
              {metrics.topFailing.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("topFailingEmpty")}</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {metrics.topFailing.map((entry) => (
                    <li key={entry.command} className="flex items-center justify-between">
                      <code className="font-mono">{entry.command}</code>
                      <Badge variant="destructive" className="text-[10px]">
                        {entry.count}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("lastScreenshotTitle")}</Label>
              <p className="text-[10px] text-muted-foreground">{t("lastScreenshotDescription")}</p>
              <p className="text-xs">{lastScreenshotLabel}</p>
            </div>
          </>
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </CardContent>
    </Card>
  )
}

function CounterCell({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: "success" | "destructive" | "warning"
}) {
  const accentClass =
    accent === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "destructive"
        ? "text-destructive"
        : accent === "warning"
          ? "text-amber-600 dark:text-amber-400"
          : ""
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold ${accentClass}`}>{value}</p>
    </div>
  )
}

// Pull in the audit table here so the inner CardContent body keeps its
// surface predictable when the tab is mounted.
export { AutomationAuditTable }

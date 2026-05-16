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
 */

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { CameraIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"

import { isTauri } from "@/lib/tauri"
import {
  desktop,
  defaultAutomationSettings,
  type AutomationSettings,
  type Surface,
  type Tier,
} from "@/lib/automation/client"
import type { Capabilities } from "@/lib/automation/types"

import { AutomationAuditTable } from "./automation-audit-table"
import { WhitelistTab } from "./whitelist-tab"
import { InspectorTab } from "./inspector-tab"

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

  const surfaces: Array<{ id: Surface; label: string; description: string }> = [
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

// Pull in the audit table here so the inner CardContent body keeps its
// surface predictable when the tab is mounted.
export { AutomationAuditTable }

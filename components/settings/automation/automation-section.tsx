"use client"

/**
 * Settings → Automation. Five-tab shell (`?autoTab=`); M1 ships Overview,
 * Permissions, Audit, and a placeholder for Whitelist + Inspector (M2).
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

  const setTab = (tab: TabId) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set("autoTab", tab)
    router.replace(`/settings?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold">UI Automation</h2>
        <p className="text-sm text-muted-foreground">
          Drive the desktop on behalf of AI agents and workflow nodes — with consent. Disabled by
          default; the global kill switch on the Overview tab cuts every in-flight call.
        </p>
      </header>

      <Tabs value={activeTab} onValueChange={(t) => setTab(t as TabId)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="whitelist">Whitelist</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="inspector">Inspector</TabsTrigger>
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4" />
            Engine status
          </CardTitle>
          <CardDescription>
            The Rust worker thread is always alive; this switch flips whether commands are accepted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="automation-enabled" className="font-medium">
                Automation engine
              </Label>
              <p className="text-xs text-muted-foreground">
                When off, every Tauri command returns <code>KILL_SWITCH_ACTIVE</code>.
              </p>
            </div>
            <Switch
              id="automation-enabled"
              checked={settings.enabled}
              onCheckedChange={toggleEnabled}
              disabled={savingEnabled}
            />
          </div>

          <Button variant="destructive" onClick={engageKillSwitch} className="w-full">
            Engage global kill switch
          </Button>
          <p className="text-xs text-muted-foreground">
            Equivalent to flipping the switch off, but also surfaces a toast and is wired to the
            system-tray menu + the <kbd>Esc Esc Esc</kbd> global hotkey.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CameraIcon className="size-4" />
            Platform capabilities
          </CardTitle>
        </CardHeader>
        <CardContent>
          {caps ? (
            <div className="flex flex-wrap gap-2">
              <CapBadge label="Platform" value={caps.platform} />
              <CapBadge label="UIA" value={caps.hasUia ? "yes" : "no"} />
              <CapBadge label="Input simulation" value={caps.hasInputSim ? "yes" : "no"} />
              <CapBadge label="Screenshot" value={caps.hasScreenshot ? "yes" : "no"} />
              <CapBadge label="Events" value={caps.hasEvents ? "yes" : "no (M2)"} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Capability probe failed.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CapBadge({ label, value }: { label: string; value: string }) {
  return (
    <Badge variant="secondary" className="gap-1">
      <span className="text-muted-foreground">{label}:</span>
      <span>{value}</span>
    </Badge>
  )
}

function PermissionsTab() {
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
      label: "Workflows",
      description: "Tier for action.desktop.* nodes in visual workflows.",
    },
    {
      id: "computerUse",
      label: "Computer use",
      description: "Tier for Anthropic native computer-use tool calls (M2).",
    },
    {
      id: "mcp",
      label: "MCP tools",
      description: "Tier for desktop_* MCP tools exposed via External Bridge (M2).",
    },
    {
      id: "plugin",
      label: "Plugin API",
      description: "Tier for plugins using ctx.desktop (M2).",
    },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Default tier</CardTitle>
          <CardDescription>
            Off blocks everything. Whitelist allows calls whose target window matches the global
            whitelist (Whitelist tab, M2). Per-call requires HITL consent for driving calls (click,
            type, keys).
          </CardDescription>
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
          <CardTitle>Per-surface override</CardTitle>
          <CardDescription>
            Each consumer surface can override the default tier with a stricter setting.
          </CardDescription>
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
  return (
    <div className="flex gap-2">
      {(["off", "whitelist", "perCall"] as Tier[]).map((t) => (
        <Button
          key={t}
          variant={value === t ? "default" : "outline"}
          size="sm"
          disabled={disabled}
          onClick={() => onChange(t)}
        >
          {t === "perCall" ? "Per-call" : t.charAt(0).toUpperCase() + t.slice(1)}
        </Button>
      ))}
    </div>
  )
}

// Pull in the audit table here so the inner CardContent body keeps its
// surface predictable when the tab is mounted.
export { AutomationAuditTable }

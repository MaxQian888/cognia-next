"use client"

// Tabbed shell for the Plugins settings section. Mirrors the pattern set by
// `data-section.tsx` (URL-synced inner Tabs via useSyncExternalStore) so deep-
// linking lands on the right pane, and the embedded settings dialog and the
// stand-alone settings route share the same URL contract.
//
// Eight sub-tabs cover the user-facing surface of the plugin platform:
//   overview      — counts, governance toggle, deep-link to /plugins
//   installed     — compact table of installed plugins (live from Dexie)
//   marketplace   — pointer to /plugins?tab=browse (full marketplace UI is M5C)
//   permissions   — PERMISSION_GROUPS folded UI + DANGEROUS callouts
//   scheduled     — pointer to scheduled-tasks-section (which already supports
//                   plugin task type) + summary of pluginScheduledJobs rows
//   devtools      — gated by ?developerMode= or NODE_ENV=development; surfaces
//                   the lib/plugin/devtools/ runtime hooks via plugin-extension-
//                   slot for plugin-contributed dev panels
//   audit         — renders auditPluginPointContracts() output (verified /
//                   missing_proof / not_applicable) so reviewers can spot
//                   contract drift without running tests
//   settings      — governance mode (warn/block), signature requirement,
//                   auto-update; rate-limit defaults are shown read-only
//
// All deep management (CRUD, marketplace install, conflict review, config
// form, dependency graph, etc.) lives at /plugins and is implemented in M5B/C.

import Link from "next/link"
import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  ArrowRightIcon,
  BoxesIcon,
  ClockIcon,
  ShieldCheckIcon,
  BugIcon,
  ListChecksIcon,
  WrenchIcon,
  StoreIcon,
  SettingsIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { listPlugins } from "@/lib/db/plugins"
import {
  PERMISSION_GROUPS,
  DANGEROUS_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
} from "@/lib/plugin/security/permission-guard"
import {
  auditPluginPointContracts,
  type PluginPointGovernanceMode,
} from "@/lib/plugin/contracts/plugin-points"
import { PluginMarketplace } from "@/components/plugins/plugin-marketplace"
import { PluginScheduledJobs } from "@/components/plugins/plugin-scheduled-jobs"
import { PluginDevtoolsPanel } from "@/components/plugins/plugin-devtools-panel"
import { PluginPointDiagnosticsPanel } from "@/components/plugins/plugin-point-diagnostics-panel"
import { ScrollShadowRow } from "@/components/plugins/scroll-shadow-row"

const PLUGINS_TAB_PARAM = "pluginsTab"

export type PluginsSubTab =
  | "overview"
  | "installed"
  | "marketplace"
  | "permissions"
  | "scheduled"
  | "devtools"
  | "audit"
  | "settings"

const TAB_IDS: PluginsSubTab[] = [
  "overview",
  "installed",
  "marketplace",
  "permissions",
  "scheduled",
  "devtools",
  "audit",
  "settings",
]

function isPluginsTab(value: string | null): value is PluginsSubTab {
  return !!value && (TAB_IDS as string[]).includes(value)
}

interface Props {
  /** Optional close handler — called before navigating, in case the host is a Sheet. */
  onClose?: () => void
}

export function PluginsSection({ onClose }: Props) {
  const t = useTranslations("settings.plugins")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(PLUGINS_TAB_PARAM)
  const activeTab: PluginsSubTab = isPluginsTab(requested) ? requested : "overview"

  const onTabChange = (value: string) => {
    if (!isPluginsTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(PLUGINS_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <BoxesIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <ScrollShadowRow scrollerClassName="-mx-1 px-1" testId="plugins-section-tabs">
          <TabsList className="inline-flex h-9 w-max whitespace-nowrap">
            <TabsTrigger value="overview" className="gap-1.5">
              <BoxesIcon className="size-3.5" />
              {t("subTabs.overview")}
            </TabsTrigger>
            <TabsTrigger value="installed" className="gap-1.5">
              <ListChecksIcon className="size-3.5" />
              {t("subTabs.installed")}
            </TabsTrigger>
            <TabsTrigger value="marketplace" className="gap-1.5">
              <StoreIcon className="size-3.5" />
              {t("subTabs.marketplace")}
            </TabsTrigger>
            <TabsTrigger value="permissions" className="gap-1.5">
              <ShieldCheckIcon className="size-3.5" />
              {t("subTabs.permissions")}
            </TabsTrigger>
            <TabsTrigger value="scheduled" className="gap-1.5">
              <ClockIcon className="size-3.5" />
              {t("subTabs.scheduled")}
            </TabsTrigger>
            <TabsTrigger value="devtools" className="gap-1.5">
              <BugIcon className="size-3.5" />
              {t("subTabs.devtools")}
            </TabsTrigger>
            <TabsTrigger value="audit" className="gap-1.5">
              <WrenchIcon className="size-3.5" />
              {t("subTabs.audit")}
            </TabsTrigger>
            <TabsTrigger value="settings" className="gap-1.5">
              <SettingsIcon className="size-3.5" />
              {t("subTabs.settings")}
            </TabsTrigger>
          </TabsList>
        </ScrollShadowRow>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab onClose={onClose} />
        </TabsContent>
        <TabsContent value="installed" className="mt-4">
          <InstalledTab onClose={onClose} />
        </TabsContent>
        <TabsContent value="marketplace" className="mt-4">
          <MarketplaceTab onClose={onClose} />
        </TabsContent>
        <TabsContent value="permissions" className="mt-4">
          <PermissionsTab />
        </TabsContent>
        <TabsContent value="scheduled" className="mt-4">
          <ScheduledTab />
        </TabsContent>
        <TabsContent value="devtools" className="mt-4">
          <DevtoolsTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// =============================================================================
// Overview tab
// =============================================================================

function OverviewTab({ onClose }: { onClose?: () => void }) {
  const t = useTranslations("settings.plugins.overview")
  const plugins = useLiveQuery(() => listPlugins(), [])

  const counts = (() => {
    const total = plugins?.length ?? 0
    const enabled = plugins?.filter((p) => p.enabled).length ?? 0
    const errored = plugins?.filter((p) => p.status === "error").length ?? 0
    const loading =
      plugins?.filter((p) => p.status === "loading" || p.status === "enabling").length ?? 0
    return { total, enabled, errored, loading }
  })()

  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="text-xs">
          {t("badgeTotal", { count: counts.total })}
        </Badge>
        <Badge variant="outline" className="text-xs">
          {t("badgeEnabled", { count: counts.enabled })}
        </Badge>
        <Badge variant="outline" className="text-xs">
          {t("badgeLoading", { count: counts.loading })}
        </Badge>
        <Badge variant={counts.errored > 0 ? "destructive" : "outline"} className="text-xs">
          {t("badgeError", { count: counts.errored })}
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground">{t("hint")}</p>

      <div className="flex justify-end">
        <Button asChild size="sm" onClick={() => onClose?.()}>
          <Link href="/plugins">
            {t("manageButton")}
            <ArrowRightIcon className="ml-1.5 size-3.5" />
          </Link>
        </Button>
      </div>
    </Card>
  )
}

// =============================================================================
// Installed tab
// =============================================================================

function InstalledTab({ onClose }: { onClose?: () => void }) {
  const t = useTranslations("settings.plugins.installed")
  const plugins = useLiveQuery(() => listPlugins(), [])

  if (!plugins) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }

  if (plugins.length === 0) {
    return (
      <Card className="p-6 text-center space-y-3">
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
        <Button asChild size="sm" variant="outline" onClick={() => onClose?.()}>
          <Link href="/plugins?tab=browse">{t("browseMarketplace")}</Link>
        </Button>
      </Card>
    )
  }

  return (
    <Card>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colName")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("colVersion")}</TableHead>
              <TableHead>{t("colSource")}</TableHead>
              <TableHead>{t("colStatus")}</TableHead>
              <TableHead className="hidden md:table-cell text-right">
                {t("colCapabilities")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plugins.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell className="hidden md:table-cell text-muted-foreground">
                  {p.version}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {p.source}
                  </Badge>
                </TableCell>
                <TableCell>
                  <PluginStatusBadge status={p.status} enabled={p.enabled} />
                </TableCell>
                <TableCell className="hidden md:table-cell text-right text-xs text-muted-foreground">
                  {p.capabilities.length}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="border-t p-3 flex justify-end">
        <Button asChild size="sm" variant="ghost" onClick={() => onClose?.()}>
          <Link href="/plugins">
            {t("openFullManagement")}
            <ArrowRightIcon className="ml-1.5 size-3.5" />
          </Link>
        </Button>
      </div>
    </Card>
  )
}

function PluginStatusBadge({ status, enabled }: { status: string; enabled: boolean }) {
  const t = useTranslations("settings.plugins.statusBadge")
  if (status === "error") {
    return (
      <Badge variant="destructive" className="text-xs gap-1">
        <CircleAlertIcon className="size-3" /> {t("error")}
      </Badge>
    )
  }
  if (!enabled) {
    return (
      <Badge variant="outline" className="text-xs">
        {t("disabled")}
      </Badge>
    )
  }
  if (status === "enabled" || status === "loaded") {
    return (
      <Badge variant="secondary" className="text-xs gap-1">
        <CheckCircle2Icon className="size-3" /> {t("enabled")}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-xs">
      {status}
    </Badge>
  )
}

// =============================================================================
// Marketplace tab
// =============================================================================

function MarketplaceTab({ onClose }: { onClose?: () => void }) {
  const t = useTranslations("settings.plugins.marketplace")
  return (
    <div className="space-y-3">
      <Card className="p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <StoreIcon className="size-3.5" />
            {t("title")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>
        <Button asChild size="sm" variant="outline" onClick={() => onClose?.()}>
          <Link href="/plugins?tab=browse">
            {t("openButton")}
            <ArrowRightIcon className="ml-1.5 size-3.5" />
          </Link>
        </Button>
      </Card>
      <PluginMarketplace />
    </div>
  )
}

// =============================================================================
// Permissions tab
// =============================================================================

function PermissionsTab() {
  const t = useTranslations("settings.plugins.permissions")
  const plugins = useLiveQuery(() => listPlugins(), [])

  return (
    <Card className="p-4 space-y-3">
      <p className="text-xs text-muted-foreground">{t("hint")}</p>

      <Accordion type="multiple" className="space-y-2">
        {Object.entries(PERMISSION_GROUPS).map(([groupName, perms]) => (
          <AccordionItem key={groupName} value={groupName} className="border rounded-md px-3">
            <AccordionTrigger className="text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{t(`groups.${groupName}` as never)}</span>
                <Badge variant="outline" className="text-xs">
                  {perms.length}
                </Badge>
                {groupName === "dangerous" && (
                  <Badge variant="destructive" className="text-xs gap-1">
                    <AlertTriangleIcon className="size-3" />
                    {t("dangerousLabel")}
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-2 pt-2">
              {perms.map((perm) => {
                const granted = (plugins ?? []).filter((p) =>
                  (p.manifest as { permissions?: string[] })?.permissions?.includes(perm)
                )
                const isDangerous = DANGEROUS_PERMISSIONS.includes(perm)
                return (
                  <div
                    key={perm}
                    className="flex items-start justify-between gap-3 py-1.5 border-b last:border-b-0"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs font-mono">{perm}</code>
                        {isDangerous && (
                          <AlertTriangleIcon
                            className="size-3 text-destructive shrink-0"
                            aria-label={t("dangerousLabel")}
                          />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {PERMISSION_DESCRIPTIONS[perm] ?? perm}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-xs shrink-0">
                      {t("grantedTo", { count: granted.length })}
                    </Badge>
                  </div>
                )
              })}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </Card>
  )
}

// =============================================================================
// Scheduled tab
// =============================================================================

function ScheduledTab() {
  const t = useTranslations("settings.plugins.scheduled")
  return (
    <div className="space-y-3">
      <Card className="p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <ClockIcon className="size-3.5" />
            {t("title")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/settings?section=scheduled-tasks">
            {t("openSchedulerButton")}
            <ArrowRightIcon className="ml-1.5 size-3.5" />
          </Link>
        </Button>
      </Card>
      <PluginScheduledJobs />
    </div>
  )
}

// =============================================================================
// Devtools tab
// =============================================================================

function DevtoolsTab() {
  const t = useTranslations("settings.plugins.devtools")
  const isDev = typeof process !== "undefined" && process.env.NODE_ENV === "development"

  if (!isDev) {
    return (
      <Card className="p-6 text-center space-y-3">
        <BugIcon className="size-10 mx-auto text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{t("gateHint")}</p>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <Card className="p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <BugIcon className="size-3.5" />
            {t("title")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/plugins?tab=devtools">
            {t("openButton")}
            <ArrowRightIcon className="ml-1.5 size-3.5" />
          </Link>
        </Button>
      </Card>
      <PluginDevtoolsPanel />
    </div>
  )
}

// =============================================================================
// Audit tab
// =============================================================================

function AuditTab() {
  const t = useTranslations("settings.plugins.audit")
  const audit = auditPluginPointContracts()

  const verified = audit.filter((a) => a.proofStatus === "verified").length
  const missing = audit.filter((a) => a.proofStatus === "missing_proof")
  const total = audit.length

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            {t("badgeTotal", { count: total })}
          </Badge>
          <Badge variant="outline" className="text-xs gap-1">
            <CheckCircle2Icon className="size-3" />
            {t("badgeVerified", { count: verified })}
          </Badge>
          {missing.length > 0 && (
            <Badge variant="destructive" className="text-xs gap-1">
              <CircleAlertIcon className="size-3" />
              {t("badgeMissing", { count: missing.length })}
            </Badge>
          )}
        </div>

        {missing.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("allVerified")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colId")}</TableHead>
                <TableHead>{t("colKind")}</TableHead>
                <TableHead>{t("colMissing")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {missing.map((entry) => (
                <TableRow key={`${entry.kind}:${entry.id}`}>
                  <TableCell className="font-mono text-xs">{entry.id}</TableCell>
                  <TableCell className="text-xs">{entry.kind}</TableCell>
                  <TableCell className="text-xs text-destructive">
                    {entry.missingFields.join(", ")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <PluginPointDiagnosticsPanel />
    </div>
  )
}

// =============================================================================
// Settings tab — global plugin policy
// =============================================================================

const POLICY_STORAGE_KEY = "cognia.plugins.policy"

interface PluginsPolicy {
  governance: PluginPointGovernanceMode
  signatureRequired: boolean
  autoUpdate: boolean
}

const DEFAULT_POLICY: PluginsPolicy = {
  governance: "warn",
  signatureRequired: false,
  autoUpdate: false,
}

function readPolicy(): PluginsPolicy {
  if (typeof window === "undefined") return DEFAULT_POLICY
  try {
    const raw = window.localStorage.getItem(POLICY_STORAGE_KEY)
    if (!raw) return DEFAULT_POLICY
    const parsed = JSON.parse(raw)
    return {
      governance: parsed.governance === "block" ? "block" : "warn",
      signatureRequired: !!parsed.signatureRequired,
      autoUpdate: !!parsed.autoUpdate,
    }
  } catch {
    return DEFAULT_POLICY
  }
}

function writePolicy(policy: PluginsPolicy) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(policy))
  } catch {
    // ignore quota errors
  }
}

function SettingsTab() {
  const t = useTranslations("settings.plugins.policy")
  // Lazy init from localStorage (fresh per mount). useSyncExternalStore would
  // need a stable snapshot reference; localStorage policy doesn't change
  // externally during a tab session, so plain useState avoids that constraint.
  const [policy, setPolicy] = useState<PluginsPolicy>(() => readPolicy())

  const update = (patch: Partial<PluginsPolicy>) => {
    const next = { ...policy, ...patch }
    setPolicy(next)
    writePolicy(next)
  }

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <Label htmlFor="plugins-governance-mode">{t("governance")}</Label>
          <p className="text-xs text-muted-foreground">{t("governanceHint")}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("governanceWarn")}</span>
          <Switch
            id="plugins-governance-mode"
            checked={policy.governance === "block"}
            onCheckedChange={(checked) => update({ governance: checked ? "block" : "warn" })}
          />
          <span className="text-xs text-muted-foreground">{t("governanceBlock")}</span>
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1 min-w-0">
          <Label htmlFor="plugins-signature-required">{t("signatureRequired")}</Label>
          <p className="text-xs text-muted-foreground">{t("signatureRequiredHint")}</p>
        </div>
        <Switch
          id="plugins-signature-required"
          checked={policy.signatureRequired}
          onCheckedChange={(checked) => update({ signatureRequired: checked })}
        />
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1 min-w-0">
          <Label htmlFor="plugins-auto-update">{t("autoUpdate")}</Label>
          <p className="text-xs text-muted-foreground">{t("autoUpdateHint")}</p>
        </div>
        <Switch
          id="plugins-auto-update"
          checked={policy.autoUpdate}
          onCheckedChange={(checked) => update({ autoUpdate: checked })}
        />
      </div>

      <div className="border-t pt-4 text-xs text-muted-foreground">{t("rateLimitsNote")}</div>
    </Card>
  )
}

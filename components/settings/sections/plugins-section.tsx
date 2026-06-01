"use client"

// Tabbed shell for the Plugins settings governance panel. Four sub-tabs:
//   overview  — counts, health, and deep-link summary cards to the
//               /plugins workspace (installed / marketplace /
//               permissions / devtools)
//   scheduled — read-only summary + link to scheduler section
//   audit     — auditPluginPointContracts() output + diagnostics panel
//   policy    — governance mode, signature requirement, auto-update
//
// All workspace-level management (CRUD, install, configure, analytics,
// devtools, permissions review, marketplace browsing) lives at
// `/plugins`. This Settings panel intentionally exposes only the
// governance surface so administrators can run it without leaving
// settings.

import Link from "next/link"
import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  ArrowRightIcon,
  BoxesIcon,
  BugIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  ClockIcon,
  ListChecksIcon,
  SettingsIcon,
  ShieldCheckIcon,
  StoreIcon,
  WrenchIcon,
  type LucideIcon,
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
import { listPlugins } from "@/lib/db/plugins"
import {
  auditPluginPointContracts,
  type PluginPointGovernanceMode,
} from "@/lib/plugin/contracts/plugin-points"
import { PluginScheduledJobs } from "@/components/plugins/detail/plugin-scheduled-jobs"
import { PluginPointDiagnosticsPanel } from "@/components/plugins/plugin-point-diagnostics-panel"
import { ScrollShadowRow } from "@/components/plugins/scroll-shadow-row"
import { PluginDataManagement } from "@/components/settings/plugins/plugin-data-management"
import { applyPluginPolicyToRuntime } from "@/lib/plugin/core/policy-runtime"

const PLUGINS_TAB_PARAM = "pluginsTab"

export type PluginsSubTab = "overview" | "scheduled" | "audit" | "policy"

const TAB_IDS: PluginsSubTab[] = ["overview", "scheduled", "audit", "policy"]

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
            <TabsTrigger value="scheduled" className="gap-1.5">
              <ClockIcon className="size-3.5" />
              {t("subTabs.scheduled")}
            </TabsTrigger>
            <TabsTrigger value="audit" className="gap-1.5">
              <WrenchIcon className="size-3.5" />
              {t("subTabs.audit")}
            </TabsTrigger>
            <TabsTrigger value="policy" className="gap-1.5">
              <SettingsIcon className="size-3.5" />
              {t("subTabs.policy")}
            </TabsTrigger>
          </TabsList>
        </ScrollShadowRow>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab onClose={onClose} />
        </TabsContent>
        <TabsContent value="scheduled" className="mt-4">
          <ScheduledTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
        <TabsContent value="policy" className="mt-4">
          <PolicyTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// =============================================================================
// Overview tab — counts, health, deep-link summary cards
// =============================================================================

type DeepLinkKey = "installed" | "marketplace" | "permissions" | "devtools"

function OverviewTab({ onClose }: { onClose?: () => void }) {
  const t = useTranslations("settings.plugins.overview")
  const plugins = useLiveQuery(() => listPlugins(), [])
  const isDev = typeof process !== "undefined" && process.env.NODE_ENV === "development"

  const counts = (() => {
    const total = plugins?.length ?? 0
    const enabled = plugins?.filter((p) => p.enabled).length ?? 0
    const errored = plugins?.filter((p) => p.status === "error").length ?? 0
    const loading =
      plugins?.filter((p) => p.status === "loading" || p.status === "enabling").length ?? 0
    return { total, enabled, errored, loading }
  })()

  const cards: Array<{
    key: DeepLinkKey
    icon: LucideIcon
    href: string
    show: boolean
  }> = [
    // Use the new `?section=` deep-link vocabulary. `?tab=` still works as
    // a back-compat shim in the panel (it auto-translates via
    // `deriveSectionFromTab`), but new links should point at the
    // section model so the 3-pane shell lands directly on the right view.
    { key: "installed", icon: ListChecksIcon, href: "/plugins?section=library", show: true },
    { key: "marketplace", icon: StoreIcon, href: "/plugins?section=discover", show: true },
    {
      key: "permissions",
      icon: ShieldCheckIcon,
      href: "/plugins?section=governance&gov=permissions",
      show: true,
    },
    { key: "devtools", icon: BugIcon, href: "/plugins?section=devtools", show: isDev },
  ]

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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {cards
          .filter((c) => c.show)
          .map((card) => (
            <DeepLinkCard
              key={card.key}
              icon={card.icon}
              title={t(`${card.key}Card.title`)}
              hint={t(`${card.key}Card.hint`)}
              cta={t(`${card.key}Card.cta`)}
              href={card.href}
              onNavigate={onClose}
            />
          ))}
      </div>

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

interface DeepLinkCardProps {
  icon: LucideIcon
  title: string
  hint: string
  cta: string
  href: string
  onNavigate?: () => void
}

function DeepLinkCard({ icon: Icon, title, hint, cta, href, onNavigate }: DeepLinkCardProps) {
  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        <Icon className="size-3.5" />
        {title}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex justify-end">
        <Button asChild size="sm" variant="outline" onClick={() => onNavigate?.()}>
          <Link href={href}>
            {cta}
            <ArrowRightIcon className="ml-1.5 size-3.5" />
          </Link>
        </Button>
      </div>
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

      {/* Per-plugin Dexie table maintenance — list mode renders every plugin
          that has declared custom tables, so administrators can purge
          plugin data without uninstalling the plugin itself. The single-mode
          version is rendered inside each plugin's detail Sheet (Data tab). */}
      <Card className="p-4 space-y-3" data-testid="audit-data-management-card">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t("dataManagementTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("dataManagementHint")}</p>
        </div>
        <PluginDataManagement />
      </Card>
    </div>
  )
}

// =============================================================================
// Policy tab — global plugin policy
// =============================================================================

const POLICY_STORAGE_KEY = "cognia.plugins.policy"

interface PluginsPolicy {
  governance: PluginPointGovernanceMode
  signatureRequired: boolean
  trustedPublishersOnly: boolean
  autoUpdate: boolean
}

// ADR 0016 P0-3 (2026-05-17) — `signatureRequired` is default-on. Toggle
// stays user-overridable; the policy panel writes the explicit choice into
// localStorage so users who opted out keep that preference.
const DEFAULT_POLICY: PluginsPolicy = {
  governance: "warn",
  signatureRequired: true,
  // Default off for back-compat: requiring a *trusted* signer is stricter than
  // requiring any valid signature, and only becomes meaningful once an official
  // publisher key is configured at build time.
  trustedPublishersOnly: false,
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
      // Only respect an explicit `false`; missing/undefined keeps the new
      // default-on behavior so users upgrading without ever opening Settings
      // still get strict enforcement.
      signatureRequired:
        typeof parsed.signatureRequired === "boolean" ? parsed.signatureRequired : true,
      trustedPublishersOnly: !!parsed.trustedPublishersOnly,
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

function PolicyTab() {
  const t = useTranslations("settings.plugins.policy")
  // Lazy init from localStorage (fresh per mount). useSyncExternalStore would
  // need a stable snapshot reference; localStorage policy doesn't change
  // externally during a tab session, so plain useState avoids that constraint.
  const [policy, setPolicy] = useState<PluginsPolicy>(() => readPolicy())

  // Apply the persisted policy to the live runtime once when the panel
  // mounts. The plugin-store boot path also calls this for normal app
  // start, but mounting Settings without having opened a plugin yet may
  // still hit a stale runtime state — re-applying is idempotent.
  useEffect(() => {
    applyPluginPolicyToRuntime(policy)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (patch: Partial<PluginsPolicy>) => {
    const next = { ...policy, ...patch }
    setPolicy(next)
    writePolicy(next)
    // Push the change into the live runtime so it takes effect without a
    // page reload (the previous behavior).
    applyPluginPolicyToRuntime(next)
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
          <Label htmlFor="plugins-trusted-publishers-only">{t("trustedPublishersOnly")}</Label>
          <p className="text-xs text-muted-foreground">{t("trustedPublishersOnlyHint")}</p>
        </div>
        <Switch
          id="plugins-trusted-publishers-only"
          checked={policy.trustedPublishersOnly}
          onCheckedChange={(checked) => update({ trustedPublishersOnly: checked })}
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

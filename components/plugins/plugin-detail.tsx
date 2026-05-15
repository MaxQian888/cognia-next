"use client"

// Detail content rendered inside `plugin-detail-panel.tsx`. Outer 3-tab
// shell (General / Contributed / Data) wraps the existing 7 inner tabs.
// Pulls a fresh row from Dexie so external mutations (manager updates)
// reflect without prop drilling.

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getPlugin } from "@/lib/db/plugins"
import {
  DANGEROUS_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
} from "@/lib/plugin/security/permission-guard"
import { DEFAULT_RATE_LIMITS } from "@/lib/plugin/security/rate-limiter"
import type { PluginPermission } from "@/types/plugin"
import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePluginsStore } from "@/stores/plugins"
import { PluginBackupPanel } from "./plugin-backup-panel"
import { PluginResourceManager } from "./plugin-resource-manager"
import { PluginDependencyGraph } from "./plugin-dependency-graph"
import { PluginAnalytics } from "./plugin-analytics"
import { PluginContributedTab } from "./plugin-contributed-tab"
import { PluginDataManagement } from "@/components/settings/plugins/plugin-data-management"

interface Props {
  pluginId: string
}

// PluginResourceManager expects { key, limit, windowMs } but the runtime
// stores token-bucket configs ({ capacity, refillPerSecond }). Build the
// translation once at module load — the defaults don't change per render.
const RESOURCE_LIMITS = Object.entries(DEFAULT_RATE_LIMITS).map(([key, cfg]) => ({
  key,
  limit: cfg.capacity,
  windowMs: cfg.refillPerSecond > 0 ? Math.round(1000 / cfg.refillPerSecond) : 0,
}))

export function PluginDetail({ pluginId }: Props) {
  const t = useTranslations("plugins.detail")
  const plugin = useLiveQuery(() => getPlugin(pluginId), [pluginId])
  const setRollbackTarget = usePluginsStore((s) => s.setRollbackTarget)

  if (!plugin) {
    return <p className="text-sm text-muted-foreground p-4">{t("notFound")}</p>
  }

  const manifest = plugin.manifest as {
    description?: string
    author?: string | { name: string }
    permissions?: PluginPermission[]
    optionalPermissions?: PluginPermission[]
    homepage?: string
    repository?: string
    license?: string
    activationEvents?: string[]
    contributes?: Record<string, unknown>
    dependencies?: Record<string, string>
  }
  const author =
    typeof manifest.author === "string" ? manifest.author : (manifest.author?.name ?? "")

  return (
    <Tabs defaultValue="general" className="mt-4">
      <div className="overflow-x-auto -mx-4 px-4">
        <TabsList className="inline-flex h-9 w-max whitespace-nowrap">
          <TabsTrigger value="general">{t("tabGeneral")}</TabsTrigger>
          <TabsTrigger value="contributed">{t("tabContributed")}</TabsTrigger>
          <TabsTrigger value="data">{t("tabData")}</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="general" className="mt-3">
        <Tabs defaultValue="overview">
          <div className="overflow-x-auto -mx-4 px-4">
            <TabsList className="inline-flex h-9 w-max whitespace-nowrap">
              <TabsTrigger value="overview">{t("tabOverview")}</TabsTrigger>
              <TabsTrigger value="manifest">{t("tabManifest")}</TabsTrigger>
              <TabsTrigger value="capabilities">{t("tabCapabilities")}</TabsTrigger>
              <TabsTrigger value="permissions">{t("tabPermissions")}</TabsTrigger>
              <TabsTrigger value="lifecycle">{t("tabLifecycle")}</TabsTrigger>
              <TabsTrigger value="operations">{t("tabOperations")}</TabsTrigger>
              <TabsTrigger value="analytics">{t("tabAnalytics")}</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="mt-3 space-y-3">
            <MetaRow label={t("metaId")} value={plugin.id} />
            <MetaRow label={t("metaVersion")} value={plugin.version} />
            <MetaRow label={t("metaSource")} value={plugin.source} />
            <MetaRow label={t("metaType")} value={plugin.type} />
            <MetaRow label={t("metaStatus")} value={plugin.status} />
            {author && <MetaRow label={t("metaAuthor")} value={author} />}
            {manifest.license && <MetaRow label={t("metaLicense")} value={manifest.license} />}
            {manifest.homepage && <MetaRow label={t("metaHomepage")} value={manifest.homepage} />}
            {manifest.repository && (
              <MetaRow label={t("metaRepository")} value={manifest.repository} />
            )}
            {plugin.error && (
              <Card className="border-destructive p-3 space-y-1">
                <div className="text-xs font-semibold text-destructive">{t("metaError")}</div>
                <div className="text-xs text-destructive">{plugin.error}</div>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="manifest" className="mt-3">
            <Card className="p-0">
              <ScrollArea className="max-h-[60vh]">
                <pre className="p-3 text-xs font-mono leading-snug">
                  {JSON.stringify(plugin.manifest, null, 2)}
                </pre>
              </ScrollArea>
            </Card>
          </TabsContent>

          <TabsContent value="capabilities" className="mt-3 space-y-2">
            {plugin.capabilities.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("emptyCapabilities")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {plugin.capabilities.map((cap) => (
                  <Badge key={cap} variant="outline">
                    {cap}
                  </Badge>
                ))}
              </div>
            )}
            {manifest.contributes && (
              <Card className="p-3 space-y-1">
                <div className="text-xs font-semibold">{t("contributes")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.keys(manifest.contributes).map((key) => (
                    <Badge key={key} variant="outline" className="text-xs">
                      {key}
                    </Badge>
                  ))}
                </div>
              </Card>
            )}
            {manifest.activationEvents && manifest.activationEvents.length > 0 && (
              <Card className="p-3 space-y-1">
                <div className="text-xs font-semibold">{t("activation")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {manifest.activationEvents.map((ev) => (
                    <Badge key={ev} variant="outline" className="text-xs">
                      {ev}
                    </Badge>
                  ))}
                </div>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="permissions" className="mt-3 space-y-3">
            <PermissionList
              title={t("declared")}
              empty={t("declaredEmpty")}
              permissions={manifest.permissions ?? []}
            />
            <PermissionList
              title={t("optional")}
              empty={t("optionalEmpty")}
              permissions={manifest.optionalPermissions ?? []}
            />
          </TabsContent>

          <TabsContent value="lifecycle" className="mt-3 space-y-2">
            <MetaRow label={t("metaCreatedAt")} value={new Date(plugin.createdAt).toISOString()} />
            <MetaRow label={t("metaUpdatedAt")} value={new Date(plugin.updatedAt).toISOString()} />
            {plugin.lastUsedAt && (
              <MetaRow
                label={t("metaLastUsedAt")}
                value={new Date(plugin.lastUsedAt).toISOString()}
              />
            )}
            {manifest.dependencies && (
              <Card className="p-3 space-y-1">
                <div className="text-xs font-semibold">{t("dependencies")}</div>
                <div className="space-y-0.5">
                  {Object.entries(manifest.dependencies).map(([dep, version]) => (
                    <div key={dep} className="text-xs flex items-center justify-between">
                      <code className="font-mono">{dep}</code>
                      <span className="text-muted-foreground">{version}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            <PluginDependencyGraph
              manifest={{
                id: plugin.id,
                dependencies: manifest.dependencies,
              }}
            />
          </TabsContent>

          <TabsContent value="operations" className="mt-3 space-y-3">
            <div className="flex items-center justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRollbackTarget(plugin.id)}
                aria-label={t("rollbackAria", { name: plugin.name })}
              >
                <RotateCcwIcon className="mr-1.5 size-3.5" />
                {t("rollback")}
              </Button>
            </div>
            <PluginBackupPanel pluginId={plugin.id} />
            <PluginResourceManager pluginId={plugin.id} limits={RESOURCE_LIMITS} />
          </TabsContent>

          <TabsContent value="analytics" className="mt-3">
            <PluginAnalytics pluginId={plugin.id} />
          </TabsContent>
        </Tabs>
      </TabsContent>

      <TabsContent value="contributed" className="mt-3">
        <PluginContributedTab pluginId={plugin.id} />
      </TabsContent>

      <TabsContent value="data" className="mt-3">
        <PluginDataManagement pluginId={plugin.id} />
      </TabsContent>
    </Tabs>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-right break-all min-w-0">{value}</span>
    </div>
  )
}

function PermissionList({
  title,
  empty,
  permissions,
}: {
  title: string
  empty: string
  permissions: PluginPermission[]
}) {
  return (
    <Card className="p-3 space-y-2">
      <div className="text-xs font-semibold">{title}</div>
      {permissions.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {permissions.map((perm) => {
            const dangerous = DANGEROUS_PERMISSIONS.includes(perm)
            return (
              <li key={perm} className="flex items-start gap-2 text-xs">
                {dangerous && (
                  <AlertTriangleIcon className="size-3 text-destructive shrink-0 mt-0.5" />
                )}
                <code className="font-mono shrink-0">{perm}</code>
                <span className="text-muted-foreground">
                  — {PERMISSION_DESCRIPTIONS[perm] ?? perm}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

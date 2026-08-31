"use client"

// Per-plugin permission review dialog. Replaces the read-only PermissionsTab
// summary in the panel by giving the user a real grant / revoke surface,
// with `manifest declared` vs `runtime granted` columns and an audit log.
// Driven through the `usePluginPermissions` hook (no direct guard access).

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { AlertTriangleIcon, CheckCircle2Icon } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getPlugin } from "@/lib/db/plugins"
import type { PluginManifest, PluginPermission } from "@/types/plugin"
import type { PluginPermissionTier } from "@/lib/plugin/security/permission-guard"
import { usePluginPermissions } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { nodePermissionSupport } from "@/lib/plugin/launcher/launchPluginJs"
import { AuditLogEntry } from "./audit-log-entry"

export function PluginPermissionReview() {
  const target = usePluginsStore((s) => s.permissionReviewTarget)
  const close = usePluginsStore((s) => s.closePermissionReview)
  const open = target !== null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100%-2rem)] min-w-0 max-w-3xl flex-col sm:max-w-3xl">
        {target ? <PermissionReviewContent pluginId={target.pluginId} onClose={close} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function PermissionReviewContent({ pluginId, onClose }: { pluginId: string; onClose: () => void }) {
  const t = useTranslations("plugins.permissionReview")
  const plugin = useLiveQuery(() => getPlugin(pluginId), [pluginId])
  const perms = usePluginPermissions()

  const manifest = plugin?.manifest as PluginManifest | undefined
  const declared = useMemo(() => manifest?.permissions ?? [], [manifest])
  const optional = useMemo(() => manifest?.optionalPermissions ?? [], [manifest])
  const justifications = useMemo(() => manifest?.permissionJustifications ?? {}, [manifest])
  const granted = useMemo(() => new Set(perms.getGranted(pluginId)), [perms, pluginId])
  const allListed = useMemo(() => {
    const set = new Set<PluginPermission>([...declared, ...optional, ...granted])
    return Array.from(set).sort()
  }, [declared, optional, granted])
  const isNodeRuntime =
    Boolean(manifest?.engines?.node) || manifest?.runtimeCompatibility?.tauri?.entrypoint === "node"

  const auditLog = useMemo(
    () =>
      perms.auditLog
        .filter((entry) => entry.pluginId === pluginId)
        .slice(-25)
        .reverse(),
    [perms.auditLog, pluginId]
  )

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {plugin ? plugin.name : pluginId}{" "}
          <span className="text-muted-foreground text-sm font-normal">v{plugin?.version}</span>
        </DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      <Card className="p-0 flex-1 min-h-0 flex flex-col overflow-hidden">
        <ScrollArea className="flex-1 min-h-0">
          <Table className="table-fixed">
            <TableHeader className="hidden sm:table-header-group">
              <TableRow>
                <TableHead>{t("colPermission")}</TableHead>
                <TableHead className="w-20 text-center">{t("colGranted")}</TableHead>
                <TableHead className="w-40">{t("colTier")}</TableHead>
                <TableHead className="w-24 text-right">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allListed.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    {t("empty")}
                  </TableCell>
                </TableRow>
              ) : (
                allListed.map((perm) => {
                  const support = isNodeRuntime
                    ? nodePermissionSupport(perm)
                    : ({ available: true } as const)
                  const unavailableReason = support.available
                    ? undefined
                    : support.reason === "network-broker-missing"
                      ? t("nodeNetworkUnavailable")
                      : t("nodeSubprocessUnavailable")
                  return (
                    <PermissionRow
                      key={perm}
                      perm={perm}
                      declared={declared.includes(perm)}
                      optional={optional.includes(perm)}
                      granted={granted.has(perm)}
                      dangerous={perms.isDangerous(perm)}
                      onGrant={() => perms.grant(pluginId, perm, { grantedBy: "user" })}
                      onRevoke={() => perms.revoke(pluginId, perm)}
                      tier={perms.getTier(pluginId, perm)}
                      onTierChange={(tier) => perms.setTier(pluginId, perm, tier)}
                      description={justifications[perm] ?? perms.descriptions[perm] ?? perm}
                      runtimeAvailable={support.available}
                      unavailableReason={unavailableReason}
                    />
                  )
                })
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </Card>

      <div className="space-y-1">
        <h3 className="text-xs font-semibold">{t("auditLogTitle")}</h3>
        <Card className="p-0">
          <ScrollArea className="max-h-[20vh]">
            {auditLog.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">{t("auditEmpty")}</p>
            ) : (
              <ul className="divide-y">
                {auditLog.map((entry, idx) => (
                  <AuditLogEntry key={idx} entry={entry} />
                ))}
              </ul>
            )}
          </ScrollArea>
        </Card>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => perms.revokeAll(pluginId)}>
          {t("revokeAll")}
        </Button>
        <Button onClick={onClose}>{t("close")}</Button>
      </DialogFooter>
    </>
  )
}

export function PermissionRow({
  perm,
  declared,
  optional,
  granted,
  dangerous,
  description,
  onGrant,
  onRevoke,
  tier,
  onTierChange,
  runtimeAvailable = true,
  unavailableReason,
}: {
  perm: PluginPermission
  declared: boolean
  optional: boolean
  granted: boolean
  dangerous: boolean
  description: string
  onGrant: () => void
  onRevoke: () => void
  tier: PluginPermissionTier
  onTierChange: (tier: PluginPermissionTier) => void
  runtimeAvailable?: boolean
  unavailableReason?: string
}) {
  const t = useTranslations("plugins.permissionReview")
  return (
    <TableRow className="grid grid-cols-[minmax(0,1fr)_minmax(9rem,auto)] gap-x-3 gap-y-2 p-3 sm:table-row sm:p-0">
      <TableCell className="col-span-2 min-w-0 space-y-1 p-0 whitespace-normal sm:p-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <code className="break-all font-mono text-xs">{perm}</code>
          {dangerous && <AlertTriangleIcon className="size-3 text-destructive shrink-0" />}
        </div>
        <p className="break-words text-xs text-muted-foreground">{description}</p>
        {!runtimeAvailable && unavailableReason ? (
          <p className="break-words text-xs text-amber-600">{unavailableReason}</p>
        ) : null}
        {(declared || optional) && (
          <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
            {declared && (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2Icon className="size-3" aria-hidden="true" />
                {t("colDeclared")}
              </span>
            )}
            {optional && (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2Icon className="size-3" aria-hidden="true" />
                {t("colOptional")}
              </span>
            )}
          </div>
        )}
      </TableCell>
      <TableCell className="flex items-center gap-2 p-0 text-left sm:table-cell sm:w-20 sm:p-2 sm:text-center">
        <span className="text-xs text-muted-foreground sm:hidden">{t("colGranted")}</span>
        {granted && runtimeAvailable ? (
          <CheckCircle2Icon
            className="size-3.5 text-secondary-foreground sm:inline"
            aria-label={t("colGranted")}
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="min-w-0 p-0 whitespace-normal sm:w-40 sm:p-2">
        <span className="mb-1 block text-xs text-muted-foreground sm:hidden">{t("colTier")}</span>
        <Select
          value={tier}
          disabled={!runtimeAvailable}
          onValueChange={(v) => onTierChange(v as PluginPermissionTier)}
        >
          <SelectTrigger className="h-8 w-full min-w-0 text-xs" aria-label={t("colTier")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="silent">{t("tierLabel.silent")}</SelectItem>
            <SelectItem value="confirm">{t("tierLabel.confirm")}</SelectItem>
            <SelectItem value="forbid">{t("tierLabel.forbid")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1 hidden break-words text-[10px] leading-snug text-muted-foreground lg:block">
          {t(`tierHint.${tier}`)}
        </p>
      </TableCell>
      <TableCell className="col-span-2 p-0 text-right sm:table-cell sm:w-24 sm:p-2">
        {granted ? (
          <Button className="w-full sm:w-auto" size="sm" variant="ghost" onClick={onRevoke}>
            {t("revoke")}
          </Button>
        ) : (
          <Button
            className="w-full sm:w-auto"
            size="sm"
            variant="outline"
            disabled={!runtimeAvailable}
            onClick={onGrant}
          >
            {t("grant")}
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

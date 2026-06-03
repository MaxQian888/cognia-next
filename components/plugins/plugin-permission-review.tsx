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
import { AuditLogEntry } from "./audit-log-entry"

export function PluginPermissionReview() {
  const target = usePluginsStore((s) => s.permissionReviewTarget)
  const close = usePluginsStore((s) => s.closePermissionReview)
  const open = target !== null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="w-[95vw] max-w-2xl max-h-[85vh] flex flex-col">
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
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[8rem]">{t("colPermission")}</TableHead>
                  <TableHead className="hidden md:table-cell min-w-[6rem] text-center">
                    {t("colDeclared")}
                  </TableHead>
                  <TableHead className="hidden md:table-cell min-w-[6rem] text-center">
                    {t("colOptional")}
                  </TableHead>
                  <TableHead className="min-w-[5rem] text-center">{t("colGranted")}</TableHead>
                  <TableHead className="min-w-[9rem]">{t("colTier")}</TableHead>
                  <TableHead className="min-w-[6rem] text-right">{t("colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allListed.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      {t("empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  allListed.map((perm) => (
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
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
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
}) {
  const t = useTranslations("plugins.permissionReview")
  return (
    <TableRow>
      <TableCell className="space-y-0.5">
        <div className="flex items-center gap-1.5">
          <code className="font-mono text-xs">{perm}</code>
          {dangerous && <AlertTriangleIcon className="size-3 text-destructive shrink-0" />}
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </TableCell>
      <TableCell className="hidden md:table-cell text-center">
        {declared && <CheckCircle2Icon className="size-3.5 inline text-foreground/60" />}
      </TableCell>
      <TableCell className="hidden md:table-cell text-center">
        {optional && <CheckCircle2Icon className="size-3.5 inline text-foreground/60" />}
      </TableCell>
      <TableCell className="text-center">
        {granted && <CheckCircle2Icon className="size-3.5 inline text-secondary-foreground" />}
      </TableCell>
      <TableCell>
        <Select value={tier} onValueChange={(v) => onTierChange(v as PluginPermissionTier)}>
          <SelectTrigger className="h-7 text-xs" aria-label={t("colTier")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="silent">{t("tierLabel.silent")}</SelectItem>
            <SelectItem value="confirm">{t("tierLabel.confirm")}</SelectItem>
            <SelectItem value="forbid">{t("tierLabel.forbid")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground mt-0.5">{t(`tierHint.${tier}`)}</p>
      </TableCell>
      <TableCell className="text-right">
        {granted ? (
          <Button size="sm" variant="ghost" onClick={onRevoke}>
            {t("revoke")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onGrant}>
            {t("grant")}
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

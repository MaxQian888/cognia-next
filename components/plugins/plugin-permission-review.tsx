"use client"

// Per-plugin permission review dialog. Replaces the read-only PermissionsTab
// summary in the panel by giving the user a real grant / revoke surface,
// with `manifest declared` vs `runtime granted` state and an audit log.
// Driven through the `usePluginPermissions` hook (no direct guard access).
//
// Descriptions come from `usePermissionDescription` (localized), not the
// English-only `PERMISSION_DESCRIPTIONS` map. "Revoke all" asks first: it
// drops every grant at once, including the manifest-declared ones the plugin
// needs to run, and there is no undo.
//
// `PermissionList` / `PermissionRow` are shared with the detail pane's
// Permissions tab, so the two surfaces cannot drift. The list sizes itself
// against its own container (`@container` + `@xl:`), never the viewport: the
// pane is often 300–450px wide on a large screen, where a viewport breakpoint
// would pick the wide table and squeeze the permission ids mid-word. Below
// `@xl` each permission is a stacked list item (id + status, description,
// controls); from `@xl` up the rows line up under real column headers.
//
// `PermissionIdentity` (id + sensitive marker + description) is exported so
// the pre-install and import dialogs show a permission the same way this
// review does.

import { Fragment, useId, useMemo, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import { localizePluginText } from "@/hooks/plugins/use-localized-plugin-text"
import { useLiveQuery } from "dexie-react-hooks"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import { AlertTriangleIcon, CheckCircle2Icon } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getPlugin } from "@/lib/db/plugins"
import { cn } from "@/lib/utils"
import type { PluginManifest, PluginPermission } from "@/types/plugin"
import type { PluginPermissionTier } from "@/lib/plugin/security/permission-guard"
import { usePermissionDescription, usePluginPermissions } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import { nodePermissionSupport } from "@/lib/plugin/launcher/launchPluginJs"
import { AuditLogEntry } from "./audit-log-entry"

/**
 * Column template shared by the `@xl` header and every `@xl` row, so the
 * columns line up without a `<table>`: permission | status | tier | action.
 */
const WIDE_ROW_GRID = "@xl:grid-cols-[minmax(0,1fr)_6.5rem_11rem_6.5rem]"

/**
 * Every permission worth listing for a plugin: what the manifest declares,
 * what it may ask for later, and whatever is granted right now (a grant can
 * outlive a manifest edit). Sorted so the list order is stable.
 */
export function collectListedPermissions(
  manifest: Pick<PluginManifest, "permissions" | "optionalPermissions"> | undefined,
  granted: Iterable<PluginPermission>
): PluginPermission[] {
  const set = new Set<PluginPermission>([
    ...(manifest?.permissions ?? []),
    ...(manifest?.optionalPermissions ?? []),
    ...granted,
  ])
  return Array.from(set).sort()
}

export function PluginPermissionReview() {
  const target = usePluginsStore((s) => s.permissionReviewTarget)
  const close = usePluginsStore((s) => s.closePermissionReview)
  const open = target !== null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[85dvh] w-[calc(100%-2rem)] min-w-0 max-w-3xl flex-col sm:max-w-3xl">
        {target ? <PermissionReviewContent pluginId={target.pluginId} onClose={close} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function PermissionReviewContent({ pluginId, onClose }: { pluginId: string; onClose: () => void }) {
  const t = useTranslations("plugins.permissionReview")
  const plugin = useLiveQuery(() => getPlugin(pluginId), [pluginId])
  const locale = useLocale()
  const pluginName = plugin ? localizePluginText(plugin, locale).name || pluginId : pluginId
  const perms = usePluginPermissions()
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false)

  const manifest = plugin?.manifest as PluginManifest | undefined
  const granted = useMemo(() => new Set(perms.getGranted(pluginId)), [perms, pluginId])
  const allListed = useMemo(() => collectListedPermissions(manifest, granted), [manifest, granted])

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
          {pluginName}{" "}
          <span className="text-muted-foreground text-sm font-normal">v{plugin?.version}</span>
        </DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      {/* The dialog keeps its own frame: it is a modal with a fixed height, so
          the list scrolls inside it instead of pushing the footer away. */}
      <Card className="p-0 flex-1 min-h-0 flex flex-col overflow-hidden">
        <ScrollArea className="flex-1 min-h-0">
          {allListed.length === 0 ? (
            <p className="p-3 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <PermissionList
              pluginId={pluginId}
              manifest={manifest}
              permissions={allListed}
              granted={granted}
              inset
            />
          )}
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
        <Button
          variant="outline"
          onClick={() => setConfirmRevokeAll(true)}
          disabled={granted.size === 0}
        >
          {t("revokeAll")}
        </Button>
        <Button onClick={onClose}>{t("close")}</Button>
      </DialogFooter>

      <AlertDialog open={confirmRevokeAll} onOpenChange={setConfirmRevokeAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revokeAllConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("revokeAllConfirmBody", {
                name: pluginName,
                count: granted.size,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => perms.revokeAll(pluginId)}>
              {t("revokeAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * The grant / tier / revoke list for one plugin, shared by the review dialog
 * and the detail pane's Permissions tab. The caller decides which permissions
 * to list (see `collectListedPermissions`) and what to show when there are
 * none; this owns the per-row wiring so the two surfaces cannot drift.
 *
 * `inset` pads the rows horizontally, for a host that draws a frame around
 * the list (the dialog). The pane renders it flat, edge to edge.
 */
export function PermissionList({
  pluginId,
  manifest,
  permissions,
  granted,
  inset = false,
}: {
  pluginId: string
  manifest: PluginManifest | undefined
  permissions: PluginPermission[]
  granted: ReadonlySet<PluginPermission>
  inset?: boolean
}) {
  const t = useTranslations("plugins.permissionReview")
  const perms = usePluginPermissions()
  // Localized; `perms.descriptions` is the English-only source map.
  const describePermission = usePermissionDescription()
  const declared = manifest?.permissions ?? []
  const optional = manifest?.optionalPermissions ?? []
  const justifications = manifest?.permissionJustifications ?? {}
  const isNodeRuntime =
    Boolean(manifest?.engines?.node) || manifest?.runtimeCompatibility?.tauri?.entrypoint === "node"

  return (
    <div className="@container min-w-0" data-slot="permission-list">
      {/* Decorative: every control in a row carries its own label, so the
          header only aligns the eye on a wide container. */}
      <div
        aria-hidden="true"
        className={cn(
          "hidden gap-x-3 border-b pb-1.5 text-[11px] font-medium text-muted-foreground @xl:grid",
          WIDE_ROW_GRID,
          inset && "px-3 pt-2"
        )}
        data-slot="permission-list-header"
      >
        <span>{t("colPermission")}</span>
        <span>{t("colStatus")}</span>
        <span>{t("colTier")}</span>
        <span className="text-right">{t("colActions")}</span>
      </div>
      <ul className="divide-y" aria-label={t("listTitle")}>
        {permissions.map((perm) => {
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
              description={justifications[perm] ?? describePermission(perm)}
              runtimeAvailable={support.available}
              unavailableReason={unavailableReason}
              inset={inset}
            />
          )
        })}
      </ul>
    </div>
  )
}

/**
 * A permission id with break opportunities after its separators, so a narrow
 * column wraps `agent:control` as `agent:` / `control`, never `agent:con` /
 * `trol`. A single segment longer than the line still wraps (`break-words`)
 * rather than overflowing.
 */
export function PermissionIdText({ perm }: { perm: string }) {
  const parts = perm.split(/(?<=[:./_-])/)
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  )
}

/**
 * How one permission reads anywhere the user is asked about it: the id, a
 * labelled sensitive marker, and the localized description (or the plugin's
 * own justification, which is more specific when the author wrote one).
 *
 * `meta` rides on the id line (the manifest / optional markers in the review
 * list); `idTextId` lets the row's controls point back at the id with
 * `aria-describedby`, so "Grant" is announced with the permission it grants.
 */
export function PermissionIdentity({
  perm,
  dangerous,
  description,
  meta,
  idTextId,
}: {
  perm: string
  dangerous: boolean
  description: string
  meta?: ReactNode
  idTextId?: string
}) {
  const tPermissions = useTranslations("plugins.permissions")
  return (
    <div
      className={cn("min-w-0 space-y-1", dangerous && "border-l-2 border-destructive/70 pl-2")}
      data-dangerous={dangerous || undefined}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <code
          id={idTextId}
          className={cn("min-w-0 break-words font-mono text-xs", dangerous && "text-destructive")}
        >
          <PermissionIdText perm={perm} />
        </code>
        {dangerous && (
          <AlertTriangleIcon
            className="size-3 shrink-0 text-destructive"
            role="img"
            aria-label={tPermissions("dangerousAria")}
          />
        )}
        {meta}
      </div>
      {description && description !== perm ? (
        <p className="break-words text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
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
  inset = false,
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
  inset?: boolean
}) {
  const t = useTranslations("plugins.permissionReview")
  const idTextId = useId()
  const tierHintId = useId()
  // A grant the runtime cannot honour (a Node plugin without the broker) is
  // not effective, so it never reads as granted.
  const effective = granted && runtimeAvailable
  const meta =
    declared || optional ? (
      <span className="inline-flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
        {declared && <span>{t("colDeclared")}</span>}
        {optional && <span>{t("colOptional")}</span>}
      </span>
    ) : null

  return (
    <li
      className={cn(
        // Stacked: [identity | status] / [controls, right-aligned].
        "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 py-2.5",
        WIDE_ROW_GRID,
        "@xl:gap-y-0",
        inset && "px-3"
      )}
      data-slot="permission-row"
      data-permission={perm}
    >
      <div className="min-w-0 space-y-1">
        <PermissionIdentity
          perm={perm}
          dangerous={dangerous}
          description={description}
          meta={meta}
          idTextId={idTextId}
        />
        {!runtimeAvailable && unavailableReason ? (
          <p className="break-words text-xs text-amber-600 dark:text-amber-400">
            {unavailableReason}
          </p>
        ) : null}
      </div>

      <span
        className={cn(
          "inline-flex items-center gap-1 justify-self-end whitespace-nowrap pt-px text-xs @xl:justify-self-start",
          effective ? "text-foreground" : "text-muted-foreground"
        )}
        data-slot="permission-status"
      >
        {effective ? (
          <CheckCircle2Icon className="size-3.5 text-secondary-foreground" aria-hidden="true" />
        ) : null}
        {effective ? t("statusGranted") : t("statusNotGranted")}
      </span>

      {/* One flex line when stacked; `contents` at `@xl` hands the two
          children to the row grid's tier and action columns. */}
      <div className="col-span-2 flex flex-wrap items-center justify-end gap-2 @xl:contents">
        <div className="w-44 max-w-full min-w-0 @xl:w-full">
          <Select
            value={tier}
            disabled={!runtimeAvailable}
            onValueChange={(v) => onTierChange(v as PluginPermissionTier)}
          >
            <SelectTrigger
              className="h-8 w-full min-w-0 text-xs pointer-coarse:h-10"
              aria-label={t("colTier")}
              aria-describedby={`${idTextId} ${tierHintId}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="silent">{t("tierLabel.silent")}</SelectItem>
              <SelectItem value="confirm">{t("tierLabel.confirm")}</SelectItem>
              <SelectItem value="forbid">{t("tierLabel.forbid")}</SelectItem>
            </SelectContent>
          </Select>
          {/* Read by screen readers in every layout; shown under the select
              only where the tier column has room for it. */}
          <p
            id={tierHintId}
            className="sr-only @xl:not-sr-only @xl:mt-1 @xl:block @xl:break-words @xl:text-[10px] @xl:leading-snug @xl:text-muted-foreground"
          >
            {t(`tierHint.${tier}`)}
          </p>
        </div>
        <div className="@xl:text-right">
          {granted ? (
            <Button
              className="min-w-20 pointer-coarse:h-10"
              size="sm"
              variant="ghost"
              onClick={onRevoke}
              aria-describedby={idTextId}
            >
              {t("revoke")}
            </Button>
          ) : (
            <Button
              className="min-w-20 pointer-coarse:h-10"
              size="sm"
              variant="outline"
              disabled={!runtimeAvailable}
              onClick={onGrant}
              aria-describedby={idTextId}
            >
              {t("grant")}
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

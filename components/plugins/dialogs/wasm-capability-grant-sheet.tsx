"use client"

// WASM plugin capability grant sheet — shown the first time a `type: "wasm"`
// plugin is installed. Mirrors Zed's `granted_extension_capabilities` model:
// the user reviews the declared permissions, the author fingerprint, and
// any extra filesystem preopens *once*, then runtime calls are silent.
//
// Separate from `PluginPermissionReview` (which is the post-install audit
// surface) because the install-time UX is "grant or cancel" rather than
// "review and adjust".

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, FolderOpenIcon, KeyRoundIcon, ShieldCheckIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  DANGEROUS_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  WASM_UNIMPLEMENTED_PERMISSIONS,
} from "@/lib/plugin/security/permission-guard"
import { cn } from "@/lib/utils"
import type { PluginManifest, PluginPermission } from "@/types/plugin"

export interface WasmCapabilityGrantSheetProps {
  /** The manifest of the plugin about to be installed. Must be `type: "wasm"`. */
  manifest: PluginManifest
  /**
   * Public-key fingerprint reported by
   * `plugin_public_key_fingerprint` — pre-formatted by
   * `shortFingerprint()` to look like `ed25519:9f:3a:…`.
   * Pass an empty string for unsigned local-file installs.
   */
  authorFingerprint?: string
  /** Whether the sheet is open. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Called when the user confirms. Receives the permissions and extra
   * preopens the user granted. The caller persists them via
   * `usePluginPermissions().grant`.
   */
  onConfirm: (decision: WasmCapabilityGrantDecision) => void
  /** Called when the user cancels. */
  onCancel?: () => void
}

export interface WasmCapabilityGrantDecision {
  pluginId: string
  grantedPermissions: PluginPermission[]
  grantedPreopens: string[]
}

type GroupId =
  "filesystem" | "network" | "clipboard" | "notifications" | "osProcess" | "secrets" | "other"

interface GroupBucket {
  id: GroupId
  perms: PluginPermission[]
  dangerous: boolean
}

function groupPermissions(declared: PluginPermission[]): GroupBucket[] {
  const dangerSet = new Set<PluginPermission>(DANGEROUS_PERMISSIONS)
  const buckets: Record<GroupId, PluginPermission[]> = {
    filesystem: [],
    network: [],
    clipboard: [],
    notifications: [],
    osProcess: [],
    secrets: [],
    other: [],
  }
  for (const p of declared) {
    if (p.startsWith("filesystem:")) buckets.filesystem.push(p)
    else if (p.startsWith("network:")) buckets.network.push(p)
    else if (p.startsWith("clipboard:")) buckets.clipboard.push(p)
    else if (p === "notification") buckets.notifications.push(p)
    else if (p.startsWith("secrets:")) buckets.secrets.push(p)
    else if (
      p === "shell:execute" ||
      p === "process:spawn" ||
      p === "python:execute" ||
      p === "agent:control"
    )
      buckets.osProcess.push(p)
    else buckets.other.push(p)
  }
  const order: GroupId[] = [
    "filesystem",
    "network",
    "clipboard",
    "notifications",
    "osProcess",
    "secrets",
    "other",
  ]
  return order
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({
      id,
      perms: [...buckets[id]].sort(),
      dangerous: buckets[id].some((p) => dangerSet.has(p)),
    }))
}

/** Capabilities the WASM host stubs (typed `not-implemented`) — rendered disabled. */
const UNIMPLEMENTED = new Set<PluginPermission>(WASM_UNIMPLEMENTED_PERMISSIONS)

export function WasmCapabilityGrantSheet({
  manifest,
  authorFingerprint,
  open,
  onOpenChange,
  onConfirm,
  onCancel,
}: WasmCapabilityGrantSheetProps) {
  const t = useTranslations("plugins.wasmInstall.capabilityGrantSheet")
  const declared = useMemo(() => manifest.permissions ?? [], [manifest.permissions])
  const optional = useMemo(() => manifest.optionalPermissions ?? [], [manifest.optionalPermissions])
  const preopens = manifest.wasm?.fs?.preopens ?? []

  // Start with all "required" perms checked, all optional unchecked. Stubbed
  // (not-implemented) capabilities are never pre-granted — granting them would
  // imply a working capability that the WASM host actually refuses at runtime.
  const [granted, setGranted] = useState<Set<PluginPermission>>(
    () => new Set(declared.filter((p) => !UNIMPLEMENTED.has(p)))
  )
  const [grantedPreopens, setGrantedPreopens] = useState<Set<string>>(() => new Set(preopens))

  const groupsDeclared = useMemo(() => groupPermissions(declared), [declared])
  const groupsOptional = useMemo(() => groupPermissions(optional), [optional])

  const toggle = (perm: PluginPermission) => {
    // Stubbed capabilities can't be granted — the checkbox is disabled, but
    // guard here too so no code path re-adds them.
    if (UNIMPLEMENTED.has(perm)) return
    setGranted((prev) => {
      const next = new Set(prev)
      if (next.has(perm)) next.delete(perm)
      else next.add(perm)
      return next
    })
  }

  const togglePreopen = (path: string) => {
    setGrantedPreopens((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleConfirm = () => {
    onConfirm({
      pluginId: manifest.id,
      grantedPermissions: Array.from(granted).sort(),
      grantedPreopens: Array.from(grantedPreopens).sort(),
    })
  }

  const handleCancel = () => {
    onCancel?.()
    onOpenChange(false)
  }

  const dangerousCount = Array.from(granted).filter((p) => DANGEROUS_PERMISSIONS.includes(p)).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        data-testid="wasm-capability-grant-sheet"
        aria-describedby="wasm-grant-description"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-5 text-emerald-500" aria-hidden />
            {t("title", { name: manifest.name })}
          </DialogTitle>
          <DialogDescription id="wasm-grant-description">{t("description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-4">
          <div className="space-y-4">
            {/* Author identity */}
            <Card className="p-3 flex items-start gap-3">
              <KeyRoundIcon className="size-4 mt-0.5 text-muted-foreground" aria-hidden />
              <div className="text-sm space-y-0.5">
                <div className="font-medium">{manifest.author?.name ?? t("unsignedAuthor")}</div>
                <div className="font-mono text-xs text-muted-foreground break-all">
                  {authorFingerprint && authorFingerprint.length > 0
                    ? authorFingerprint
                    : t("noSignature")}
                </div>
              </div>
            </Card>

            {/* Required permissions */}
            {groupsDeclared.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noSensitivePermissions")}</p>
            ) : (
              <PermissionGroupList
                title={t("requestedPermissions")}
                groups={groupsDeclared}
                granted={granted}
                onToggle={toggle}
              />
            )}

            {/* Optional permissions */}
            {groupsOptional.length > 0 && (
              <>
                <Separator />
                <PermissionGroupList
                  title={t("optionalPermissions")}
                  groups={groupsOptional}
                  granted={granted}
                  onToggle={toggle}
                />
              </>
            )}

            {/* Filesystem preopens beyond the plugin data dir */}
            {preopens.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <FolderOpenIcon className="size-4 text-amber-500" aria-hidden />
                    {t("extraFilesystem")}
                  </div>
                  <p className="text-xs text-muted-foreground">{t("extraFilesystemDescription")}</p>
                  <ul className="space-y-1.5">
                    {preopens.map((path) => (
                      <li
                        key={path}
                        className="flex items-center gap-2 text-sm rounded-md border px-2 py-1.5"
                      >
                        <Checkbox
                          id={`preopen-${path}`}
                          checked={grantedPreopens.has(path)}
                          onCheckedChange={() => togglePreopen(path)}
                          aria-label={t("allowFsAriaLabel", { path })}
                        />
                        <label
                          htmlFor={`preopen-${path}`}
                          className="font-mono text-xs cursor-pointer break-all"
                        >
                          {path}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            {dangerousCount > 0 && (
              <Card className="border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20 p-3 flex items-start gap-2">
                <AlertTriangleIcon className="size-4 mt-0.5 text-amber-600" aria-hidden />
                <p className="text-xs">{t("dangerousWarning", { count: dangerousCount })}</p>
              </Card>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} data-testid="wasm-grant-cancel">
            {t("cancel")}
          </Button>
          <Button onClick={handleConfirm} data-testid="wasm-grant-confirm">
            {t("install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface PermissionGroupListProps {
  title: string
  groups: GroupBucket[]
  granted: Set<PluginPermission>
  onToggle: (perm: PluginPermission) => void
}

function PermissionGroupList({ title, groups, granted, onToggle }: PermissionGroupListProps) {
  const t = useTranslations("plugins.wasmInstall.capabilityGrantSheet")
  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">{title}</div>
      {groups.map((group) => (
        <div key={group.id} className="space-y-1.5">
          <div className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            {t(`groups.${group.id}`)}
            {group.dangerous && (
              <Badge variant="destructive" className="text-[10px] uppercase">
                {t("sensitiveBadge")}
              </Badge>
            )}
          </div>
          <ul className="space-y-1.5">
            {group.perms.map((perm) => {
              const unimplemented = UNIMPLEMENTED.has(perm)
              return (
                <li
                  key={perm}
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-2 py-1.5",
                    unimplemented
                      ? "border-dashed opacity-60"
                      : granted.has(perm)
                        ? "border-foreground/20"
                        : "border-dashed opacity-70"
                  )}
                >
                  <Checkbox
                    id={`perm-${perm}`}
                    checked={!unimplemented && granted.has(perm)}
                    disabled={unimplemented}
                    onCheckedChange={() => onToggle(perm)}
                    aria-label={t("togglePermissionAriaLabel", { permission: perm })}
                  />
                  <div className="text-sm">
                    <label
                      htmlFor={`perm-${perm}`}
                      className={cn(
                        "font-mono",
                        unimplemented ? "cursor-default" : "cursor-pointer"
                      )}
                    >
                      {perm}
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {PERMISSION_DESCRIPTIONS[perm] ?? t("customPermission")}
                    </p>
                    {unimplemented && (
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        {t("unimplementedHint")}
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

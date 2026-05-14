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

interface GroupBucket {
  label: string
  perms: PluginPermission[]
  dangerous: boolean
}

function groupPermissions(declared: PluginPermission[]): GroupBucket[] {
  const dangerSet = new Set<PluginPermission>(DANGEROUS_PERMISSIONS)
  const buckets: Record<string, PluginPermission[]> = {
    Filesystem: [],
    Network: [],
    Clipboard: [],
    Notifications: [],
    "OS / Process": [],
    Secrets: [],
    Other: [],
  }
  for (const p of declared) {
    if (p.startsWith("filesystem:")) buckets.Filesystem.push(p)
    else if (p.startsWith("network:")) buckets.Network.push(p)
    else if (p.startsWith("clipboard:")) buckets.Clipboard.push(p)
    else if (p === "notification") buckets.Notifications.push(p)
    else if (p.startsWith("secrets:")) buckets.Secrets.push(p)
    else if (
      p === "shell:execute" ||
      p === "process:spawn" ||
      p === "python:execute" ||
      p === "agent:control"
    )
      buckets["OS / Process"].push(p)
    else buckets.Other.push(p)
  }
  return Object.entries(buckets)
    .filter(([, perms]) => perms.length > 0)
    .map(([label, perms]) => ({
      label,
      perms: [...perms].sort(),
      dangerous: perms.some((p) => dangerSet.has(p)),
    }))
}

export function WasmCapabilityGrantSheet({
  manifest,
  authorFingerprint,
  open,
  onOpenChange,
  onConfirm,
  onCancel,
}: WasmCapabilityGrantSheetProps) {
  const declared = manifest.permissions ?? []
  const optional = manifest.optionalPermissions ?? []
  const preopens = manifest.wasm?.fs?.preopens ?? []

  // Start with all "required" perms checked, all optional unchecked.
  const [granted, setGranted] = useState<Set<PluginPermission>>(() => new Set(declared))
  const [grantedPreopens, setGrantedPreopens] = useState<Set<string>>(() => new Set(preopens))

  const groupsDeclared = useMemo(() => groupPermissions(declared), [declared])
  const groupsOptional = useMemo(() => groupPermissions(optional), [optional])

  const toggle = (perm: PluginPermission) => {
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
            Review permissions for {manifest.name}
          </DialogTitle>
          <DialogDescription id="wasm-grant-description">
            cognia will only let this WASM plugin do what you approve below. You can revoke any of
            these later in Settings → Plugins → Permissions.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-4">
          <div className="space-y-4">
            {/* Author identity */}
            <Card className="p-3 flex items-start gap-3">
              <KeyRoundIcon className="size-4 mt-0.5 text-muted-foreground" aria-hidden />
              <div className="text-sm space-y-0.5">
                <div className="font-medium">{manifest.author?.name ?? "Unsigned plugin"}</div>
                <div className="font-mono text-xs text-muted-foreground break-all">
                  {authorFingerprint && authorFingerprint.length > 0
                    ? authorFingerprint
                    : "no signature — sideloaded from local file"}
                </div>
              </div>
            </Card>

            {/* Required permissions */}
            {groupsDeclared.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This plugin does not request any sensitive permissions.
              </p>
            ) : (
              <PermissionGroupList
                title="Requested permissions"
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
                  title="Optional (off by default)"
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
                    Extra filesystem access
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The plugin already has read/write access to its own data dir. The paths below
                    are additional locations the author requests.
                  </p>
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
                          aria-label={`Allow filesystem access to ${path}`}
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
                <p className="text-xs">
                  You are granting {dangerousCount} sensitive capabilit
                  {dangerousCount === 1 ? "y" : "ies"}. Only do this if you trust the author.
                </p>
              </Card>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} data-testid="wasm-grant-cancel">
            Cancel
          </Button>
          <Button onClick={handleConfirm} data-testid="wasm-grant-confirm">
            Install with selected access
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
  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">{title}</div>
      {groups.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <div className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            {group.label}
            {group.dangerous && (
              <Badge variant="destructive" className="text-[10px] uppercase">
                sensitive
              </Badge>
            )}
          </div>
          <ul className="space-y-1.5">
            {group.perms.map((perm) => (
              <li
                key={perm}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-2 py-1.5",
                  granted.has(perm) ? "border-foreground/20" : "border-dashed opacity-70"
                )}
              >
                <Checkbox
                  id={`perm-${perm}`}
                  checked={granted.has(perm)}
                  onCheckedChange={() => onToggle(perm)}
                  aria-label={`Toggle ${perm}`}
                />
                <div className="text-sm">
                  <label htmlFor={`perm-${perm}`} className="font-mono cursor-pointer">
                    {perm}
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {PERMISSION_DESCRIPTIONS[perm] ?? "Custom permission"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

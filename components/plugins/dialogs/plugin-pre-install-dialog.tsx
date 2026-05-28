"use client"

// Sequential dialog that walks the user through Conflict → Permission →
// Configuration before the marketplace install actually writes anything.
//
// The dialog is controlled — the parent (marketplace card / detail sheet
// via `usePluginPreInstall`) owns the target + step state and drives
// transitions through callback props. This component only renders the
// active step and emits Continue/Cancel.
//
// Three step components are rendered conditionally based on `target.step`.
// When `target` is null the dialog stays closed.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  InfoIcon,
  TerminalIcon,
  ExternalLinkIcon,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DANGEROUS_PERMISSIONS } from "@/lib/plugin/security/permission-guard"
import type { PluginPermission } from "@/types/plugin"
import { openUrl } from "@/lib/native/opener"
import type {
  PreInstallConflict,
  PreInstallPermissionPayload,
  PreInstallConfigPayload,
  PreInstallBinaryPayload,
} from "@/lib/plugin/marketplace/install-flow"

export type PreInstallStepId = "conflict" | "permission" | "binaries" | "config"

export interface PreInstallTarget {
  pluginId: string
  pluginName: string
  step: PreInstallStepId
  /** Filled when `step === "conflict"`. */
  conflict?: PreInstallConflict
  /** Filled when `step === "permission"`. */
  permission?: PreInstallPermissionPayload
  /** Filled when `step === "binaries"`. */
  binaries?: PreInstallBinaryPayload
  /** Filled when `step === "config"`. */
  config?: PreInstallConfigPayload
  /** 1-based step counter for the badge — total steps for this run. */
  stepNumber: number
  totalSteps: number
}

interface Props {
  target: PreInstallTarget | null
  onContinue: (value?: unknown) => void
  onCancel: () => void
}

export function PluginPreInstallDialog({ target, onContinue, onCancel }: Props) {
  const t = useTranslations("plugins.preInstall")
  const open = target !== null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="w-[95vw] max-w-xl" data-testid="plugin-pre-install-dialog">
        {target && (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between gap-2">
                <DialogTitle>{t("title", { name: target.pluginName })}</DialogTitle>
                <Badge variant="outline" className="text-xs whitespace-nowrap">
                  {t("stepBadge", {
                    current: target.stepNumber,
                    total: target.totalSteps,
                  })}
                </Badge>
              </div>
              <DialogDescription>{t("description", { name: target.pluginName })}</DialogDescription>
            </DialogHeader>

            {target.step === "conflict" && target.conflict && (
              <ConflictStep
                conflict={target.conflict}
                onContinue={() => onContinue()}
                onCancel={onCancel}
              />
            )}
            {target.step === "permission" && target.permission && (
              <PermissionStep
                permission={target.permission}
                onContinue={() => onContinue()}
                onCancel={onCancel}
              />
            )}
            {target.step === "binaries" && target.binaries && (
              <BinariesStep
                binaries={target.binaries}
                onContinue={() => onContinue()}
                onCancel={onCancel}
              />
            )}
            {target.step === "config" && target.config && (
              <ConfigStep
                config={target.config}
                onContinue={(value) => onContinue(value)}
                onCancel={onCancel}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// Step 1 — Conflict
// =============================================================================

function ConflictStep({
  conflict,
  onContinue,
  onCancel,
}: {
  conflict: PreInstallConflict
  onContinue: () => void
  onCancel: () => void
}) {
  const t = useTranslations("plugins.preInstall")

  return (
    <>
      <p className="text-sm text-muted-foreground">{t("conflictHint")}</p>
      <Card className="p-0">
        <ScrollArea className="max-h-[40vh]">
          <ul className="divide-y" data-testid="pre-install-conflict-list">
            {conflict.reasons.map((reason, idx) => {
              // The orchestrator emits `alreadyInstalled:<version>` so the
              // UI can localize without duplicating the message text in TS.
              const installedPrefix = "alreadyInstalled:"
              const isInstalledNotice = reason.message.startsWith(installedPrefix)
              const display = isInstalledNotice
                ? t("conflictAlreadyInstalled", {
                    version: reason.message.slice(installedPrefix.length),
                  })
                : reason.message
              return (
                <li key={idx} className="flex items-start gap-2 px-3 py-2 text-sm">
                  {reason.severity === "high" ? (
                    <AlertTriangleIcon className="size-4 text-destructive mt-0.5 shrink-0" />
                  ) : reason.severity === "medium" ? (
                    <AlertCircleIcon className="size-4 text-orange-500 mt-0.5 shrink-0" />
                  ) : (
                    <InfoIcon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
                  )}
                  <span>{display}</span>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      </Card>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button onClick={onContinue} data-testid="pre-install-conflict-continue">
          {t("next")}
        </Button>
      </DialogFooter>
    </>
  )
}

// =============================================================================
// Step 2 — Permission
// =============================================================================

function PermissionStep({
  permission,
  onContinue,
  onCancel,
}: {
  permission: PreInstallPermissionPayload
  onContinue: () => void
  onCancel: () => void
}) {
  const t = useTranslations("plugins.preInstall")
  const hasAny = permission.declared.length > 0 || permission.optional.length > 0

  return (
    <>
      <p className="text-sm text-muted-foreground">{t("permissionsHint")}</p>
      {!hasAny ? (
        <p className="text-sm text-muted-foreground">{t("permissionsNone")}</p>
      ) : (
        <div className="space-y-3">
          {permission.declared.length > 0 && (
            <PermissionListCard title={t("permissionsDeclared")} perms={permission.declared} />
          )}
          {permission.optional.length > 0 && (
            <PermissionListCard title={t("permissionsOptional")} perms={permission.optional} />
          )}
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button onClick={onContinue} data-testid="pre-install-permission-continue">
          {t("next")}
        </Button>
      </DialogFooter>
    </>
  )
}

function PermissionListCard({ title, perms }: { title: string; perms: PluginPermission[] }) {
  return (
    <Card className="p-3 space-y-2">
      <div className="text-xs font-semibold">{title}</div>
      <ul className="space-y-1.5">
        {perms.map((perm) => {
          const dangerous = DANGEROUS_PERMISSIONS.includes(perm)
          return (
            <li key={perm} className="flex items-center gap-2 text-xs">
              {dangerous && <AlertTriangleIcon className="size-3 text-destructive shrink-0" />}
              <code className="font-mono">{perm}</code>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

// =============================================================================
// Step 2.5 — Binary requirements
// =============================================================================

function BinariesStep({
  binaries,
  onContinue,
  onCancel,
}: {
  binaries: PreInstallBinaryPayload
  onContinue: () => void
  onCancel: () => void
}) {
  const t = useTranslations("plugins.preInstall")
  return (
    <>
      <p className="text-sm text-muted-foreground">{t("binariesHint")}</p>
      <Card className="p-0">
        <ScrollArea className="max-h-[40vh]">
          <ul className="divide-y" data-testid="pre-install-binaries-list">
            {binaries.missing.map((bin) => (
              <li key={bin.name} className="flex items-start gap-2 px-3 py-2 text-sm">
                <TerminalIcon
                  className="size-4 text-muted-foreground mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <code className="font-mono">{bin.name}</code>
                    {bin.minVersion && (
                      <Badge variant="outline" className="text-[10px]">
                        ≥ {bin.minVersion}
                      </Badge>
                    )}
                  </div>
                  {bin.detectedVersion ? (
                    <p className="text-xs text-muted-foreground">
                      {t("binariesFoundOld", { version: bin.detectedVersion })}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("binariesNotFound")}</p>
                  )}
                  {bin.documentation && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => void openUrl(bin.documentation!)}
                    >
                      <ExternalLinkIcon className="mr-1 size-3" aria-hidden="true" />
                      {t("binariesDocs")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </Card>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} data-testid="pre-install-binaries-cancel">
          {t("cancel")}
        </Button>
        <Button onClick={onContinue} data-testid="pre-install-binaries-continue">
          {t("binariesRetry")}
        </Button>
      </DialogFooter>
    </>
  )
}

// =============================================================================
// Step 3 — Config
// =============================================================================

interface ParsedField {
  name: string
  type: "string" | "number" | "boolean"
  default: unknown
  description?: string
}

function parseConfigFields(schema: Record<string, unknown>): ParsedField[] {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const fields: ParsedField[] = []
  for (const [name, prop] of Object.entries(properties)) {
    const type = prop.type
    if (type !== "string" && type !== "number" && type !== "boolean") continue
    fields.push({
      name,
      type,
      default: prop.default,
      description: typeof prop.description === "string" ? prop.description : undefined,
    })
  }
  return fields
}

function ConfigStep({
  config,
  onContinue,
  onCancel,
}: {
  config: PreInstallConfigPayload
  onContinue: (value: unknown) => void
  onCancel: () => void
}) {
  const t = useTranslations("plugins.preInstall")
  const fields = useMemo(() => parseConfigFields(config.configSchema), [config.configSchema])
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {}
    for (const f of fields) {
      if (f.default !== undefined) init[f.name] = f.default
    }
    return init
  })

  const handleContinue = () => {
    onContinue({ ...values })
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">{t("configHint")}</p>
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("configNone")}</p>
      ) : (
        <div className="space-y-3" data-testid="pre-install-config-fields">
          {fields.map((field) => (
            <ConfigField
              key={field.name}
              field={field}
              value={values[field.name]}
              onChange={(v) => setValues((s) => ({ ...s, [field.name]: v }))}
            />
          ))}
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button onClick={handleContinue} data-testid="pre-install-config-confirm">
          {t("confirm")}
        </Button>
      </DialogFooter>
    </>
  )
}

function ConfigField({
  field,
  value,
  onChange,
}: {
  field: ParsedField
  value: unknown
  onChange: (v: unknown) => void
}) {
  if (field.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          <Label htmlFor={`pre-install-${field.name}`} className="text-xs">
            {field.name}
          </Label>
          {field.description && (
            <p className="text-xs text-muted-foreground">{field.description}</p>
          )}
        </div>
        <Switch id={`pre-install-${field.name}`} checked={!!value} onCheckedChange={onChange} />
      </div>
    )
  }
  if (field.type === "number") {
    return (
      <div className="space-y-1">
        <Label htmlFor={`pre-install-${field.name}`} className="text-xs">
          {field.name}
        </Label>
        <Input
          id={`pre-install-${field.name}`}
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    )
  }
  // string fallback
  return (
    <div className="space-y-1">
      <Label htmlFor={`pre-install-${field.name}`} className="text-xs">
        {field.name}
      </Label>
      <Input
        id={`pre-install-${field.name}`}
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
      />
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
    </div>
  )
}

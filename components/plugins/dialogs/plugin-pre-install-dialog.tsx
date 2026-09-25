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
//
// Layout: the dialog is capped at 85dvh and is a flex column. The header and
// each step's footer stay put, and the step body between them is the one
// scroller, so a long permission list never pushes Continue off a phone
// screen. Permissions read the same as in the review dialog
// (`PermissionIdentity`: id, labelled sensitive marker, localized
// description), and the configuration step uses the real config-form renderer
// instead of a second parser that only understood string / number / boolean.

import type { ReactNode } from "react"
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
import { usePermissionDescription } from "@/hooks/plugins/use-permission-description"
import { DANGEROUS_PERMISSIONS } from "@/lib/plugin/security/permission-guard"
import type { PluginPermission } from "@/types/plugin"
import { openUrl } from "@/lib/native/opener"
import type {
  PreInstallConflict,
  PreInstallPermissionPayload,
  PreInstallConfigPayload,
  PreInstallBinaryPayload,
} from "@/lib/plugin/marketplace/install-flow"
import { ConfigSchemaFields, useConfigSchemaForm } from "../detail/plugin-config-form"
import { PermissionIdentity } from "../plugin-permission-review"

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
  /**
   * Extra context shown on the permission step, above the permission list.
   *
   * Exists for the Open VSX path: a VS Code extension is an ordinary Node
   * program with real filesystem / network / process access, and the permission
   * list alone reads like a sandbox manifest — which would imply a confinement
   * we do not provide. Optional and absent by default, so the cognia-registry
   * chain renders exactly as before.
   */
  notice?: string
  onContinue: (value?: unknown) => void
  onCancel: () => void
}

export function PluginPreInstallDialog({ target, notice, onContinue, onCancel }: Props) {
  const t = useTranslations("plugins.preInstall")
  const open = target !== null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="flex max-h-[85dvh] w-[95vw] max-w-xl min-w-0 flex-col"
        data-testid="plugin-pre-install-dialog"
      >
        {target && (
          <>
            <DialogHeader className="shrink-0">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <DialogTitle className="min-w-0 break-words">
                  {t("title", { name: target.pluginName })}
                </DialogTitle>
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
                notice={notice}
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

/**
 * The scroll region between the pinned header and a step's pinned footer.
 * `-mx-1 px-1` keeps focus rings on the edge controls from being clipped.
 */
function StepBody({ children }: { children: ReactNode }) {
  return (
    <div
      className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1"
      data-testid="pre-install-step-body"
    >
      {children}
    </div>
  )
}

function StepFooter({ children }: { children: ReactNode }) {
  return <DialogFooter className="shrink-0">{children}</DialogFooter>
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
      <StepBody>
        <p className="text-sm text-muted-foreground">{t("conflictHint")}</p>
        <Card className="p-0">
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
                    <AlertTriangleIcon
                      className="size-4 text-destructive mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : reason.severity === "medium" ? (
                    <AlertCircleIcon
                      className="size-4 text-orange-500 mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <InfoIcon
                      className="size-4 text-muted-foreground mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 break-words">{display}</span>
                </li>
              )
            })}
          </ul>
        </Card>
      </StepBody>
      <StepFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button onClick={onContinue} data-testid="pre-install-conflict-continue">
          {t("next")}
        </Button>
      </StepFooter>
    </>
  )
}

// =============================================================================
// Step 2 — Permission
// =============================================================================

function PermissionStep({
  permission,
  notice,
  onContinue,
  onCancel,
}: {
  permission: PreInstallPermissionPayload
  notice?: string
  onContinue: () => void
  onCancel: () => void
}) {
  const t = useTranslations("plugins.preInstall")
  const hasAny = permission.declared.length > 0 || permission.optional.length > 0
  const domains = permission.networkAccess?.allowedDomains
  const anyHost = domains?.some((d) => d.trim() === "*")

  return (
    <>
      <StepBody>
        <p className="text-sm text-muted-foreground">{t("permissionsHint")}</p>
        {notice && (
          <Card
            className="flex flex-row items-start gap-2 p-3"
            data-testid="pre-install-permission-notice"
          >
            <AlertTriangleIcon
              className="mt-0.5 size-4 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <p className="min-w-0 break-words text-xs text-muted-foreground">{notice}</p>
          </Card>
        )}
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
            {domains && domains.length > 0 && (
              <Card className="p-3 space-y-2" data-testid="pre-install-network-access">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  {anyHost && (
                    <AlertTriangleIcon
                      className="size-3 text-destructive shrink-0"
                      role="img"
                      aria-label={t("networkAnyHost")}
                    />
                  )}
                  {t("networkAccessTitle")}
                </div>
                <ul className="space-y-1 text-xs">
                  {domains.map((d) => (
                    <li key={d} className="min-w-0">
                      <code className="break-all font-mono">
                        {anyHost && d.trim() === "*" ? t("networkAnyHost") : d}
                      </code>
                    </li>
                  ))}
                </ul>
                {permission.networkAccess?.reasoning && (
                  <p className="break-words text-xs text-muted-foreground">
                    {permission.networkAccess.reasoning}
                  </p>
                )}
              </Card>
            )}
          </div>
        )}
      </StepBody>
      <StepFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button onClick={onContinue} data-testid="pre-install-permission-continue">
          {t("next")}
        </Button>
      </StepFooter>
    </>
  )
}

/**
 * Exported so the import dialog can show the same permission read-out. Import
 * only stages a `discovered` row rather than running the marketplace install
 * chain, so it can't reuse the whole `PermissionStep` — but "here is what this
 * plugin declares, with the dangerous ones flagged" must look identical
 * wherever the user is asked to accept a manifest.
 */
export function PermissionListCard({
  title,
  perms,
  justifications,
}: {
  title: string
  perms: PluginPermission[]
  /** Manifest `permissionJustifications`: the author's own reason, when given. */
  justifications?: Partial<Record<string, string>>
}) {
  const describePermission = usePermissionDescription()
  return (
    <Card className="p-3 space-y-2">
      <div className="text-xs font-semibold">{title}</div>
      <ul className="space-y-2">
        {perms.map((perm) => (
          <li key={perm} className="min-w-0 text-xs">
            <PermissionIdentity
              perm={perm}
              dangerous={DANGEROUS_PERMISSIONS.includes(perm)}
              description={justifications?.[perm] ?? describePermission(perm)}
            />
          </li>
        ))}
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
      <StepBody>
        <p className="text-sm text-muted-foreground">{t("binariesHint")}</p>
        <Card className="p-0">
          <ul className="divide-y" data-testid="pre-install-binaries-list">
            {binaries.missing.map((bin) => (
              <li key={bin.name} className="flex items-start gap-2 px-3 py-2 text-sm">
                <TerminalIcon
                  className="size-4 text-muted-foreground mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <code className="break-all font-mono">{bin.name}</code>
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
        </Card>
      </StepBody>
      <StepFooter>
        <Button variant="outline" onClick={onCancel} data-testid="pre-install-binaries-cancel">
          {t("cancel")}
        </Button>
        <Button onClick={onContinue} data-testid="pre-install-binaries-continue">
          {t("binariesRetry")}
        </Button>
      </StepFooter>
    </>
  )
}

// =============================================================================
// Step 3 — Config
// =============================================================================

/**
 * The plugin's settings, rendered by the same field renderer the detail
 * pane's Configure section uses: nested objects, arrays, enums, secrets and
 * the schema's validation rules all behave the same before install as after.
 * Confirm is held while a field is invalid, exactly like Save is there.
 */
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
  const form = useConfigSchemaForm(config.configSchema, undefined)
  const hasFields = !form.schema.unknown && Object.keys(form.schema.fields).length > 0

  return (
    <>
      <StepBody>
        <p className="text-sm text-muted-foreground">{t("configHint")}</p>
        {!hasFields ? (
          <p className="text-sm text-muted-foreground">{t("configNone")}</p>
        ) : (
          <div data-testid="pre-install-config-fields">
            <ConfigSchemaFields
              fields={form.schema.fields}
              values={form.values}
              errors={form.errors}
              onChange={form.setField}
              idPrefix="pre-install-config"
            />
          </div>
        )}
      </StepBody>
      <StepFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button
          onClick={() => onContinue({ ...form.values })}
          disabled={form.hasErrors}
          data-testid="pre-install-config-confirm"
        >
          {t("confirm")}
        </Button>
      </StepFooter>
    </>
  )
}

"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ShieldAlertIcon, ShieldCheckIcon, ShieldQuestionIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { PermissionListCard } from "@/components/plugins/dialogs/plugin-pre-install-dialog"
import { useWasmCapabilityGrant } from "@/hooks/plugins/use-wasm-capability-grant"
import { packageFormatErrorCode, type PackageFormatErrorCode } from "@/lib/packaging/archive-path"
import {
  applyCogpackImport,
  planCogpackImport,
  type CogpackImportPlan,
  type CogpackImportProgress,
  type CogpackImportResult,
} from "@/lib/plugin/cogpack/import"
import type { PluginManifest } from "@/types/plugin"

export interface CogpackImportFile {
  name: string
  bytes: Uint8Array
}

export interface CogpackImportDialogProps {
  file: CogpackImportFile | null
  onOpenChange: (open: boolean) => void
  pluginName: (pluginId: string) => string
  /** Offer "Switch to it now" once the cogset exists. */
  onSwitch: (cogsetId: string) => void
}

type Stage =
  | { kind: "planning" }
  | { kind: "review"; plan: CogpackImportPlan }
  | { kind: "installing"; plan: CogpackImportPlan; progress: CogpackImportProgress }
  | { kind: "result"; plan: CogpackImportPlan; result: CogpackImportResult }
  | { kind: "error"; fileName: string; code: PackageFormatErrorCode | "unknown"; message: string }

function TrustBanner({ plan }: { plan: CogpackImportPlan }) {
  const t = useTranslations("plugins.cogpacks.import")
  const { trust, refusedBy, fingerprint } = plan.trust
  const signature = plan.inspected.manifest.signature
  const Icon =
    trust === "trusted"
      ? ShieldCheckIcon
      : trust === "signed-unknown"
        ? ShieldQuestionIcon
        : ShieldAlertIcon
  return (
    <Alert
      variant={trust === "trusted" && !refusedBy ? "default" : "destructive"}
      data-trust={trust}
    >
      <Icon className="size-4" />
      <AlertTitle>{t(`trust.${trust}`)}</AlertTitle>
      <AlertDescription>
        {signature && fingerprint && (
          <span className="block break-all">
            {t("signer", { name: signature.publisher, fingerprint: fingerprint.slice(0, 16) })}
          </span>
        )}
        {refusedBy && <span className="block">{t(`refused.${refusedBy}`)}</span>}
      </AlertDescription>
    </Alert>
  )
}

/**
 * Import a `.cogpack` (ADR-0209): one review of everything that will change,
 * then the installs, then — for git WASM members, which cannot be previewed —
 * their capability review, and the offer to switch.
 */
export function CogpackImportDialog({
  file,
  onOpenChange,
  pluginName,
  onSwitch,
}: CogpackImportDialogProps) {
  const t = useTranslations("plugins.cogpacks.import")
  const grant = useWasmCapabilityGrant()
  const [stage, setStage] = useState<Stage>({ kind: "planning" })
  const [install, setInstall] = useState<Set<string>>(new Set())
  const [secrets, setSecrets] = useState<Record<string, Record<string, string>>>({})
  const [trustSigner, setTrustSigner] = useState(false)
  const [mode, setMode] = useState<"new" | "update">("new")
  const [useNext, setUseNext] = useState<Set<string>>(new Set())
  // A new file restarts the review; reset during render so no stale plan paints.
  const [plannedFile, setPlannedFile] = useState(file)
  if (plannedFile !== file) {
    setPlannedFile(file)
    setStage({ kind: "planning" })
  }

  useEffect(() => {
    if (!file) return
    let cancelled = false
    void planCogpackImport(file.bytes)
      .then((plan) => {
        if (cancelled) return
        setInstall(new Set(plan.members.filter((m) => m.installByDefault).map((m) => m.member.id)))
        setSecrets({})
        setTrustSigner(false)
        setMode(plan.update ? "update" : "new")
        setUseNext(new Set())
        setStage({ kind: "review", plan })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStage({
            kind: "error",
            fileName: file.name,
            code: packageFormatErrorCode(error) ?? "unknown",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [file])

  const plan =
    stage.kind === "review" || stage.kind === "installing" || stage.kind === "result"
      ? stage.plan
      : null
  const manifest = plan?.inspected.manifest
  const names = useMemo(
    () => (ids: readonly string[]) => ids.map(pluginName).join(", "),
    [pluginName]
  )

  const submit = async () => {
    if (stage.kind !== "review") return
    const current = stage.plan
    setStage({ kind: "installing", plan: current, progress: { done: 0, total: install.size } })
    try {
      const result = await applyCogpackImport(
        current,
        { install, secrets, trustSigner, mode, useNext },
        { onProgress: (progress) => setStage({ kind: "installing", plan: current, progress }) }
      )
      // Git WASM members could not be previewed; review their capabilities now.
      for (const pending of result.grantsToReview) {
        if ((pending.manifest as PluginManifest).type !== "wasm") continue
        await grant.requestGrant({
          manifest: pending.manifest,
          authorFingerprint: pending.authorFingerprint,
        })
      }
      const name = current.inspected.manifest.name
      if (result.missing.length > 0)
        toast.warning(t("doneWithMissing", { name, count: result.missing.length }))
      else toast.success(t("done", { name }))
      setStage({ kind: "result", plan: current, result })
    } catch (error) {
      toast.error(t("failed"), {
        description: error instanceof Error ? error.message : String(error),
      })
      setStage({ kind: "review", plan: current })
    }
  }

  const toggle = (setter: typeof setInstall, id: string, on: boolean) =>
    setter((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <>
      <Dialog
        open={file !== null}
        onOpenChange={(open) => stage.kind !== "installing" && onOpenChange(open)}
      >
        <DialogContent
          className="flex max-h-[85dvh] w-[95vw] max-w-2xl flex-col"
          data-testid="cogpack-import"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {stage.kind === "result" && manifest
                ? t("resultTitle", { name: manifest.name })
                : t("title")}
            </DialogTitle>
            {manifest && (
              <DialogDescription className="break-words">
                {manifest.name} {manifest.version}
                {manifest.description ? ` — ${manifest.description}` : ""}
              </DialogDescription>
            )}
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-1">
            {stage.kind === "planning" && (
              <p className="text-sm text-muted-foreground">{t("reading")}</p>
            )}
            {stage.kind === "error" && (
              <div className="space-y-1 text-sm" role="alert">
                <p className="font-medium break-words text-destructive">
                  {t("openFailed", { file: stage.fileName })}
                </p>
                <p className="break-words">{t(`invalid.${stage.code}`)}</p>
                <p className="text-xs break-words text-muted-foreground">{stage.message}</p>
              </div>
            )}

            {stage.kind === "installing" && (
              <div className="space-y-2">
                <p className="text-sm">
                  {t("installing", { done: stage.progress.done, total: stage.progress.total })}
                </p>
                <Progress
                  value={
                    stage.progress.total > 0
                      ? (stage.progress.done / stage.progress.total) * 100
                      : 0
                  }
                  aria-label={t("installing", {
                    done: stage.progress.done,
                    total: stage.progress.total,
                  })}
                />
              </div>
            )}

            {stage.kind === "result" && stage.result.missing.length > 0 && (
              <div className="space-y-1.5" data-testid="cogpack-import-missing">
                <h3 className="text-sm font-medium">{t("resultMissing")}</h3>
                <ul className="divide-y rounded-md border text-sm">
                  {stage.result.missing.map((entry) => (
                    <li
                      key={entry.pluginId}
                      className="flex flex-wrap justify-between gap-2 px-3 py-1.5"
                    >
                      <span className="break-words">{pluginName(entry.pluginId)}</span>
                      <span className="text-xs text-muted-foreground">
                        {t(`reason.${entry.reason}`)}
                      </span>
                    </li>
                  ))}
                </ul>
                {stage.result.failed.map((entry) => (
                  <p key={entry.pluginId} className="text-xs break-words text-muted-foreground">
                    {pluginName(entry.pluginId)}: {entry.message}
                  </p>
                ))}
              </div>
            )}

            {stage.kind === "review" && plan && manifest && (
              <>
                <TrustBanner plan={plan} />
                {plan.trust.trust === "signed-unknown" && !plan.trust.refusedBy && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={trustSigner}
                      onCheckedChange={(checked) => setTrustSigner(checked === true)}
                    />
                    {t("trustSigner")}
                  </label>
                )}
                {!plan.compatibility.satisfied && (
                  <p className="text-sm text-destructive" role="alert">
                    {t("compatibility", {
                      required: plan.compatibility.minHostVersion,
                      current: plan.compatibility.hostVersion,
                    })}
                  </p>
                )}

                {plan.update && (
                  <div
                    className="space-y-2 rounded-md border p-3"
                    data-testid="cogpack-import-update"
                  >
                    <h3 className="text-sm font-medium">
                      {t("updateTitle", { name: manifest.name })}
                    </h3>
                    <RadioGroup
                      value={mode}
                      onValueChange={(value) => setMode(value as "new" | "update")}
                    >
                      <label className="flex items-center gap-2 text-sm">
                        <RadioGroupItem value="update" />
                        {t("updateExisting", { cogset: plan.update.cogset.name })}
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <RadioGroupItem value="new" />
                        {t("importNew")}
                      </label>
                    </RadioGroup>
                    {mode === "update" && (
                      <ul className="divide-y rounded-md border text-sm">
                        {plan.update.entries
                          .filter((entry) => entry.change !== "unchanged")
                          .map((entry) => (
                            <li
                              key={entry.pluginId}
                              className="flex flex-wrap items-center gap-2 px-3 py-1.5"
                            >
                              <span className="min-w-0 flex-1 break-words">
                                {pluginName(entry.pluginId)}
                              </span>
                              <Badge variant="outline">
                                {t(`change.${entry.change}`, {
                                  from: entry.previous?.version ?? "",
                                  to: entry.next?.version ?? "",
                                })}
                              </Badge>
                              {entry.localEdited && entry.change !== "local-only" && (
                                <label className="flex items-center gap-1.5 text-xs">
                                  <Checkbox
                                    checked={useNext.has(entry.pluginId)}
                                    onCheckedChange={(checked) =>
                                      toggle(setUseNext, entry.pluginId, checked === true)
                                    }
                                  />
                                  {t("useNext")}
                                  <span className="text-muted-foreground">
                                    ({t("localEdited")})
                                  </span>
                                </label>
                              )}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <h3 className="text-sm font-medium">{t("members")}</h3>
                  <ul className="space-y-2">
                    {plan.members.map((item) => {
                      const id = item.member.id
                      const installId = `cogpack-install-${id}`
                      const canInstall =
                        item.installByDefault ||
                        (item.status === "different-version" && !!item.install)
                      return (
                        <li
                          key={id}
                          className="space-y-2 rounded-md border p-3 text-sm"
                          data-testid={`cogpack-import-member-${id}`}
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium break-words">{item.member.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {item.member.version}
                            </span>
                            {item.member.optional && (
                              <Badge variant="outline">{t("optional")}</Badge>
                            )}
                            <Badge
                              variant={item.status === "unavailable" ? "destructive" : "secondary"}
                            >
                              {t(`status.${item.status}`, {
                                installed: item.installedVersion ?? "",
                                version: item.member.version,
                              })}
                            </Badge>
                          </div>
                          {item.unavailable && (
                            <p className="text-xs text-muted-foreground">
                              {t(`unavailable.${item.unavailable.reason}`)}
                              {item.unavailable.detail ? ` (${item.unavailable.detail})` : ""}
                            </p>
                          )}
                          {canInstall && (
                            <label
                              htmlFor={installId}
                              className="flex items-center gap-1.5 text-xs"
                            >
                              <Checkbox
                                id={installId}
                                checked={install.has(id)}
                                onCheckedChange={(checked) =>
                                  toggle(setInstall, id, checked === true)
                                }
                              />
                              {t("installPinned", { version: item.member.version })}
                            </label>
                          )}
                          {install.has(id) &&
                            (item.permissions.length > 0 ||
                              item.optionalPermissions.length > 0) && (
                              <PermissionListCard
                                title={t("permissions", { name: item.member.name })}
                                perms={[...item.permissions, ...item.optionalPermissions]}
                              />
                            )}
                          {install.has(id) && item.reviewAfterInstall && (
                            <p className="text-xs text-muted-foreground">
                              {t("reviewAfterInstall")}
                            </p>
                          )}
                          {install.has(id) && item.missingBinaries.length > 0 && (
                            <p className="text-xs text-destructive">
                              {t("missingBinaries", {
                                names: item.missingBinaries.map((b) => b.name).join(", "),
                              })}
                            </p>
                          )}
                          {install.has(id) && item.conflicts.length > 0 && (
                            <div className="text-xs">
                              <p className="font-medium">{t("conflicts")}</p>
                              <ul className="list-disc pl-4 text-muted-foreground">
                                {item.conflicts.map((conflict) => (
                                  <li key={conflict.message} className="break-words">
                                    {conflict.message}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {item.secretFields.length > 0 && item.status !== "unavailable" && (
                            <fieldset className="space-y-1.5">
                              <legend className="text-xs font-medium">
                                {t("secrets", { name: item.member.name })}
                              </legend>
                              {item.secretFields.map((field) => {
                                const inputId = `cogpack-secret-${id}-${field}`
                                return (
                                  <div key={field} className="space-y-1">
                                    <Label htmlFor={inputId} className="text-xs">
                                      {field}
                                    </Label>
                                    <Input
                                      id={inputId}
                                      type="password"
                                      autoComplete="off"
                                      placeholder={t("secretPlaceholder")}
                                      value={secrets[id]?.[field] ?? ""}
                                      onChange={(event) =>
                                        setSecrets((current) => ({
                                          ...current,
                                          [id]: { ...current[id], [field]: event.target.value },
                                        }))
                                      }
                                    />
                                  </div>
                                )
                              })}
                            </fieldset>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>

                {plan.missingDependencies.length > 0 && (
                  <div className="space-y-1 text-sm" data-testid="cogpack-import-dependencies">
                    <h3 className="font-medium">{t("missingDependencies")}</h3>
                    <ul className="list-disc pl-5 text-xs text-muted-foreground">
                      {plan.missingDependencies.map((dependency) => (
                        <li key={`${dependency.pluginId}:${dependency.dependencyId}`}>
                          {dependency.installedVersion
                            ? t("dependencyVersion", {
                                plugin: pluginName(dependency.pluginId),
                                dependency: dependency.dependencyId,
                                constraint: dependency.constraint,
                                installed: dependency.installedVersion,
                              })
                            : t("dependency", {
                                plugin: pluginName(dependency.pluginId),
                                dependency: dependency.dependencyId,
                                constraint: dependency.constraint,
                              })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {plan.disabledOnActivation.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("disabledOnActivation", { names: names(plan.disabledOnActivation) })}
                  </p>
                )}
              </>
            )}
          </div>

          <DialogFooter className="shrink-0">
            {stage.kind === "result" ? (
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {t("close")}
                </Button>
                <Button
                  data-testid="cogpack-import-switch"
                  onClick={() => {
                    onSwitch(stage.result.cogsetId)
                    onOpenChange(false)
                  }}
                >
                  {t("switchNow")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={stage.kind === "installing"}
                >
                  {t("cancel")}
                </Button>
                <Button
                  onClick={() => void submit()}
                  disabled={stage.kind !== "review" || !!stage.plan.trust.refusedBy}
                  data-testid="cogpack-import-submit"
                >
                  {t("submit")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {grant.sheet}
    </>
  )
}

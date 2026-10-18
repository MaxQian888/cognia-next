"use client"

/**
 * Add or edit one remote desktop binding. The order is the security order:
 * name the server, let this desktop resolve and classify the address, confirm
 * reaching it (LAN, or plaintext over the internet), test it (protocol and
 * security types), then store passwords. A password is write-only: an edit
 * shows whether one is stored and offers keep, replace or remove.
 */

import { useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type {
  SaveTargetInput,
  SaveTargetResult,
} from "@/hooks/remote-desktop/use-remote-desktop-targets"
import {
  endpointChanged,
  formOf,
  savedBindingOf,
  targetDraftOf,
  type CredentialChange,
  type RemoteDesktopForm,
} from "@/lib/remote-desktop/drafts"
import { remoteDesktopErrorMessage } from "@/lib/remote-desktop/error-messages"
import { probeRemoteDesktop, toRemoteDesktopError } from "@/lib/remote-desktop/host-client"
import type { RemoteDesktopProviderRegistration } from "@/lib/remote-desktop/provider-registry"
import type {
  RemoteDesktopHostRef,
  RemoteDesktopProbeOutcome,
  RemoteDesktopTarget,
} from "@/lib/remote-desktop/types"

export type DialogState =
  { kind: "add" } | { kind: "edit"; target: RemoteDesktopTarget; bindingId?: string }

export interface RemoteDesktopTargetDialogProps {
  state: DialogState
  /** The Host that saves the target and reaches its address. */
  host: RemoteDesktopHostRef
  hostLabel?: string
  providers: readonly RemoteDesktopProviderRegistration[]
  onClose: () => void
  onSave: (input: SaveTargetInput) => Promise<SaveTargetResult>
  probe?: typeof probeRemoteDesktop
}

type Check =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "resolved"; outcome: RemoteDesktopProbeOutcome }
  | { status: "tested"; outcome: RemoteDesktopProbeOutcome }
  | { status: "error"; message: string }

interface PasswordField {
  value: string
  cleared: boolean
}

const EMPTY_PASSWORD: PasswordField = { value: "", cleared: false }

function changeOf(field: PasswordField): CredentialChange {
  if (field.value) return field.value
  return field.cleared ? null : undefined
}

export function RemoteDesktopTargetDialog({
  state,
  host,
  hostLabel,
  providers,
  onClose,
  onSave,
  probe = probeRemoteDesktop,
}: RemoteDesktopTargetDialogProps) {
  const t = useTranslations("remoteDesktop")
  const existing = state.kind === "edit" ? state.target : undefined
  const binding = existing?.bindings.find(
    (entry) => entry.id === (state.kind === "edit" ? state.bindingId : undefined)
  )
  const firstProvider = providers[0]
  const [form, setForm] = useState<RemoteDesktopForm>(() =>
    existing && binding
      ? formOf(existing, binding)
      : {
          name: "",
          providerId: firstProvider?.providerId ?? "",
          adapter: firstProvider?.definition.adapter ?? "vnc",
          host: "",
          port: firstProvider?.definition.defaultPort ?? 5900,
          viewOnly: false,
          enabled: true,
          confirm: false,
        }
  )
  const [check, setCheck] = useState<Check>({ status: "idle" })
  const [control, setControl] = useState<PasswordField>(EMPTY_PASSWORD)
  const [view, setView] = useState<PasswordField>(EMPTY_PASSWORD)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const provider = providers.find((entry) => entry.providerId === form.providerId)
  const changed = endpointChanged(binding, form)
  const outcome =
    check.status === "resolved" || check.status === "tested" ? check.outcome : undefined
  const readOnlyOffered =
    form.adapter === "vnc" &&
    (provider?.definition.capabilities.viewOnlyPassword ?? binding?.viewOnly ?? false)
  const portValid = Number.isInteger(form.port) && form.port >= 1 && form.port <= 65535
  const ready =
    Boolean(form.name.trim() && form.host.trim() && form.providerId) &&
    portValid &&
    (!changed || (outcome !== undefined && form.confirm))

  const errorText = (caught: unknown) => {
    const refusal = toRemoteDesktopError(caught)
    const message = remoteDesktopErrorMessage(refusal.code, refusal.detail)
    return t(`errors.${message.key}`, message.values)
  }

  const update = (patch: Partial<RemoteDesktopForm>) => {
    setForm((current) => {
      const next = { ...current, ...patch }
      // A new address invalidates the check and its confirmation.
      if (patch.host !== undefined || patch.port !== undefined) {
        next.confirm = false
        setCheck({ status: "idle" })
      }
      return next
    })
  }

  const chooseProvider = (providerId: string) => {
    const chosen = providers.find((entry) => entry.providerId === providerId)
    if (!chosen) return
    update({
      providerId,
      adapter: chosen.definition.adapter,
      viewOnly: chosen.definition.capabilities.viewOnlyPassword ? form.viewOnly : false,
      ...(state.kind === "add" ? { port: chosen.definition.defaultPort } : {}),
    })
  }

  const resolve = async () => {
    setCheck({ status: "busy" })
    try {
      const resolved = await probe(host, {
        kind: "draft",
        host: form.host.trim(),
        port: form.port,
        adapter: form.adapter,
      })
      setCheck({ status: "resolved", outcome: resolved })
    } catch (caught) {
      setCheck({ status: "error", message: errorText(caught) })
    }
  }

  const test = async () => {
    setCheck({ status: "busy" })
    try {
      const tested =
        !changed && existing && binding
          ? await probe(host, { kind: "saved", targetId: existing.id, bindingId: binding.id })
          : await probe(host, {
              kind: "draft",
              host: form.host.trim(),
              port: form.port,
              adapter: form.adapter,
              confirm: true,
            })
      setCheck({ status: "tested", outcome: tested })
    } catch (caught) {
      setCheck({ status: "error", message: errorText(caught) })
    }
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await onSave({
        draft: targetDraftOf(form, existing, binding?.id),
        bindingOf: (saved) => savedBindingOf(saved, existing, binding?.id),
        control: form.adapter === "vnc" ? changeOf(control) : undefined,
        view: form.adapter === "vnc" && form.viewOnly ? changeOf(view) : undefined,
      })
      if (result.credentialError) {
        toast.warning(
          t("dialog.savedWithoutPassword", { message: errorText(result.credentialError) })
        )
      } else {
        toast.success(t("dialog.saved"))
      }
      onClose()
    } catch (caught) {
      const refusal = toRemoteDesktopError(caught)
      if (refusal.code === "remote_desktop_endpoint_unconfirmed") {
        // The name moved since it was checked: show the new address to confirm.
        update({ confirm: false })
        setSaveError(t("dialog.addressChanged"))
      } else {
        setSaveError(errorText(refusal))
      }
    } finally {
      setSaving(false)
    }
  }

  const rfb = outcome?.rfb
  const types = useMemo(() => rfb?.securityTypes.join(", ") ?? "", [rfb])
  const passwordRequired = rfb?.requiresPassword === true

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existing ? t("dialog.titleEdit", { name: existing.name }) : t("dialog.titleAdd")}
          </DialogTitle>
          <DialogDescription>
            {host.kind === "remote"
              ? t("dialog.descriptionRemote", { host: hostLabel ?? "" })
              : t("dialog.description")}
          </DialogDescription>
        </DialogHeader>

        {providers.length === 0 ? (
          <Alert>
            <AlertDescription>{t("dialog.noProviders")}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="rd-provider">{t("dialog.provider")}</Label>
            <Select
              value={form.providerId}
              onValueChange={chooseProvider}
              disabled={providers.length === 0}
            >
              <SelectTrigger id="rd-provider">
                <SelectValue placeholder={t("dialog.providerPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {providers.map((entry) => (
                  <SelectItem key={entry.providerId} value={entry.providerId}>
                    {entry.definition.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="rd-name">{t("dialog.name")}</Label>
            <Input
              id="rd-name"
              value={form.name}
              maxLength={80}
              placeholder={t("dialog.namePlaceholder")}
              onChange={(event) => update({ name: event.target.value })}
            />
          </div>

          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="rd-host">{t("dialog.host")}</Label>
              <Input
                id="rd-host"
                value={form.host}
                placeholder={t("dialog.hostPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => update({ host: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rd-port">{t("dialog.port")}</Label>
              <Input
                id="rd-port"
                type="number"
                min={1}
                max={65535}
                value={Number.isFinite(form.port) ? form.port : ""}
                onChange={(event) => update({ port: Number.parseInt(event.target.value, 10) })}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            {changed ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!form.host.trim() || !portValid || check.status === "busy"}
                onClick={() => void resolve()}
              >
                {check.status === "busy" ? t("dialog.checking") : t("dialog.check")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={(changed && !(outcome && form.confirm)) || check.status === "busy"}
              onClick={() => void test()}
            >
              {check.status === "busy" ? t("dialog.testing") : t("dialog.testConnection")}
            </Button>
          </div>

          {check.status === "error" ? (
            <Alert variant="destructive">
              <AlertDescription>{check.message}</AlertDescription>
            </Alert>
          ) : null}

          {outcome && changed ? (
            <div
              className="bg-muted/40 flex flex-col gap-2 rounded-md p-3 text-sm"
              data-testid="rd-endpoint-confirm"
            >
              <p>
                {outcome.class === "public"
                  ? t("dialog.confirmPublic", { ip: outcome.pinnedIp })
                  : host.kind === "remote"
                    ? t("dialog.confirmPrivateRemote", {
                        ip: outcome.pinnedIp,
                        host: hostLabel ?? "",
                      })
                    : t("dialog.confirmPrivate", { ip: outcome.pinnedIp })}
              </p>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={form.confirm}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({ ...current, confirm: checked === true }))
                  }
                />
                <span>{t("dialog.confirmLabel", { ip: outcome.pinnedIp })}</span>
              </label>
            </div>
          ) : null}

          {check.status === "tested" ? (
            <div className="text-sm" data-testid="rd-probe-result">
              <p>{t("dialog.connected")}</p>
              {rfb ? (
                <>
                  <p className="text-muted-foreground">
                    {t("dialog.probeResult", { protocol: rfb.protocolVersion, types })}
                  </p>
                  {!rfb.supported ? (
                    <p className="text-destructive">{t("dialog.unsupported", { types })}</p>
                  ) : (
                    <p className="text-muted-foreground">
                      {passwordRequired
                        ? t("dialog.requiresPassword")
                        : t("dialog.noPasswordNeeded")}
                    </p>
                  )}
                </>
              ) : null}
            </div>
          ) : null}

          {form.adapter === "vnc" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="rd-password">
                {passwordRequired
                  ? t("dialog.controlPassword")
                  : t("dialog.controlPasswordOptional")}
              </Label>
              <Input
                id="rd-password"
                type="password"
                autoComplete="new-password"
                value={control.value}
                placeholder={
                  binding?.hasControlCredential && !control.cleared
                    ? t("dialog.passwordKeep")
                    : undefined
                }
                onChange={(event) => setControl({ value: event.target.value, cleared: false })}
              />
              <div className="text-muted-foreground flex items-center justify-between text-xs">
                <span>{t("dialog.passwordTruncation")}</span>
                {binding?.hasControlCredential ? (
                  control.cleared ? (
                    <span>{t("dialog.passwordCleared")}</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => setControl({ value: "", cleared: true })}
                    >
                      {t("dialog.clearPassword")}
                    </Button>
                  )
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">{t("dialog.noAuthReadOnly")}</p>
          )}

          {readOnlyOffered ? (
            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-2 text-sm">
                <Switch
                  checked={form.viewOnly}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({ ...current, viewOnly: checked }))
                  }
                  aria-describedby="rd-view-only-description"
                />
                <span className="flex flex-col">
                  <span>{t("dialog.viewOnlyLabel")}</span>
                  <span id="rd-view-only-description" className="text-muted-foreground text-xs">
                    {t("dialog.viewOnlyDescription")}
                  </span>
                </span>
              </label>
              {form.viewOnly ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="rd-view-password">{t("dialog.viewPassword")}</Label>
                  <Input
                    id="rd-view-password"
                    type="password"
                    autoComplete="new-password"
                    value={view.value}
                    placeholder={
                      binding?.hasViewCredential && !view.cleared
                        ? t("dialog.passwordKeep")
                        : undefined
                    }
                    onChange={(event) => setView({ value: event.target.value, cleared: false })}
                  />
                  {binding?.hasViewCredential && !view.cleared ? (
                    <Button
                      size="sm"
                      variant="link"
                      className="h-auto self-end p-0 text-xs"
                      onClick={() => setView({ value: "", cleared: true })}
                    >
                      {t("dialog.clearPassword")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {existing ? (
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={form.enabled}
                onCheckedChange={(checked) =>
                  setForm((current) => ({ ...current, enabled: checked }))
                }
              />
              <span>{t("dialog.enabled")}</span>
            </label>
          ) : null}

          {saveError ? (
            <Alert variant="destructive">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          ) : !ready && changed && outcome === undefined && form.host.trim() ? (
            <p className="text-muted-foreground text-xs">{t("dialog.required")}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button disabled={!ready || saving} onClick={() => void save()}>
            {saving ? t("dialog.saving") : t("dialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

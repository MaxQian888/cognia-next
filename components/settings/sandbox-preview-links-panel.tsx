"use client"

import { useId, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useSandboxPreviewLinks } from "@/hooks/sandbox/use-sandbox-preview-links"
import { listPairedDevices } from "@/lib/db/paired-devices"
import {
  pairedPreviewDeviceId,
  pairedPreviewSupport,
  type PreviewAudience,
  type SandboxPreviewTarget,
} from "@/lib/sandbox/previews"

export function SandboxPreviewLinksPanel({
  projectId,
  targets,
}: {
  projectId: string
  targets: SandboxPreviewTarget[]
}) {
  const t = useTranslations("sandboxManagement")
  const id = useId()
  const state = useSandboxPreviewLinks(projectId)
  const [selection, setSelection] = useState("")
  const [seconds, setSeconds] = useState(900)
  const [leaseRelative, setLeaseRelative] = useState(true)
  const [audienceKey, setAudienceKey] = useState("localOwner")
  const devices = useLiveQuery(() => listPairedDevices(), [], [])
  const activeDevices = devices.filter((device) => !device.revokedAt)
  const deviceLabel = (deviceId: string) =>
    activeDevices.find((device) => device.deviceId === deviceId)?.label ?? deviceId
  // Only a paired desktop has the signed native relay; phones and browsers are
  // listed but cannot be chosen (see `PairedPreviewSupport`).
  const audience: PreviewAudience =
    audienceKey.startsWith("device:") &&
    activeDevices.some(
      (device) =>
        `device:${device.deviceId}` === audienceKey &&
        pairedPreviewSupport(device.platform) === "desktopRelay"
    )
      ? { kind: "pairedDevice", deviceId: audienceKey.slice("device:".length) }
      : { kind: "localOwner" }
  const options = targets.flatMap((target) =>
    target.ports.map((port) => ({
      target,
      ...port,
      key: `${target.workspaceId}:${target.containerId}:${port.port}`,
    }))
  )
  const selected = options.find((option) => option.key === selection) ?? options[0]
  const lease = selected?.target.portLease
  const offset = selected && lease ? selected.port - lease.basePort : -1
  const canUseOffset = !!lease && offset >= 0 && offset < lease.portCount

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 border-t pt-3">
      <h4 id={`${id}-title`} className="text-sm font-medium">
        {t("previews.title")}
      </h4>
      <p className="text-xs text-muted-foreground">{t("previews.description")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-port`}>{t("previews.port")}</Label>
          <NativeSelect
            id={`${id}-port`}
            value={selected?.key ?? ""}
            onChange={(event) => setSelection(event.target.value)}
            disabled={state.busy || !options.length}
          >
            {!options.length ? (
              <NativeSelectOption value="">{t("previews.noPorts")}</NativeSelectOption>
            ) : null}
            {options.map((option) => (
              <NativeSelectOption key={option.key} value={option.key}>
                {t("previews.portOption", {
                  root: option.target.executionRoot,
                  port: option.port,
                  label: option.label ?? "",
                })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-expiry`}>{t("previews.expiry")}</Label>
          <NativeSelect
            id={`${id}-expiry`}
            value={seconds}
            onChange={(event) => setSeconds(Number(event.target.value))}
            disabled={state.busy}
          >
            {[300, 900, 1800, 3600].map((value) => (
              <NativeSelectOption key={value} value={value}>
                {t("previews.minutes", { count: value / 60 })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-audience`}>{t("previews.audience")}</Label>
          <NativeSelect
            id={`${id}-audience`}
            value={audience.kind === "localOwner" ? "localOwner" : audienceKey}
            onChange={(event) => setAudienceKey(event.target.value)}
            disabled={state.busy}
          >
            <NativeSelectOption value="localOwner">{t("previews.localOwner")}</NativeSelectOption>
            {activeDevices.map((device) =>
              pairedPreviewSupport(device.platform) === "desktopRelay" ? (
                <NativeSelectOption key={device.deviceId} value={`device:${device.deviceId}`}>
                  {t("previews.pairedDesktop", { label: device.label })}
                </NativeSelectOption>
              ) : (
                <NativeSelectOption
                  key={device.deviceId}
                  value={`device:${device.deviceId}`}
                  disabled
                >
                  {t("previews.pairedUnsupportedOption", { label: device.label })}
                </NativeSelectOption>
              )
            )}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            {audience.kind === "pairedDevice"
              ? t("previews.pairedHelp")
              : t("previews.localOwnerHelp")}
          </p>
          <p
            data-dormant="paired-mobile-preview"
            className="text-xs text-muted-foreground"
            aria-disabled="true"
          >
            {t("previews.pairedMobileInactive")}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-origin`}>{t("previews.origin")}</Label>
          <NativeSelect id={`${id}-origin`} defaultValue="localhost" disabled={state.busy}>
            <NativeSelectOption value="localhost">
              {t("previews.localhostOrigin")}
            </NativeSelectOption>
            <NativeSelectOption value="loopback" disabled>
              {t("previews.loopbackOrigin")}
            </NativeSelectOption>
          </NativeSelect>
          <p className="text-xs text-muted-foreground" data-dormant="numeric-preview-origin">
            {t("previews.originHelp")}
          </p>
        </div>
        {canUseOffset ? (
          <div className="space-y-1">
            <Label htmlFor={`${id}-addressing`}>{t("previews.addressing")}</Label>
            <NativeSelect
              id={`${id}-addressing`}
              value={leaseRelative ? "offset" : "fixed"}
              onChange={(event) => setLeaseRelative(event.target.value === "offset")}
              disabled={state.busy}
            >
              <NativeSelectOption value="offset">
                {t("previews.leaseOffset", { offset })}
              </NativeSelectOption>
              <NativeSelectOption value="fixed">
                {t("previews.fixedPort", { port: selected!.port })}
              </NativeSelectOption>
            </NativeSelect>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={state.busy || state.loading || !selected}
          onClick={() => {
            if (!selected) return
            void state.create(
              {
                workspaceId: selected.target.workspaceId,
                provider: selected.target.provider,
                containerId: selected.target.containerId,
                expiresInSeconds: seconds,
                originMode: "localhost",
                port:
                  canUseOffset && leaseRelative
                    ? { kind: "workspace-lease-offset", offset }
                    : { kind: "fixed", port: selected.port },
              },
              audience
            )
          }}
        >
          {t("previews.create")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={state.busy || state.loading}
          onClick={() => void state.refresh()}
        >
          {t("refresh")}
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`previews.errors.${state.error}`)}
        </p>
      ) : null}
      {state.loading ? (
        <p role="status" className="text-xs">
          {t("loading")}
        </p>
      ) : !state.grants.length ? (
        <p className="text-xs text-muted-foreground">{t("previews.empty")}</p>
      ) : null}
      <ul className="space-y-2">
        {state.grants.map((grant) => {
          const remaining = Math.max(0, Math.ceil((grant.expiresAt - state.now) / 1000))
          const inactive = grant.revoked || remaining === 0
          const sharedWith = pairedPreviewDeviceId(grant)
          return (
            <li key={grant.id} className="space-y-2 rounded-md border p-3">
              {sharedWith ? (
                <p className="text-xs">
                  {t("previews.sharedWith", { label: deviceLabel(sharedWith) })}
                </p>
              ) : (
                <p className="break-all text-xs">{grant.origin}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {grant.revoked
                  ? t("previews.revoked")
                  : remaining === 0
                    ? t("previews.expired")
                    : t("previews.remaining", {
                        minutes: Math.floor(remaining / 60),
                        seconds: remaining % 60,
                      })}
              </p>
              <div className="flex flex-wrap gap-2">
                {sharedWith ? (
                  <p className="text-xs text-muted-foreground">{t("previews.opensOnDevice")}</p>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        state.busy ||
                        state.loading ||
                        inactive ||
                        !state.copyable.includes(grant.id)
                      }
                      onClick={() => void state.copy(grant.id)}
                    >
                      {t("previews.copyOnce")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={state.busy || state.loading || inactive}
                      onClick={() => void state.open(grant.id)}
                    >
                      {t("previews.open")}
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state.busy || state.loading || inactive}
                  onClick={() => void state.revoke(grant.id)}
                >
                  {t("previews.revoke")}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

"use client"

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { QRCodeSVG } from "qrcode.react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { SettingsAlert, SettingsEmptyState } from "@/components/settings/common/settings-section"
import { StatusBadge } from "@/components/status-badge"
import { Snippet, SnippetCopyButton, SnippetInput } from "@/components/ai-elements/snippet"
import {
  isRemoteWorkerDispatchAvailable,
  subscribeToRemoteWorkerRuntime,
} from "@/lib/ai/agent/team/remote-worker-runtime"
import {
  createWorkerEnrollment,
  listExecutionWorkers,
  revokeExecutionWorker,
  workerEnrollmentCommand,
  type WorkerDeviceSummary,
  type WorkerEnrollmentIssue,
} from "@/lib/fleet/execution-workers"
import type { FleetHost } from "@/lib/fleet/types"
import { useAgentExecutionFlag } from "@/hooks/agent/use-agent-execution-flag"
import { setAgentExecutionFlag } from "@/lib/ai/agent/execution/feature-flags"

export function ExecutionWorkersCard({ hosts }: { hosts: readonly FleetHost[] }) {
  const t = useTranslations("settings.fleet.workers")
  const [devices, setDevices] = useState<WorkerDeviceSummary[]>([])
  const [issue, setIssue] = useState<WorkerEnrollmentIssue | null>(null)
  const [busy, setBusy] = useState(false)
  const remoteDispatchEnabled = useAgentExecutionFlag("agentTeamRemoteDispatch")

  const refresh = useCallback(async () => {
    setDevices(await listExecutionWorkers())
  }, [])

  useEffect(() => {
    let active = true
    void listExecutionWorkers()
      .then((workers) => {
        if (active) setDevices(workers)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const command = useMemo(() => (issue ? workerEnrollmentCommand(issue) : ""), [issue])
  const onlineByHost = new Map(hosts.map((host) => [host.hostRef, host]))
  // A host with no attached brain still authenticates workers and still shows
  // them online — it just cannot send them anything. Saying so is the whole
  // point: this was silent before, and an enrolled worker that never receives a
  // frame is indistinguishable from a healthy idle one.
  const canDispatch = useSyncExternalStore(
    subscribeToRemoteWorkerRuntime,
    isRemoteWorkerDispatchAvailable,
    () => true
  )

  const create = async () => {
    setBusy(true)
    try {
      setIssue(await createWorkerEnrollment())
    } catch (error) {
      const detail =
        error instanceof Error && error.message === "companion_not_connected"
          ? t("notConnected")
          : error instanceof Error
            ? error.message
            : String(error)
      toast.error(t("error", { detail }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      testid="execution-workers-card"
      action={
        <Button size="sm" disabled={busy} onClick={() => void create()}>
          {t("enroll")}
        </Button>
      }
    >
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="fleet-agent-team-remote-dispatch">
            {t("remoteDispatchLabel")}
          </FieldLabel>
          <FieldDescription>{t("remoteDispatchDescription")}</FieldDescription>
        </FieldContent>
        <Switch
          id="fleet-agent-team-remote-dispatch"
          checked={remoteDispatchEnabled}
          onCheckedChange={(enabled) => setAgentExecutionFlag("agentTeamRemoteDispatch", enabled)}
        />
      </Field>

      {issue ? (
        <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_auto]">
          <div className="min-w-0 space-y-2">
            <p className="text-xs text-muted-foreground">
              {t("expires", { time: new Date(issue.expiresAtMs).toLocaleTimeString() })}
            </p>
            <Snippet code={command}>
              <SnippetInput aria-label={t("commandAria")} />
              <SnippetCopyButton
                aria-label={t("copy")}
                title={t("copy")}
                onCopy={() => toast.success(t("copied"))}
                onError={() => toast.error(t("copyFailed"))}
              />
            </Snippet>
          </div>
          <QRCodeSVG value={JSON.stringify(issue)} size={128} level="M" aria-label={t("qrAria")} />
        </div>
      ) : null}

      {!canDispatch && devices.length > 0 ? (
        <SettingsAlert variant="destructive">{t("dispatchUnavailable")}</SettingsAlert>
      ) : null}

      {devices.length === 0 ? (
        <SettingsEmptyState title={t("empty")} className="py-4" />
      ) : (
        <div className="space-y-2">
          {devices.map((device) => {
            const host = onlineByHost.get(device.hostRef)
            const placementStatus = !host?.online
              ? "offline"
              : host.placementReady === true
                ? "online"
                : "incompatible"
            return (
              <div
                key={device.deviceId}
                className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{device.displayName}</span>
                <StatusBadge
                  value={placementStatus}
                  labelNamespace="settings.fleet.workers.status"
                  variantMap={{ online: "secondary", incompatible: "destructive" }}
                />
                {host?.online ? (
                  <span className="text-muted-foreground">
                    {t("capacity", {
                      used: host.usedSlots ?? 0,
                      total: host.maxActiveTurns,
                    })}
                  </span>
                ) : null}
                {host?.placementReason ? (
                  <SettingsAlert variant="destructive" className="basis-full py-2">
                    {t("placementReason", { reason: host.placementReason })}
                  </SettingsAlert>
                ) : null}
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    void revokeExecutionWorker(device.deviceId)
                      .then(refresh)
                      .then(() => toast.success(t("revoked")))
                      .catch((error) =>
                        toast.error(
                          t("error", {
                            detail: error instanceof Error ? error.message : String(error),
                          })
                        )
                      )
                  }
                >
                  {t("revoke")}
                </Button>
              </div>
            )
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("bindingHint")}</p>
    </SettingsBlock>
  )
}

"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import {
  lumeClient,
  lumeFailureKind,
  type LumeFailureKind,
  type LumeOperationProgress,
  type LumeClient,
  type LumeDiagnostics,
  type LumeOperation,
  type LumeResource,
  type LumeWorkspaceReview,
} from "@/lib/automation/lume-client"
import { getSandboxConnection, putSandboxConnection } from "@/lib/db/sandbox-connections"
import { projectLumeResource } from "@/lib/sandbox/lume-projection"
import { isTauri } from "@/lib/platform/detect"
import { SandboxDesktopViewer } from "./sandbox-desktop-viewer"

export function LumeSettings({
  client = lumeClient,
  framed = true,
}: {
  client?: LumeClient
  framed?: boolean
}) {
  const t = useTranslations("automation.lume")
  const id = useId()
  const [diagnostics, setDiagnostics] = useState<LumeDiagnostics | null>(null)
  const [binary, setBinary] = useState("/opt/homebrew/bin/lume")
  const [mode, setMode] = useState("clone")
  const [source, setSource] = useState("")
  const [storage, setStorage] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LumeFailureKind | null>(null)
  const [progress, setProgress] = useState<{ operation: LumeOperation; stage: string } | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [completedAfterCancel, setCompletedAfterCancel] = useState(false)
  const [setup, setSetup] = useState("")
  const mounted = useRef(false)
  const foreground = useRef<AbortController | null>(null)
  const refreshSequence = useRef({ value: 0 })
  const desktop = isTauri()
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current.value
    const current = () => mounted.current && sequence === refreshSequence.current.value
    try {
      const result = await client.diagnose()
      if (!current()) return
      if (result.contractVersion !== 1) throw new Error("lume_contract_unsupported")
      for (const resource of result.resources) {
        const previous = await getSandboxConnection(resource.connectionId)
        if (!current()) return
        await putSandboxConnection(projectLumeResource(resource, result.enabled, previous))
      }
      if (current()) setDiagnostics(result)
    } catch (cause) {
      if (current()) setError(lumeFailureKind(cause))
    }
  }, [client])
  useEffect(() => {
    mounted.current = true
    const refreshes = refreshSequence.current
    let active = true
    if (desktop)
      void Promise.resolve()
        .then(() => {
          if (active) return refresh()
        })
        .then(() => {
          if (active && !foreground.current) setBusy(false)
        })
    return () => {
      active = false
      mounted.current = false
      ++refreshes.value
      foreground.current?.abort()
      foreground.current = null
    }
  }, [desktop, refresh])
  const run = async (operation: LumeOperation, urgent = false) => {
    if (!urgent && foreground.current) return
    const controller = urgent ? null : new AbortController()
    if (controller) {
      foreground.current = controller
      setBusy(true)
      setCancelling(false)
      setProgress({ operation, stage: "queued" })
    }
    setError(null)
    setCompletedAfterCancel(false)
    const current = () => mounted.current && (urgent || foreground.current === controller)
    let observedResource: string | undefined
    const observe = (status: LumeOperationProgress) => {
      if (!current()) return
      setProgress({ operation, stage: status.stage })
      if (status.resource && status.resource.resourceId !== observedResource) {
        observedResource = status.resource.resourceId
        void refresh()
      }
    }
    try {
      const result = urgent
        ? await client.run(operation)
        : await client.run(operation, controller!.signal, observe)
      if (!current()) return
      if (operation.kind === "prepareSsh" && result.output)
        setSetup(JSON.stringify(result.output, null, 2))
      const recoveryRequired =
        result.output !== null &&
        typeof result.output === "object" &&
        "journalRecoveryRequired" in result.output &&
        result.output.journalRecoveryRequired === true
      const resultError = result.errorCode ?? result.resource?.lastErrorCode
      const failure = resultError ? lumeFailureKind(resultError) : null
      if (recoveryRequired || failure === "recovery") setError("recovery")
      else if (failure && failure !== "unknown") setError(failure)
      else if (controller?.signal.aborted) setCompletedAfterCancel(true)
      return result.output
    } catch (cause) {
      if (current()) setError(lumeFailureKind(cause))
    } finally {
      if (current()) {
        if (!urgent) {
          foreground.current = null
          setBusy(false)
          setProgress(null)
          setCancelling(false)
        }
        await refresh()
      }
    }
  }
  const operationLabel =
    progress?.operation.kind === "configure"
      ? t(progress.operation.enabled ? "enable" : "disable")
      : progress && !["execute", "file"].includes(progress.operation.kind)
        ? t(progress.operation.kind)
        : t("title")
  const stage =
    progress &&
    ["awaitingConsent", "queued", "running", "provisioning", "finished"].includes(progress.stage)
      ? progress.stage
      : "unknown"
  const Container = framed ? Card : "section"
  return (
    <Container>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!desktop && <p>{t("desktopRequired")}</p>}
        {error && (
          <p
            role={error === "cancelled" ? "status" : "alert"}
            className={error === "cancelled" ? "text-muted-foreground" : "text-destructive"}
          >
            {error === "unknown" ? t("operationFailed") : t(`errors.${error}`)}
          </p>
        )}
        {progress && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="status" className="text-sm text-muted-foreground">
              {cancelling
                ? t("cancellationPending")
                : t("operationProgress", {
                    operation: operationLabel,
                    stage: t(`stages.${stage}`),
                  })}
            </p>
            <Button
              variant="outline"
              disabled={cancelling}
              onClick={() => {
                foreground.current?.abort()
                setCancelling(true)
              }}
            >
              {t("cancelOperation")}
            </Button>
          </div>
        )}
        {completedAfterCancel && <p role="status">{t("completedAfterCancel")}</p>}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-binary`}>{t("binary")}</FieldLabel>
            <Input
              id={`${id}-binary`}
              value={binary}
              onChange={(event) => setBinary(event.target.value)}
              disabled={!desktop || busy}
            />
          </Field>
        </FieldGroup>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!desktop || busy || !binary || diagnostics?.platformSupported === false}
            onClick={() => void run({ kind: "configure", binary, enabled: true })}
          >
            {t("enable")}
          </Button>
          <Button
            variant="outline"
            disabled={!desktop || busy || !diagnostics?.enabled}
            onClick={() => void run({ kind: "configure", binary, enabled: false })}
          >
            {t("disable")}
          </Button>
          <Button variant="outline" disabled={!desktop} onClick={() => void refresh()}>
            {t("refresh")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("policyNotice")}</p>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-mode`}>{t("sourceMode")}</FieldLabel>
            <NativeSelect
              id={`${id}-mode`}
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <NativeSelectOption value="clone">{t("clone")}</NativeSelectOption>
              <NativeSelectOption value="create">{t("create")}</NativeSelectOption>
              <NativeSelectOption value="attach">{t("attach")}</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-source`}>
              {mode === "create" ? t("ipsw") : t("vmName")}
            </FieldLabel>
            <Input
              id={`${id}-source`}
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </Field>
          {mode === "clone" && (
            <Field>
              <FieldLabel htmlFor={`${id}-storage`}>{t("seedStorage")}</FieldLabel>
              <Input
                id={`${id}-storage`}
                value={storage}
                onChange={(event) => setStorage(event.target.value)}
              />
            </Field>
          )}
        </FieldGroup>
        <Button
          disabled={
            busy || !desktop || !diagnostics?.enabled || !source || (mode === "clone" && !storage)
          }
          onClick={() =>
            void run({
              kind: "provision",
              connection_id: crypto.randomUUID(),
              source:
                mode === "create"
                  ? { kind: "create", ipsw: source, cpu: 4, memory_mb: 8192, disk_gb: 64 }
                  : mode === "attach"
                    ? { kind: "attach", vm_name: source }
                    : { kind: "clone", seed_name: source, seed_storage: storage },
            })
          }
        >
          {t("provision")}
        </Button>
        {setup && (
          <Field>
            <FieldLabel htmlFor={`${id}-setup`}>{t("setupMaterial")}</FieldLabel>
            <Textarea id={`${id}-setup`} readOnly value={setup} />
          </Field>
        )}
        {diagnostics?.resources.map((resource) => (
          <LumeResourcePanel
            key={resource.resourceId}
            resource={resource}
            enabled={diagnostics.enabled}
            busy={busy}
            run={run}
          />
        ))}
      </CardContent>
    </Container>
  )
}

function LumeResourcePanel({
  resource,
  enabled,
  busy,
  run,
}: {
  resource: LumeResource
  enabled: boolean
  busy: boolean
  run(operation: LumeOperation, urgent?: boolean): Promise<unknown>
}) {
  const t = useTranslations("automation.lume")
  const id = useId()
  const [hostKey, setHostKey] = useState("")
  const [user, setUser] = useState("lume")
  const [helperHash, setHelperHash] = useState("")
  const [driverVersion, setDriverVersion] = useState("")
  const [workspaceRoot, setWorkspaceRoot] = useState("")
  const [review, setReview] = useState<(LumeWorkspaceReview & { bootEpoch: string }) | null>(null)
  const [adoptionState, setAdoptionState] = useState<"conflict" | "refused" | null>(null)
  const reference = {
    resourceId: resource.resourceId,
    generation: resource.generation,
    bootEpoch: resource.bootEpoch,
  }
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label={resource.vmName}>
      <p className="font-medium">{resource.vmName}</p>
      <p>
        {t("state", {
          state: [
            "uninitialized",
            "creating",
            "starting",
            "running",
            "stopping",
            "stopped",
            "deleting",
            "error",
          ].includes(resource.state)
            ? t(`states.${resource.state}`)
            : t("states.unknown"),
        })}
      </p>
      <p className="text-sm">
        {t("readiness", {
          vm: t(resource.readiness.vm ? "ready" : "notReady"),
          ssh: t(resource.readiness.ssh ? "ready" : "notReady"),
          helper: t(resource.readiness.helper ? "ready" : "notReady"),
          gui: t(resource.readiness.gui ? "ready" : "notReady"),
        })}
      </p>
      {resource.quarantine && (
        <p role="status" className="text-destructive">
          {t("quarantined")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(["start", "setup", "connect", "health", "delete", "prepareSsh"] as const).map((kind) => (
          <Button
            key={kind}
            variant={kind === "delete" ? "destructive" : "outline"}
            disabled={busy || (kind !== "health" && kind !== "delete" && !enabled)}
            onClick={() => void run({ kind, reference })}
          >
            {t(kind)}
          </Button>
        ))}
        <Button variant="destructive" onClick={() => void run({ kind: "stop", reference }, true)}>
          {t("stop")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("setupInstructions")}</p>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-key`}>{t("hostKey")}</FieldLabel>
          <Input
            id={`${id}-key`}
            value={hostKey}
            onChange={(event) => setHostKey(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-user`}>{t("sshUser")}</FieldLabel>
          <Input id={`${id}-user`} value={user} onChange={(event) => setUser(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-hash`}>{t("helperHash")}</FieldLabel>
          <Input
            id={`${id}-hash`}
            value={helperHash}
            onChange={(event) => setHelperHash(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-version`}>{t("driverVersion")}</FieldLabel>
          <Input
            id={`${id}-version`}
            value={driverVersion}
            onChange={(event) => setDriverVersion(event.target.value)}
          />
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !enabled || !hostKey || !user}
          onClick={() => void run({ kind: "trustSsh", reference, host_key: hostKey, user })}
        >
          {t("trustSsh")}
        </Button>
        <Button
          disabled={busy || !enabled || !helperHash || !driverVersion}
          onClick={() =>
            void run({
              kind: "qualify",
              reference,
              helper_hash: helperHash,
              driver_version: driverVersion,
            })
          }
        >
          {t("qualify")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("workspaceNotice")}</p>
      <Field>
        <FieldLabel htmlFor={`${id}-workspace`}>{t("workspaceRoot")}</FieldLabel>
        <Input
          id={`${id}-workspace`}
          value={workspaceRoot}
          onChange={(event) => setWorkspaceRoot(event.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={
            busy ||
            !enabled ||
            !resource.readiness.helper ||
            !workspaceRoot ||
            !!resource.workspaceRevision
          }
          onClick={() => void run({ kind: "importWorkspace", reference, host_root: workspaceRoot })}
        >
          {t("importWorkspace")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !enabled || !resource.readiness.helper || !resource.workspaceRevision}
          onClick={async () => {
            setAdoptionState(null)
            const output = (await run({ kind: "reviewWorkspace", reference })) as
              LumeWorkspaceReview | undefined
            if (output?.hostRoot) setWorkspaceRoot(output.hostRoot)
            if (output?.reviewId && output.patch)
              setReview({ ...output, bootEpoch: reference.bootEpoch })
          }}
        >
          {t("reviewWorkspace")}
        </Button>
        <Button
          disabled={busy || !enabled || !review || review.bootEpoch !== reference.bootEpoch}
          onClick={async () => {
            if (!review) return
            const output = (await run({
              kind: "adoptWorkspace",
              reference,
              review_id: review.reviewId,
            })) as { status?: string } | undefined
            setAdoptionState(
              output?.status === "conflict"
                ? "conflict"
                : output?.status === "refused"
                  ? "refused"
                  : null
            )
            if (output?.status === "applied") setReview(null)
          }}
        >
          {t("adoptWorkspace")}
        </Button>
      </div>
      {review && (
        <Field>
          <FieldLabel htmlFor={`${id}-diff`}>{t("workspaceDiff")}</FieldLabel>
          <Textarea
            id={`${id}-diff`}
            readOnly
            value={JSON.stringify(review.patch, null, 2)}
            className="min-h-48 font-mono text-xs"
          />
        </Field>
      )}
      {adoptionState && (
        <p role="alert" className="text-destructive">
          {t(adoptionState === "conflict" ? "workspaceConflict" : "operationFailed")}
        </p>
      )}
      <SandboxDesktopViewer
        connectionId={resource.connectionId}
        enabled={enabled && resource.readiness.gui && !resource.quarantine}
        allowStreaming={false}
        transferTargetId={`lume:${reference.resourceId}:${reference.generation}:${reference.bootEpoch}`}
        transferFolder="/workspace"
      />
    </section>
  )
}

"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useLocale, useTranslations } from "next-intl"
import { ArrowRight, CheckCircle2, ChevronLeft, Circle, ExternalLink, Loader2 } from "lucide-react"
import { PairStep } from "@/components/connectivity/pair/pair-step"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { useExecutionHostSwitch } from "@/hooks/devices/use-execution-host-switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { isTauri } from "@/lib/platform/detect"
import { GITHUB_URL } from "@/lib/constants/external-urls"
import { openExternal } from "@/lib/tauri/opener"
import { decodePairPayload } from "@/lib/qr/pair-payload"
import {
  githubRunnerClient,
  linkRunnerHost,
  loadRunnerCreateConfig,
  normalizeRunnerRepository,
  runnerHostLinks,
  runnerRunUrl,
  saveRunnerCreateConfig,
  validateRunnerRequest,
  type GitHubRunnerLease,
  type GitHubRunnerRequest,
  type GitHubRunnerPreflight,
  type RunnerValidationField,
} from "@/lib/remote-host/github-runner/client"
import type { CompanionConfig } from "@/lib/tauri/transport-companion"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

const DEFAULT_REQUEST: GitHubRunnerRequest = {
  repository: "",
  workflowRef: "main",
  label: "",
  hostImage: "",
  agentBundleImage: "",
  developmentImage: "",
  signalingUrl: "",
  lifetimeMinutes: 60,
}
const FIELDS = [
  "label",
  "repository",
  "workflowRef",
  "hostImage",
  "agentBundleImage",
  "developmentImage",
  "signalingUrl",
  "lifetimeMinutes",
] as const
const SETUP_FIELDS: RunnerValidationField[] = ["repository", "workflowRef"]
const ENVIRONMENT_FIELDS: RunnerValidationField[] = [
  "label",
  "lifetimeMinutes",
  "hostImage",
  "agentBundleImage",
  "developmentImage",
  "signalingUrl",
]
const STEPS = ["setup", "environment", "review"] as const
const subscribePlatform = () => () => undefined
const serverPlatform = () => false

export function GitHubRunnerPanel() {
  const t = useTranslations("settings.connectivity.githubRunner")
  const locale = useLocale()
  const translateRef = useRef(t)
  useEffect(() => {
    translateRef.current = t
  }, [t])
  const desktop = useSyncExternalStore(subscribePlatform, isTauri, serverPlatform)
  const [request, setRequest] = useState(DEFAULT_REQUEST)
  const [leases, setLeases] = useState<GitHubRunnerLease[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [step, setStep] = useState(0)
  const [invalidFields, setInvalidFields] = useState<RunnerValidationField[]>([])
  const [restored, setRestored] = useState(false)
  const [checking, setChecking] = useState(false)
  const [preflight, setPreflight] = useState<{ key: string; result: GitHubRunnerPreflight }>()
  const [createdId, setCreatedId] = useState<string>()
  const checkVersion = useRef(0)
  const checkPending = useRef(false)
  const stepHeading = useRef<HTMLHeadingElement>(null)
  const previousStep = useRef(step)
  useEffect(() => {
    if (previousStep.current !== step) stepHeading.current?.focus()
    previousStep.current = step
  }, [step])
  const [pairing, setPairing] = useState<{
    lease: GitHubRunnerLease
    payload: string
    fingerprint: string
  }>()
  const epoch = useRef(0)
  const pairingEpoch = useRef(0)
  const operation = useRef(false)
  const operationVersion = useRef(0)
  const polling = useRef(false)
  const refreshVersions = useRef(new Map<string, number>())
  const refreshing = useRef(new Map<string, number>())
  const requestEdited = useRef(false)
  const requestRestored = useRef(false)
  const hosts = useRemoteHostStore((state) => state.hosts)
  const activeHostId = useRemoteHostStore((state) => state.activeHostId)
  const addHost = useRemoteHostStore((state) => state.addHost)
  const deactivate = useRemoteHostStore((state) => state.deactivate)
  // Connect and "connect after pairing" are the user choosing to drive the
  // runner, so they take the shared in-flight guard like every other switch.
  const { requestSwitch, dialog } = useExecutionHostSwitch()

  const updateLease = useCallback(
    (lease: GitHubRunnerLease) => {
      setLeases((previous) => [lease, ...previous.filter((row) => row.id !== lease.id)])
      // Deliberately NOT through `useExecutionHostSwitch`. A lease that reached
      // `stopped` or `failed` means the runner machine is gone, whether the
      // user pressed Stop, the lifetime ran out or GitHub killed the job, and
      // most of those nobody initiated from this window. Any turn on that host
      // is already lost with it; asking "switch anyway?" would only keep every
      // execution call pointed at a dead transport until someone answered.
      // Stop itself is also left unguarded: the runner keeps serving until its
      // owner confirms the stop (`stopPending`), so pressing it does not move
      // the transport, and this deactivation is what follows the confirmation.
      if (lease.state === "stopped" || lease.state === "failed") {
        const linked = runnerHostLinks()[lease.id]
        if (linked && useRemoteHostStore.getState().activeHostId === linked) deactivate()
        setPairing((current) => (current?.lease.id === lease.id ? undefined : current))
      }
    },
    [deactivate]
  )

  const refreshLease = useCallback(
    async (id: string, generation: number, force = false) => {
      if (!force && refreshing.current.has(id)) return
      const version = (refreshVersions.current.get(id) ?? 0) + 1
      refreshVersions.current.set(id, version)
      refreshing.current.set(id, version)
      try {
        const refreshed = await githubRunnerClient.refresh(id)
        if (generation === epoch.current && refreshVersions.current.get(id) === version)
          updateLease(refreshed)
      } catch {
        if (generation === epoch.current && refreshVersions.current.get(id) === version)
          setError(t("operationFailed"))
      } finally {
        if (refreshing.current.get(id) === version) refreshing.current.delete(id)
      }
    },
    [t, updateLease]
  )

  const refreshBatch = useCallback(
    async (ids: string[], generation: number, background: boolean) => {
      const version = operationVersion.current
      let next = 0
      const worker = async () => {
        while (
          next < ids.length &&
          generation === epoch.current &&
          (!background || (!operation.current && version === operationVersion.current))
        ) {
          const id = ids[next++]
          await refreshLease(id, generation, !background)
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
    },
    [refreshLease]
  )

  useEffect(() => {
    const generation = ++epoch.current
    const available = isTauri()
    if (!available) {
      return
    }
    const saved = loadRunnerCreateConfig()
    void Promise.resolve().then(() => {
      if (generation !== epoch.current || requestEdited.current || requestRestored.current) return
      requestRestored.current = true
      if (saved) {
        setRequest(saved)
        setRestored(true)
      }
    })
    void githubRunnerClient
      .list()
      .then((rows) => {
        if (generation === epoch.current) rows.forEach(updateLease)
      })
      .catch(() => {
        if (generation === epoch.current) setError(translateRef.current("loadFailed"))
      })
      .finally(() => {
        if (generation === epoch.current) setLoading(false)
      })
    return () => {
      epoch.current += 1
    }
  }, [updateLease])

  useEffect(() => {
    if (!desktop || !leases.some((lease) => lease.state !== "stopped" && lease.state !== "failed"))
      return
    const timer = setInterval(() => {
      if (operation.current || polling.current) return
      const generation = epoch.current
      polling.current = true
      const ids = leases
        .filter((lease) => lease.state !== "stopped" && lease.state !== "failed")
        .map((lease) => lease.id)
      void refreshBatch(ids, generation, true).finally(() => {
        polling.current = false
      })
    }, 15_000)
    return () => {
      clearInterval(timer)
    }
  }, [desktop, leases, refreshBatch])

  const run = async (key: string, action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true
    operationVersion.current += 1
    const generation = epoch.current
    refreshVersions.current.set(key, (refreshVersions.current.get(key) ?? 0) + 1)
    setBusy(key)
    setError(undefined)
    try {
      await action()
    } catch {
      if (generation === epoch.current) setError(t("operationFailed"))
    } finally {
      operation.current = false
      if (generation === epoch.current) setBusy(undefined)
    }
  }

  const connect = async (lease: GitHubRunnerLease) => {
    const generation = epoch.current
    const pairGeneration = ++pairingEpoch.current
    const fresh = await githubRunnerClient.refresh(lease.id)
    if (generation !== epoch.current || pairGeneration !== pairingEpoch.current) return
    updateLease(fresh)
    if (fresh.state !== "ready") return
    const linkedId = runnerHostLinks()[lease.id]
    if (linkedId && hosts.some((host) => host.id === linkedId)) {
      // `reconnect`: the button reads "Reconnect" when this runner is already
      // the active host, and re-running its handshake replaces the transport.
      void requestSwitch(linkedId, { reconnect: true })
      return
    }
    const payload = await githubRunnerClient.pairing(lease.id)
    if (generation !== epoch.current || pairGeneration !== pairingEpoch.current) return
    const decoded = decodePairPayload(payload)
    if (
      !payload.startsWith("cgnp4|") ||
      decoded.kind !== "ok" ||
      !decoded.payload.relay ||
      !decoded.payload.fingerprint
    )
      throw new Error(t("invalidInvitation"))
    setPairing({ lease: fresh, payload, fingerprint: decoded.payload.fingerprint })
  }

  const persistPairing = async (config: CompanionConfig) => {
    if (!pairing) throw new Error(t("pairingInactive"))
    const generation = epoch.current
    const pairGeneration = pairingEpoch.current
    const fresh = await githubRunnerClient.refresh(pairing.lease.id)
    if (generation !== epoch.current || pairGeneration !== pairingEpoch.current) {
      throw new Error(t("pairingCancelled"))
    }
    updateLease(fresh)
    if (fresh.state !== "ready") throw new Error(t("runnerNotReady"))
    const host = addHost({ label: pairing.lease.label, config })
    linkRunnerHost(pairing.lease.id, host.id)
    // Not awaited: the pairing is complete once the host is registered, and
    // whether this window starts driving it may be waiting on the user.
    void requestSwitch(host.id)
  }

  const setupKey = (value: GitHubRunnerRequest) =>
    JSON.stringify([value.repository, value.workflowRef])
  const normalizedRequest = (): GitHubRunnerRequest => ({
    ...(Object.fromEntries(
      Object.entries(request).map(([key, value]) => [
        key,
        typeof value === "string" ? value.trim() : value,
      ])
    ) as unknown as GitHubRunnerRequest),
    repository: normalizeRunnerRepository(request.repository) ?? request.repository.trim(),
  })
  const editField = (field: RunnerValidationField, value: string | number) => {
    requestEdited.current = true
    setRequest((previous) => ({ ...previous, [field]: value }))
    setInvalidFields((previous) => previous.filter((entry) => entry !== field))
    if (SETUP_FIELDS.includes(field)) {
      checkVersion.current += 1
      setPreflight(undefined)
    }
  }
  const goToStep = (next: number) => {
    setStep(next)
    setInvalidFields([])
  }
  const validateFields = (value: GitHubRunnerRequest, fields: readonly RunnerValidationField[]) => {
    const invalid = validateRunnerRequest(value).filter((field) => fields.includes(field))
    setInvalidFields(invalid)
    if (invalid.length) document.getElementById(`github-runner-${invalid[0]}`)?.focus()
    return invalid.length === 0
  }
  const continueSetup = async () => {
    if (checkPending.current || busy) return
    const normalized = normalizedRequest()
    if (!validateFields(normalized, SETUP_FIELDS)) return
    const key = setupKey(normalized)
    const version = ++checkVersion.current
    const generation = epoch.current
    checkPending.current = true
    setChecking(true)
    setError(undefined)
    setPreflight(undefined)
    setRequest(normalized)
    try {
      const result = await githubRunnerClient.preflight({
        repository: normalized.repository,
        workflowRef: normalized.workflowRef,
      })
      if (generation !== epoch.current || version !== checkVersion.current) return
      setPreflight({ key, result })
      if (result.ready) {
        setRequest((previous) => ({
          ...previous,
          label: previous.label.trim() || normalized.repository.split("/")[1],
        }))
        goToStep(1)
      }
    } catch {
      if (generation === epoch.current && version === checkVersion.current)
        setError(t("wizard.checkFailed"))
    } finally {
      checkPending.current = false
      if (generation === epoch.current) setChecking(false)
    }
  }
  const submitStep = () => {
    if (busy || checking || createdId) return
    if (step === 0) {
      void continueSetup()
      return
    }
    const normalized = normalizedRequest()
    if (!preflight?.result.ready || preflight.key !== setupKey(normalized)) {
      goToStep(0)
      return
    }
    if (!validateFields(normalized, FIELDS)) {
      setStep(
        validateRunnerRequest(normalized).some((field) => SETUP_FIELDS.includes(field)) ? 0 : 1
      )
      return
    }
    setRequest(normalized)
    if (step === 1) {
      goToStep(2)
      return
    }
    void run("create", async () => {
      const generation = epoch.current
      saveRunnerCreateConfig(normalized)
      const created = await githubRunnerClient.create(normalized)
      if (generation === epoch.current) {
        updateLease(created)
        setCreatedId(created.id)
      }
    })
  }
  const renderField = (field: RunnerValidationField) => {
    const invalid = invalidFields.includes(field)
    const id = `github-runner-${field}`
    return (
      <Field
        key={field}
        data-invalid={invalid}
        data-disabled={Boolean(busy)}
        className="min-w-0 gap-1.5"
      >
        <FieldLabel htmlFor={id}>{t(`fields.${field}`)}</FieldLabel>
        <Input
          id={id}
          value={request[field]}
          disabled={Boolean(busy)}
          required
          aria-invalid={invalid}
          aria-describedby={`${id}-help${invalid ? ` ${id}-error` : ""}`}
          type={field === "lifetimeMinutes" ? "number" : "text"}
          min={field === "lifetimeMinutes" ? 10 : undefined}
          max={field === "lifetimeMinutes" ? 330 : undefined}
          placeholder={t(`placeholders.${field}`)}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) =>
            editField(
              field,
              field === "lifetimeMinutes" ? Number(event.target.value) : event.target.value
            )
          }
          onBlur={() => {
            if (field === "repository") {
              const value = normalizeRunnerRepository(request.repository)
              if (value && value !== request.repository) editField(field, value)
            }
          }}
        />
        <FieldDescription id={`${id}-help`} className="text-xs">
          {t(`hints.${field}`)}
        </FieldDescription>
        {invalid ? (
          <FieldError id={`${id}-error`} className="text-xs">
            {t(`validation.${field}`)}
          </FieldError>
        ) : null}
      </Field>
    )
  }

  return (
    <SettingsBlock title={t("title")} description={t("description")} testid="github-runner-panel">
      {!desktop ? (
        <p className="text-xs text-muted-foreground">{t("desktopRequired")}</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t("wizard.intro")}</p>
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={() => {
                const file = locale.startsWith("zh") ? "README.zh-CN.md" : "README.md"
                void openExternal(`${GITHUB_URL}/blob/dev/deploy/github-runner/${file}`).catch(() =>
                  setError(t("guideOpenFailed"))
                )
              }}
            >
              <ExternalLink aria-hidden="true" />
              {t("setupGuide")}
            </Button>
          </div>
          {createdId ? (
            <Alert role="status">
              <CheckCircle2 aria-hidden="true" />
              <AlertTitle>{t("wizard.created")}</AlertTitle>
              <AlertDescription>
                <p>{t("wizard.createdHint")}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCreatedId(undefined)
                    setPreflight(undefined)
                    setError(undefined)
                    goToStep(0)
                  }}
                >
                  {t("wizard.createAnother")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <form
              noValidate
              className="space-y-4 rounded-lg border p-4"
              onSubmit={(event) => {
                event.preventDefault()
                submitStep()
              }}
            >
              <ol aria-label={t("wizard.steps")} className="grid grid-cols-3 gap-2">
                {STEPS.map((name, index) => (
                  <li key={name}>
                    <Button
                      type="button"
                      variant={step === index ? "secondary" : "ghost"}
                      className="h-auto w-full flex-wrap justify-start gap-1.5 px-2 py-2 text-xs"
                      aria-current={step === index ? "step" : undefined}
                      disabled={index > step || Boolean(busy) || checking}
                      onClick={() => goToStep(index)}
                    >
                      {index < step ? (
                        <CheckCircle2 aria-hidden="true" />
                      ) : (
                        <span aria-hidden="true">{index + 1}</span>
                      )}
                      {t(`wizard.${name}.title`)}
                    </Button>
                  </li>
                ))}
              </ol>
              {restored ? (
                <Alert role="note">
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                    <span>{t("wizard.restored")}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(busy) || checking}
                      onClick={() => {
                        requestEdited.current = true
                        checkVersion.current += 1
                        setRequest(DEFAULT_REQUEST)
                        setPreflight(undefined)
                        setRestored(false)
                        setError(undefined)
                        goToStep(0)
                      }}
                    >
                      {t("wizard.reset")}
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}
              <div>
                <h3 ref={stepHeading} tabIndex={-1} className="text-sm font-medium outline-none">
                  {t(`wizard.${STEPS[step]}.title`)}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(`wizard.${STEPS[step]}.description`)}
                </p>
              </div>
              {step === 0 ? (
                <FieldGroup className="gap-4">
                  <Alert role="note">
                    <AlertDescription>
                      <p>{t("wizard.setupHelp")}</p>
                    </AlertDescription>
                  </Alert>
                  {SETUP_FIELDS.map(renderField)}
                  {checking ? (
                    <p
                      role="status"
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      {t("wizard.checkingHint")}
                    </p>
                  ) : null}
                  {preflight ? (
                    <div aria-live="polite" className="space-y-2 rounded-md bg-muted/40 p-3">
                      <p className="text-sm font-medium">
                        {t(preflight.result.ready ? "wizard.checkPassed" : "wizard.checkBlocked")}
                      </p>
                      <ul className="space-y-2">
                        {preflight.result.checks.map((check) => (
                          <li key={check.step} className="text-xs">
                            <div className="flex items-center gap-2">
                              {check.status === "passed" ? (
                                <CheckCircle2
                                  className="size-4 shrink-0 text-primary"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Circle className="size-4 shrink-0" aria-hidden="true" />
                              )}
                              <span>{t(`preflight.steps.${check.step}`)}</span>
                              <Badge variant="outline">
                                {t(`preflight.status.${check.status}`)}
                              </Badge>
                            </div>
                            {check.status === "failed" ? (
                              <p className="mt-1 text-destructive">
                                {t(`preflight.codes.${check.code}`)}
                                {check.file ? (
                                  <span className="ml-1 break-all font-mono">{check.file}</span>
                                ) : null}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </FieldGroup>
              ) : step === 1 ? (
                <FieldGroup className="gap-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {renderField("label")}
                    {renderField("lifetimeMinutes")}
                  </div>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={String(request.lifetimeMinutes)}
                    aria-label={t("wizard.lifetimePresets")}
                    disabled={Boolean(busy)}
                    onValueChange={(value) => {
                      if (value) editField("lifetimeMinutes", Number(value))
                    }}
                  >
                    {[60, 120, 240].map((minutes) => (
                      <ToggleGroupItem key={minutes} value={String(minutes)}>
                        {t("wizard.minutes", { minutes })}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <FieldSet className="gap-3">
                    <FieldLegend variant="label">{t("wizard.images")}</FieldLegend>
                    <FieldDescription>{t("wizard.imagesHint")}</FieldDescription>
                    <FieldGroup className="gap-4">
                      {ENVIRONMENT_FIELDS.filter((field) => field.endsWith("Image")).map(
                        renderField
                      )}
                    </FieldGroup>
                  </FieldSet>
                  {renderField("signalingUrl")}
                </FieldGroup>
              ) : (
                <div className="space-y-4">
                  <Alert role="note">
                    <CheckCircle2 aria-hidden="true" />
                    <AlertTitle>{t("wizard.checkPassed")}</AlertTitle>
                    <AlertDescription>
                      {t("wizard.reviewHint")}
                      {preflight?.result.actorLogin ? (
                        <p>{t("wizard.account", { login: preflight.result.actorLogin })}</p>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                  <dl className="space-y-3">
                    {FIELDS.map((field) => (
                      <div key={field} className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
                        <dt className="text-xs text-muted-foreground">{t(`fields.${field}`)}</dt>
                        <dd className="break-all text-xs">
                          {field === "lifetimeMinutes"
                            ? t("wizard.minutes", { minutes: request.lifetimeMinutes })
                            : request[field]}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-xs text-muted-foreground">{t("savedConfiguration")}</p>
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                {step > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => goToStep(step - 1)}
                  >
                    <ChevronLeft aria-hidden="true" />
                    {t("wizard.back")}
                  </Button>
                ) : null}
                <Button type="submit" disabled={Boolean(busy) || checking || loading}>
                  {checking || busy === "create" ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : step < 2 ? (
                    <ArrowRight aria-hidden="true" />
                  ) : null}
                  {busy === "create"
                    ? t("creating")
                    : checking
                      ? t("wizard.checking")
                      : step === 0
                        ? t("wizard.checkContinue")
                        : step === 1
                          ? t("wizard.reviewContinue")
                          : t("create")}
                </Button>
              </div>
            </form>
          )}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {loading ? (
            <p role="status">{t("loading")}</p>
          ) : leases.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("empty")}</p>
          ) : null}
          <Button
            variant="outline"
            disabled={Boolean(busy) || loading}
            onClick={() =>
              void run("refreshAll", async () => {
                const generation = epoch.current
                const current = await githubRunnerClient.list()
                if (generation !== epoch.current) return
                setLeases(current)
                await refreshBatch(
                  current.map((lease) => lease.id),
                  generation,
                  false
                )
              })
            }
          >
            {t("refreshAll")}
          </Button>
          <ul className="space-y-3">
            {leases.map((lease) => {
              const url = runnerRunUrl(lease)
              const linked = runnerHostLinks()[lease.id]
              return (
                <li
                  key={lease.id}
                  className="space-y-2 rounded-md border p-3"
                  aria-label={lease.label}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{lease.label}</span>
                    <Badge
                      role="status"
                      variant={lease.state === "ready" ? "secondary" : "outline"}
                    >
                      {t(`state.${lease.state}`)}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {lease.repository} · {lease.workflowRef}
                  </p>
                  <p className="text-xs text-muted-foreground">{t(`stateHelp.${lease.state}`)}</p>
                  {lease.expiresAt ? (
                    <p className="text-xs">
                      {t("expires", { time: new Date(lease.expiresAt).toLocaleString() })}
                    </p>
                  ) : null}
                  {lease.state === "stopping" ? (
                    <p className="text-xs">{t("stopPending")}</p>
                  ) : null}
                  {lease.error ? (
                    <p className="text-xs text-destructive">{t("leaseError")}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run(lease.id, async () => {
                          await refreshLease(lease.id, epoch.current, true)
                        })
                      }
                    >
                      {t("refresh")}
                    </Button>
                    {lease.state === "ready" ? (
                      <Button
                        size="sm"
                        disabled={Boolean(busy) || Boolean(pairing)}
                        onClick={() => void run(lease.id, () => connect(lease))}
                      >
                        {linked && linked === activeHostId ? t("reconnect") : t("connect")}
                      </Button>
                    ) : null}
                    {lease.state !== "stopped" && lease.state !== "failed" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run(lease.id, async () => {
                            const generation = epoch.current
                            pairingEpoch.current += 1
                            setPairing(undefined)
                            const stopped = await githubRunnerClient.cancel(lease.id)
                            if (generation === epoch.current) updateLease(stopped)
                          })
                        }
                      >
                        {t("stop")}
                      </Button>
                    ) : null}
                    {url ? (
                      <a
                        className="self-center text-xs underline"
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t("viewRun")}
                      </a>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t("persistence")}</p>
          {pairing ? (
            <div className="space-y-2 rounded-md border p-3">
              <PairStep
                key={pairing.lease.id}
                webMode
                autoSubmit
                prefilledPairPayload={pairing.payload}
                expectedFingerprint={pairing.fingerprint}
                persistPairing={persistPairing}
                onPaired={() => setPairing(undefined)}
              />
              <Button
                variant="ghost"
                onClick={() => {
                  pairingEpoch.current += 1
                  setPairing(undefined)
                }}
              >
                {t("closePairing")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {dialog}
    </SettingsBlock>
  )
}

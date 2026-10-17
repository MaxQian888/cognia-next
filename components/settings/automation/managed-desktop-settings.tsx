"use client"

import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react"
import { useAccountStore } from "@/stores/account/account-store"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  managedDesktopClient,
  managedDesktopTargetConfig,
  subscribeManagedDesktopTargetChanges,
  openManagedDesktop,
  managedDesktopErrorKey,
  type ManagedDesktopConfigSummary,
  type ManagedDesktopQuote,
  type ManagedDesktopResource,
  type ManagedDesktopTarget,
} from "@/lib/automation/managed-desktop-client"
import { runSandboxConnectionOperation } from "@/lib/sandbox/connection-lifecycle"
import {
  defaultSandboxCapabilities,
  hasCurrentManagedDesktopQualification,
} from "@/lib/sandbox/connection-capabilities"
import { managedDesktopLifecycleState } from "@/lib/sandbox/e2b-adapter"
import { SandboxDesktopViewer } from "./sandbox-desktop-viewer"
import { ManagedDesktopHandoff } from "./managed-desktop-handoff"
import { ManagedDesktopCleanup } from "./managed-desktop-cleanup"
import type { SandboxConnectionRow } from "@/types/sandbox"

const LOCAL: ManagedDesktopTarget = { kind: "local" }

/** Safe Host configuration projection. Provider keys are configured on the Host. */
export function ManagedDesktopSettings({ target = LOCAL }: { target?: ManagedDesktopTarget }) {
  const owner = useAccountStore((state) => state.unlockedAccountId)
  const locked = useAccountStore((state) => state.locked)
  const hostConfig = useSyncExternalStore(
    subscribeManagedDesktopTargetChanges,
    () => managedDesktopTargetConfig(target),
    () => undefined
  )
  if (locked || !owner || (target.kind === "remote" && !hostConfig)) return null
  const identity = JSON.stringify([
    owner,
    target.kind === "local" ? "local" : target.hostId,
    hostConfig,
  ])
  return <ManagedDesktopSettingsBody key={identity} target={target} />
}

function ManagedDesktopSettingsBody({ target }: { target: ManagedDesktopTarget }) {
  const t = useTranslations("settings.managedDesktops")
  const [configs, setConfigs] = useState<ManagedDesktopConfigSummary[]>([])
  const [resources, setResources] = useState<ManagedDesktopResource[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const pending = useRef(false)

  async function reload() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      const [nextConfigs, nextResources] = await Promise.all([
        managedDesktopClient.listConfigs(target),
        managedDesktopClient.list(target),
      ])
      if (!alive.current) return
      setConfigs(nextConfigs)
      setResources(nextResources)
      setError(undefined)
    } catch (cause) {
      if (alive.current) setError(managedDesktopErrorKey(cause))
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }

  useEffect(() => {
    alive.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial Host read only; never provisions resources
    void reload()
    return () => {
      alive.current = false
    }
    // The keyed parent remounts for every target change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section className="space-y-3 border-t pt-4" aria-label={t("title")}>
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      <p className="text-xs text-muted-foreground">{t("hostConfig")}</p>
      <p
        className="text-xs text-muted-foreground"
        data-dormant="managed-desktop-handoff-and-automation"
      >
        {t("dormant")}
      </p>
      <p className="text-xs text-muted-foreground">{t("manual")}</p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      {!busy && !error && configs.length === 0 ? <p className="text-xs">{t("empty")}</p> : null}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void reload()}>
        {busy ? t("refreshing") : t("load")}
      </Button>
      <ManagedDesktopCleanup />
      {configs.map((config) => (
        <ProviderSettings
          key={config.id}
          config={config}
          target={target}
          resources={resources.filter(
            (resource) => resource.providerConfigId === config.id && resource.state !== "destroyed"
          )}
          onChanged={() => void reload()}
        />
      ))}
    </section>
  )
}

function connectionRow(
  config: ManagedDesktopConfigSummary,
  target: ManagedDesktopTarget,
  resource?: ManagedDesktopResource
): SandboxConnectionRow {
  return {
    id: resource?.id ?? config.id,
    name: config.id,
    provider: "e2b",
    driver: "computer-server",
    config: {
      provider: "e2b",
      target,
      providerConfigId: config.id,
      qualification: config.qualification,
      qualificationEvidenceVersion: config.qualificationEvidenceVersion,
      workloadIsolationRevision: config.workloadIsolationRevision,
      egressEnforcement: config.egressEnforcement,
      ...(resource ? { desktopId: resource.id, generation: resource.generation } : {}),
    },
    state: resource ? managedDesktopLifecycleState(resource.state) : "uninitialized",
    capabilities: defaultSandboxCapabilities("e2b", "computer-server"),
    lastHealthStatus: "unknown",
    createdAt: resource?.createdAt ?? 0,
    updatedAt: resource?.updatedAt ?? 0,
  }
}

function ProviderSettings({
  config,
  target,
  resources,
  onChanged,
}: {
  config: ManagedDesktopConfigSummary
  target: ManagedDesktopTarget
  resources: ManagedDesktopResource[]
  onChanged: () => void
}) {
  const t = useTranslations("settings.managedDesktops")
  const [minutes, setMinutes] = useState(String(Math.min(60, config.maxLifetimeSeconds / 60)))
  const [quote, setQuote] = useState<ManagedDesktopQuote>()
  const [busy, setBusy] = useState(false)
  const [authorizing, setAuthorizing] = useState(false)
  const [error, setError] = useState<string>()
  const [prepared, setPrepared] = useState(false)
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const qualified = hasCurrentManagedDesktopQualification(config)
  const lifetimeSeconds = Number(minutes) * 60
  const validLifetime =
    Number.isSafeInteger(lifetimeSeconds) &&
    lifetimeSeconds > 0 &&
    lifetimeSeconds <= Math.min(3600, config.maxLifetimeSeconds)
  const money = (micros: number) => `${quote?.currency ?? "USD"} ${(micros / 1_000_000).toFixed(4)}`

  async function action(work: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await work()
    } catch (cause) {
      if (alive.current) setError(managedDesktopErrorKey(cause))
    } finally {
      pending.current = false
      if (alive.current) {
        setBusy(false)
        setAuthorizing(false)
      }
    }
  }
  async function billed(actionName: "create" | "prepareTemplate") {
    if (!quote || quote.expiresAt <= Date.now() || quote.lifetimeSeconds !== lifetimeSeconds) {
      setQuote(undefined)
      throw new Error("quote_expired")
    }
    setAuthorizing(true)
    const authorization = await managedDesktopClient.authorize(
      target,
      config.id,
      quote.id,
      actionName
    )
    if (!alive.current) return
    if (authorization.expiresAt <= Date.now() || quote.expiresAt <= Date.now()) {
      setQuote(undefined)
      throw new Error("authorization_expired")
    }
    const request = {
      providerConfigId: config.id,
      quoteId: quote.id,
      authorizationId: authorization.id,
      idempotencyKey: crypto.randomUUID(),
    }
    // A consumed authorization or unknown create result is never retried automatically.
    setQuote(undefined)
    if (actionName === "create")
      await runSandboxConnectionOperation(connectionRow(config, target), "create", {
        managedCreation: request,
      })
    else {
      await managedDesktopClient.prepareTemplate(target, request)
      if (alive.current) setPrepared(true)
    }
    if (alive.current) onChanged()
  }
  return (
    <div className="space-y-3 border-l-2 pl-3">
      <div className="flex flex-wrap gap-2">
        <span className="text-sm font-medium">{config.id}</span>
        <Badge variant="outline">{qualified ? t("qualified") : t("unqualified")}</Badge>
      </div>
      <p className="text-xs">{t("spec", { cpu: config.cpuCount, memory: config.memoryMb })}</p>
      <p className="text-xs text-muted-foreground">
        {t("attestation", {
          isolation: t(`isolation.${config.isolationTier}`),
          egress: t(`egress.${config.egressTier}`),
          enforcement: t(`enforcement.${qualified ? "provider-and-guest-kernel" : "unverified"}`),
        })}
      </p>
      {config.reason && config.reason !== "managed_desktop_unqualified" ? (
        <p className="text-xs text-muted-foreground">
          {t(`errors.${managedDesktopErrorKey(config.reason)}`)}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t("limits", {
          count: config.maxConcurrent,
          minutes: config.maxLifetimeSeconds / 60,
          idle: config.idleTimeoutSeconds / 60,
        })}
      </p>
      {config.templateState ? (
        <p className="text-xs">
          {t("template", { state: t(`templateState.${config.templateState}`) })}
        </p>
      ) : null}
      <Label htmlFor={`managed-desktop-lifetime-${config.id}`}>{t("lifetime")}</Label>
      <Input
        id={`managed-desktop-lifetime-${config.id}`}
        type="number"
        min={1}
        max={Math.min(60, config.maxLifetimeSeconds / 60)}
        value={minutes}
        disabled={busy}
        onChange={(event) => {
          setMinutes(event.target.value)
          setQuote(undefined)
        }}
      />
      {!validLifetime ? (
        <p role="alert" className="text-xs text-destructive">
          {t("invalidLifetime")}
        </p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !validLifetime}
        onClick={() =>
          void action(async () => {
            const next = await managedDesktopClient.quote(target, config.id, lifetimeSeconds)
            if (alive.current) setQuote(next)
          })
        }
      >
        {t("quote")}
      </Button>
      {quote ? (
        <div className="space-y-1 text-xs">
          <p>{t("hourly", { cost: money(quote.hourlyRateMicros) })}</p>
          <p>{t("maximum", { cost: money(quote.maximumComputeCostMicros) })}</p>
          <p className="text-muted-foreground">{t("costs")}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("quoteNeeded")}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !quote || !validLifetime || !config.canPrepareTemplate}
          onClick={() => void action(() => billed("prepareTemplate"))}
        >
          {t("prepare")}
        </Button>
        <Button
          size="sm"
          disabled={
            busy || !quote || !validLifetime || !config.canCreate || !config.enabled || !qualified
          }
          onClick={() => void action(() => billed("create"))}
        >
          {t("create")}
        </Button>
      </div>
      {authorizing ? (
        <p role="status" className="text-xs">
          {t("authorizing")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      {prepared ? (
        <p role="status" className="text-xs">
          {t("prepared")}
        </p>
      ) : null}
      <ManagedDesktopHandoff target={target} config={config} />
      {resources.map((resource) => (
        <div
          key={`${resource.id}:${resource.generation}`}
          className="space-y-1 border-t pt-2 text-xs"
        >
          <p>
            {t("resource", { id: resource.id })} · {t(`state.${resource.state}`)}
          </p>
          <p>{t("deadline", { deadline: new Date(resource.deadlineAt).toISOString() })}</p>
          {resource.qualification === "smoke" ? (
            <p className="text-xs text-muted-foreground">{t("smokeResource")}</p>
          ) : null}
          <ManagedResourceViewer
            target={target}
            resource={resource}
            row={connectionRow(config, target, resource)}
            qualified={config.guiQualified === true && qualified}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await runSandboxConnectionOperation(
                    connectionRow(config, target, resource),
                    "health"
                  )
                  if (alive.current) onChanged()
                })
              }
            >
              {t("health")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await runSandboxConnectionOperation(
                    connectionRow(config, target, resource),
                    "delete"
                  )
                  if (alive.current) onChanged()
                })
              }
            >
              {t("delete")}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Reuses the existing viewer with an immutable Host/resource binding. */
function ManagedResourceViewer({
  target,
  resource,
  qualified,
  row,
}: {
  target: ManagedDesktopTarget
  resource: ManagedDesktopResource
  qualified: boolean
  row: SandboxConnectionRow
}) {
  const t = useTranslations("settings.managedDesktops")
  const [opened, setOpened] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string>()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const targetKind = target.kind
  const hostId = target.kind === "remote" ? target.hostId : undefined
  const { id, generation } = resource
  const openDesktop = useCallback(
    () =>
      openManagedDesktop(
        targetKind === "remote" ? { kind: "remote", hostId: hostId! } : { kind: "local" },
        { desktopId: id, generation }
      ),
    [targetKind, hostId, id, generation]
  )
  const enabled =
    qualified && resource.state === "running" && resource.qualification === "qualified"
  async function toggle() {
    if (opened) {
      setOpened(false)
      return
    }
    if (!enabled || connecting) return
    setConnecting(true)
    setError(undefined)
    try {
      await runSandboxConnectionOperation(row, "connect")
      if (alive.current) setOpened(true)
    } catch (cause) {
      if (alive.current) setError(managedDesktopErrorKey(cause))
    } finally {
      if (alive.current) setConnecting(false)
    }
  }
  return (
    <div className="space-y-2">
      {error ? <p role="alert">{t(`errors.${error}`)}</p> : null}
      {!qualified ? <p data-dormant="managed-desktop-control">{t("guiDormant")}</p> : null}
      <Button
        size="sm"
        variant="outline"
        disabled={!enabled || connecting}
        onClick={() => void toggle()}
      >
        {opened ? t("closeDesktop") : t("openDesktop")}
      </Button>
      {opened && enabled ? (
        <SandboxDesktopViewer connectionId={id} enabled openDesktop={openDesktop} />
      ) : null}
    </div>
  )
}

"use client"

import { useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useAccountStore } from "@/stores/account/account-store"
import {
  managedDesktopHandoffClient,
  managedDesktopHandoffErrorKey,
  type ManagedDesktopDeliverySummary,
  type ManagedDesktopHandoffMode,
  type ManagedDesktopHandoffProposal,
} from "@/lib/automation/managed-desktop-handoff-client"
import type {
  ManagedDesktopConfigSummary,
  ManagedDesktopTarget,
} from "@/lib/automation/managed-desktop-client"

interface Props {
  target: ManagedDesktopTarget
  config: ManagedDesktopConfigSummary
}

/** User-requested preparation only. No agent suggestion, mount or form submit can spend. */
export function ManagedDesktopHandoff(props: Props) {
  const account = useAccountStore((state) => (state.locked ? null : state.unlockedAccountId))
  const targetId = props.target.kind === "remote" ? props.target.hostId : "local"
  return <HandoffForm key={`${account}:${targetId}:${props.config.id}`} {...props} />
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseArgv(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) &&
      (parsed.length === 0 ||
        (parsed.length === 3 &&
          parsed[0] === "npm" &&
          parsed[1] === "run" &&
          typeof parsed[2] === "string" &&
          /^[A-Za-z0-9:_-]+$/.test(parsed[2])))
      ? parsed
      : null
  } catch {
    return null
  }
}

function HandoffForm({ target, config }: Props) {
  const t = useTranslations("settings.managedDesktops.handoff")
  const cost = useTranslations("settings.managedDesktops")
  const id = useId()
  const [deliveries, setDeliveries] = useState<ManagedDesktopDeliverySummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [deliveryId, setDeliveryId] = useState("")
  const [mode, setMode] = useState<ManagedDesktopHandoffMode>("commit")
  const [criteria, setCriteria] = useState("")
  const [files, setFiles] = useState("")
  const [argv, setArgv] = useState("[]")
  const [minutes, setMinutes] = useState(String(Math.min(60, config.maxLifetimeSeconds / 60)))
  const [proposal, setProposal] = useState<ManagedDesktopHandoffProposal>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const selected = deliveries.find((delivery) => delivery.id === deliveryId)
  const lifetimeSeconds = Number(minutes) * 60
  const parsedArgv = parseArgv(argv)
  const valid = Boolean(
    selected?.modes.includes(mode) &&
    parsedArgv &&
    lines(criteria).length &&
    Number.isSafeInteger(lifetimeSeconds) &&
    lifetimeSeconds > 0 &&
    lifetimeSeconds <= Math.min(3600, config.maxLifetimeSeconds)
  )

  async function perform(action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    setProposal(undefined)
    try {
      await action()
    } catch (cause) {
      if (alive.current) setError(managedDesktopHandoffErrorKey(cause))
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }

  async function load() {
    await perform(async () => {
      const next = await managedDesktopHandoffClient.deliveries(target)
      if (!alive.current) return
      setDeliveries(next)
      setLoaded(true)
      setDeliveryId("")
    })
  }

  async function prepare() {
    if (!valid || !selected || !parsedArgv) return
    await perform(async () => {
      const next = await managedDesktopHandoffClient.prepare(target, {
        deliveryId: selected.id,
        deliveryRevision: selected.revision,
        mode,
        providerConfigId: config.id,
        lifetimeSeconds,
        criteria: lines(criteria),
        acceptanceFiles: lines(files),
        argv: parsedArgv,
      })
      if (alive.current) setProposal(next)
    })
  }

  const money = (micros: number) =>
    `${proposal?.quote.currency ?? "USD"} ${(micros / 1_000_000).toFixed(4)}`
  return (
    <section aria-label={t("title")} className="space-y-3 border-t pt-3">
      <h4 className="text-sm font-medium">{t("title")}</h4>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      <p className="text-xs text-muted-foreground">{t("sourceScope")}</p>
      <p className="text-xs text-muted-foreground" data-dormant="managed-desktop-handoff-execution">
        {t("dormant")}
      </p>
      <p
        className="text-xs text-muted-foreground"
        data-dormant="managed-desktop-live-preview-cross-host-project-auto"
      >
        {t("unsupported")}
      </p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
        {t("load")}
      </Button>
      {loaded && deliveries.length === 0 ? <p className="text-xs">{t("empty")}</p> : null}
      {deliveries.length > 0 ? (
        <fieldset disabled={busy} className="space-y-3" onChange={() => setProposal(undefined)}>
          <Label htmlFor={`${id}-delivery`}>{t("delivery")}</Label>
          <NativeSelect
            id={`${id}-delivery`}
            value={deliveryId}
            onChange={(event) => {
              setDeliveryId(event.target.value)
              const next = deliveries.find((item) => item.id === event.target.value)
              setMode(next?.modes[0] ?? "commit")
            }}
          >
            <NativeSelectOption value="">{t("chooseDelivery")}</NativeSelectOption>
            {deliveries.map((delivery) => (
              <NativeSelectOption key={delivery.id} value={delivery.id}>
                {t("deliveryOption", {
                  id: delivery.id,
                  revision: delivery.revision,
                  commit: delivery.commit,
                })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Label htmlFor={`${id}-mode`}>{t("mode")}</Label>
          <NativeSelect
            id={`${id}-mode`}
            value={mode}
            onChange={(event) => setMode(event.target.value as ManagedDesktopHandoffMode)}
          >
            <NativeSelectOption value="commit" disabled={!selected?.modes.includes("commit")}>
              {t("commit")}
            </NativeSelectOption>
            <NativeSelectOption value="bundle" disabled={!selected?.modes.includes("bundle")}>
              {t("bundle")}
            </NativeSelectOption>
          </NativeSelect>
          <Label htmlFor={`${id}-criteria`}>{t("criteria")}</Label>
          <Textarea
            id={`${id}-criteria`}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
          />
          <Label htmlFor={`${id}-files`}>{t("files")}</Label>
          <Textarea
            id={`${id}-files`}
            value={files}
            onChange={(event) => setFiles(event.target.value)}
            aria-describedby={`${id}-files-help`}
          />
          <p id={`${id}-files-help`} className="text-xs text-muted-foreground">
            {t("filesHelp")}
          </p>
          <Label htmlFor={`${id}-argv`}>{t("argv")}</Label>
          <Textarea
            id={`${id}-argv`}
            value={argv}
            onChange={(event) => setArgv(event.target.value)}
            aria-describedby={`${id}-argv-help`}
          />
          <p id={`${id}-argv-help`} className="text-xs text-muted-foreground">
            {t("argvHelp")}
          </p>
          <Label htmlFor={`${id}-minutes`}>{t("lifetime")}</Label>
          <Input
            id={`${id}-minutes`}
            type="number"
            min={1}
            max={Math.min(60, config.maxLifetimeSeconds / 60)}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
          <Button size="sm" variant="outline" disabled={!valid} onClick={() => void prepare()}>
            {t("prepare")}
          </Button>
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(error)}
        </p>
      ) : null}
      {proposal ? (
        <div role="status" className="space-y-1 text-xs">
          <p>{t("prepared", { commit: proposal.commit, revision: proposal.deliveryRevision })}</p>
          <p>{cost("spec", { cpu: proposal.quote.cpuCount, memory: proposal.quote.memoryMb })}</p>
          <p>{cost("hourly", { cost: money(proposal.quote.hourlyRateMicros) })}</p>
          <p>{cost("maximum", { cost: money(proposal.quote.maximumComputeCostMicros) })}</p>
          <p>{cost("costs")}</p>
          <p>{t("expires", { at: new Date(proposal.expiresAt).toISOString() })}</p>
        </div>
      ) : null}
      <Button size="sm" disabled>
        {t("start")}
      </Button>
    </section>
  )
}

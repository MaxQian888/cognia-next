"use client"

/**
 * The body of the Host installer sheet (ADR-0235 P5): one bootstrap session
 * against a saved SSH profile, from "connect" to a paired Host.
 *
 * Mounted only while the sheet is open, so closing the sheet unmounts
 * {@link useHostInstall} and closes the native session.
 *
 * Nothing is changed on the machine until the user picks a plan and presses
 * its button. The plan's copy above that button is the consent: which machine
 * and account, the steps, the disk, the user scope, whether the service
 * survives logout (linger) and that the installer can do nothing the account's
 * own shell could not (ADR-0162). Uninstall deletes data only when the
 * machine's name is typed.
 *
 * Every phase change moves focus to the phase heading and the running stage
 * is announced, so a keyboard or screen-reader user follows the same steps.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleXIcon,
  LoaderCircleIcon,
  PlugZapIcon,
  SettingsIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { PairFailurePanel } from "@/components/connectivity/pair/pair-failure-panel"
import { SshHostKeyDialog } from "@/components/settings/terminal/ssh-host-key-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import {
  useHostInstall,
  type HostInstallDeps,
  type HostInstallFailure,
  type HostInstallPhase,
} from "@/hooks/host-installer/use-host-install"
import type { InspectionView, OpenedView, PlanKind } from "@/lib/host-installer/client"
import {
  failureCopy,
  orderedOffers,
  type NextStep,
  type StageProgress,
} from "@/lib/host-installer/flow"
import { formatBytes } from "@/lib/native/model-download-helpers"
import { hostChannelFor } from "@/lib/remote-host/host-update-channel"
import { forgetSshHostKey } from "@/lib/terminal/ssh-host-key"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import { sshHostSettingsHref } from "@/lib/terminal/terminal-settings-link"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { useSettingsStore } from "@/stores/settings"

import { DeviceFactList, DeviceFactRow, shortenFingerprint } from "../device-visuals"

export interface HostInstallFlowProps {
  profile: SshHostProfile
  profiles: readonly SshHostProfile[]
  /** Close the sheet. */
  onClose: () => void
  /** Test seams. */
  deps?: HostInstallDeps
  forgetHostKey?: typeof forgetSshHostKey
}

export function HostInstallFlow({
  profile,
  profiles,
  onClose,
  deps,
  forgetHostKey = forgetSshHostKey,
}: HostInstallFlowProps) {
  const t = useTranslations("devices.hostInstall")
  const install = useHostInstall(profile, profiles, deps)
  const { phase } = install

  // Focus follows the step, so the next thing read is what just changed.
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [phase.kind])

  const heading = t(`heading.${phase.kind}`, { name: profile.name })

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6"
      data-testid="host-install-flow"
      data-phase={phase.kind}
    >
      <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
        {heading}
      </h3>
      <PhaseBody
        phase={phase}
        profile={profile}
        install={install}
        onClose={onClose}
        forgetHostKey={forgetHostKey}
      />
      {install.dialog}
    </div>
  )
}

function PhaseBody({
  phase,
  profile,
  install,
  onClose,
  forgetHostKey,
}: {
  phase: HostInstallPhase
  profile: SshHostProfile
  install: ReturnType<typeof useHostInstall>
  onClose: () => void
  forgetHostKey: typeof forgetSshHostKey
}) {
  const t = useTranslations("devices.hostInstall")
  const tSsh = useTranslations("devices.ssh")
  switch (phase.kind) {
    case "idle":
      return (
        <div className="space-y-3" data-testid="host-install-intro">
          <p className="text-sm">{t("intro.body", { name: profile.name })}</p>
          <p className="text-xs text-muted-foreground">{t("intro.cost")}</p>
          <Button
            size="sm"
            onClick={() => void install.connect()}
            data-testid="host-install-connect"
          >
            <PlugZapIcon className="size-3.5" />
            {t("intro.connect")}
          </Button>
        </div>
      )
    case "invalid_profile":
      return (
        <Alert variant="destructive" data-testid="host-install-invalid-profile">
          <AlertTitle>{t("invalidProfile.title")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{tSsh(`probe.invalidReason.${phase.reason}`)}</p>
            <Button asChild size="sm" variant="outline">
              <Link href={sshHostSettingsHref(profile.id)}>
                <SettingsIcon className="size-3.5" />
                {t("invalidProfile.edit")}
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )
    case "connecting":
    case "inspecting":
      return (
        <div className="space-y-3">
          {phase.kind === "inspecting" ? <HostKeyLine opened={phase.opened} /> : null}
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
            data-testid="host-install-busy"
          >
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
            {t(`status.${phase.kind}`, { name: profile.name })}
          </p>
        </div>
      )
    case "ready":
      return (
        // Keyed by the inspection: a fresh one may offer something else, so
        // no choice made on the last one carries over.
        <PlanChooser
          key={phase.inspection.inspectionId}
          opened={phase.opened}
          inspection={phase.inspection}
          profile={profile}
          onRun={(choice) => void install.run(choice)}
        />
      )
    case "running":
      return (
        <div className="space-y-3">
          <StageList progress={phase.progress} />
          <p className="text-xs text-muted-foreground">{t("progress.keepOpen")}</p>
        </div>
      )
    case "paired":
      return (
        <div className="space-y-3" data-testid="host-install-paired">
          <StageList progress={phase.progress} />
          <Alert>
            <CheckCircle2Icon className="size-4" />
            <AlertTitle>{t("done.pairedTitle", { label: phase.host.label })}</AlertTitle>
            <AlertDescription>
              {phase.host.alwaysOn ? t("done.pairedAlwaysOn") : t("done.pairedBody")}
            </AlertDescription>
          </Alert>
          <Button size="sm" onClick={onClose} data-testid="host-install-close">
            {t("done.close")}
          </Button>
        </div>
      )
    case "uninstalled":
      return (
        <Uninstalled
          profile={profile}
          dataDeleted={phase.dataDeleted}
          hostname={phase.inspection.hostname}
          onClose={onClose}
        />
      )
    case "failed":
      return (
        <Failed
          phase={phase}
          profile={profile}
          install={install}
          onClose={onClose}
          forgetHostKey={forgetHostKey}
        />
      )
  }
}

/** Whether this connection learned the host key or matched the trusted one. */
function HostKeyLine({ opened }: { opened: OpenedView }) {
  const t = useTranslations("devices.hostInstall")
  const fingerprint = shortenFingerprint(opened.hostKeyFingerprint) ?? opened.hostKeyFingerprint
  return (
    <p className="text-xs text-muted-foreground" data-testid="host-install-host-key">
      {t(opened.hostKeyStatus === "learned" ? "hostKey.learned" : "hostKey.verified", {
        fingerprint,
      })}
    </p>
  )
}

function MachineFacts({ inspection }: { inspection: InspectionView }) {
  const t = useTranslations("devices.hostInstall")
  const existing = inspection.existing
  return (
    <DeviceFactList>
      <DeviceFactRow label={t("facts.machine")} mono>
        {`${inspection.user}@${inspection.hostname}`}
      </DeviceFactRow>
      <DeviceFactRow label={t("facts.platform")} mono>
        {inspection.target}
      </DeviceFactRow>
      <DeviceFactRow label={t("facts.service")}>
        {t(`serviceManager.${inspection.serviceManager}`)}
      </DeviceFactRow>
      <DeviceFactRow label={t("facts.dataDir")} mono>
        {inspection.dataDir}
      </DeviceFactRow>
      <DeviceFactRow label={t("facts.freeSpace")}>
        {inspection.freeBytes === null ? t("facts.unknown") : formatBytes(inspection.freeBytes)}
      </DeviceFactRow>
      {inspection.os === "linux" ? (
        <DeviceFactRow label={t("facts.glibc")}>
          {inspection.glibc ?? t("facts.unknown")}
        </DeviceFactRow>
      ) : null}
      <DeviceFactRow label={t("facts.existing")}>
        <span data-testid="host-install-existing">
          {existing === null || !existing.installed
            ? t("existing.none")
            : t(
                !existing.running
                  ? "existing.stopped"
                  : existing.ready === false
                    ? "existing.notReady"
                    : "existing.running",
                { version: existing.version ?? t("existing.versionUnknown") }
              )}
          {existing?.installed && !existing.masterKeyPresent ? (
            <span className="block text-[11px] font-normal text-muted-foreground">
              {t("existing.noMasterKey")}
            </span>
          ) : null}
        </span>
      </DeviceFactRow>
    </DeviceFactList>
  )
}

interface ChosenRun {
  plan: PlanKind
  channel: string
  label: string
  alwaysOn: boolean
  connectAfter: boolean
  deleteDataConfirmation?: string
}

function PlanChooser({
  opened,
  inspection,
  profile,
  onRun,
}: {
  opened: OpenedView
  inspection: InspectionView
  profile: SshHostProfile
  onRun: (choice: ChosenRun) => void
}) {
  const t = useTranslations("devices.hostInstall")
  const offers = useMemo(() => orderedOffers(inspection.offers), [inspection.offers])
  const [plan, setPlan] = useState<PlanKind | null>(offers[0] ?? null)
  const [label, setLabel] = useState(profile.name)
  const [alwaysOn, setAlwaysOn] = useState(true)
  const [connectAfter, setConnectAfter] = useState(false)
  const [deleteData, setDeleteData] = useState(false)
  const [typedName, setTypedName] = useState("")
  const deviceChannel = useSettingsStore((s) => s.settings?.updateCenter?.channel ?? "stable")
  const channel = hostChannelFor(deviceChannel)

  const nameMatches = typedName.trim() === inspection.hostname
  const blocked = plan === null || (plan === "uninstall" && deleteData && !nameMatches)

  const submit = useCallback(() => {
    if (!plan || blocked) return
    onRun({
      plan,
      channel,
      label,
      alwaysOn,
      connectAfter: !alwaysOn && connectAfter,
      ...(plan === "uninstall" && deleteData ? { deleteDataConfirmation: typedName.trim() } : {}),
    })
  }, [alwaysOn, blocked, channel, connectAfter, deleteData, label, onRun, plan, typedName])

  const values = {
    user: inspection.user,
    hostname: inspection.hostname,
    target: inspection.target,
    channel: t(`channel.${channel}`),
    service: t(`serviceManager.${inspection.serviceManager}`),
    dataDir: inspection.dataDir,
  }

  return (
    <div className="space-y-4" data-testid="host-install-ready">
      <HostKeyLine opened={opened} />
      <MachineFacts inspection={inspection} />

      {inspection.notices.map((notice) => (
        <Alert key={notice} data-testid={`host-install-notice-${notice}`}>
          <TriangleAlertIcon className="size-4" />
          <AlertTitle>{t(`notice.${notice}.title`)}</AlertTitle>
          <AlertDescription>
            {t(`notice.${notice}.body`, { user: inspection.user })}
          </AlertDescription>
        </Alert>
      ))}

      {offers.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="host-install-no-offers">
          {t("plan.none")}
        </p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium">{t("plan.legend")}</legend>
          <RadioGroup
            value={plan ?? undefined}
            onValueChange={(value) => setPlan(value as PlanKind)}
          >
            {offers.map((offer) => (
              <div key={offer} className="flex items-start gap-2">
                <RadioGroupItem
                  value={offer}
                  id={`host-install-plan-${offer}`}
                  data-testid={`host-install-plan-${offer}`}
                />
                <Label
                  htmlFor={`host-install-plan-${offer}`}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span>{t(`plan.${offer}.label`)}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {t(`plan.${offer}.body`)}
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
      )}

      {plan ? (
        <section
          className="space-y-2 rounded-md border p-3 text-xs"
          aria-labelledby="host-install-consent-title"
          data-testid="host-install-consent"
        >
          <h4 id="host-install-consent-title" className="font-medium">
            {t("consent.title", values)}
          </h4>
          <p>{t(`consent.steps.${plan}`, values)}</p>
          {plan === "fresh" || plan === "repair" ? (
            <>
              <p>{t("consent.scope", values)}</p>
              {inspection.freeBytes !== null ? (
                <p>{t("consent.disk", { free: formatBytes(inspection.freeBytes) })}</p>
              ) : null}
              {inspection.linger === false ? (
                <p data-testid="host-install-consent-linger">{t("consent.lingerOff", values)}</p>
              ) : null}
            </>
          ) : null}
          <p className="text-muted-foreground">{t("consent.shellEquivalence", values)}</p>
        </section>
      ) : null}

      {plan && plan !== "uninstall" ? (
        <div className="space-y-3" data-testid="host-install-pairing">
          <div className="space-y-1">
            <Label htmlFor="host-install-label">{t("pairing.label")}</Label>
            <Input
              id="host-install-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="flex items-start gap-2">
            <Switch
              id="host-install-always-on"
              checked={alwaysOn}
              onCheckedChange={setAlwaysOn}
              data-testid="host-install-always-on"
            />
            <Label htmlFor="host-install-always-on" className="flex flex-col items-start gap-0.5">
              <span>{t("pairing.alwaysOn")}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {t("pairing.alwaysOnHint")}
              </span>
            </Label>
          </div>
          {!alwaysOn ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id="host-install-connect-after"
                checked={connectAfter}
                onCheckedChange={(checked) => setConnectAfter(checked === true)}
              />
              <Label htmlFor="host-install-connect-after">{t("pairing.connectAfter")}</Label>
            </div>
          ) : null}
        </div>
      ) : null}

      {plan === "uninstall" ? (
        <div className="space-y-2" data-testid="host-install-uninstall-options">
          <div className="flex items-center gap-2">
            <Checkbox
              id="host-install-delete-data"
              checked={deleteData}
              onCheckedChange={(checked) => setDeleteData(checked === true)}
              data-testid="host-install-delete-data"
            />
            <Label htmlFor="host-install-delete-data">{t("uninstall.deleteData")}</Label>
          </div>
          {deleteData ? (
            <div className="space-y-1">
              <Label htmlFor="host-install-typed-name" className="text-xs font-normal">
                {t("uninstall.deleteDataHint", values)}
              </Label>
              <Input
                id="host-install-typed-name"
                value={typedName}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setTypedName(event.target.value)}
                data-testid="host-install-typed-name"
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("uninstall.keepData")}</p>
          )}
        </div>
      ) : null}

      {plan ? (
        <Button
          size="sm"
          variant={plan === "uninstall" ? "destructive" : "default"}
          disabled={blocked}
          onClick={submit}
          data-testid="host-install-run"
        >
          {t(`action.${plan}`)}
        </Button>
      ) : null}
    </div>
  )
}

const STAGE_ICON = {
  pending: CircleDashedIcon,
  running: LoaderCircleIcon,
  done: CheckCircle2Icon,
  failed: CircleXIcon,
} as const

/** The plan's stages, with the one that changed last announced. */
function StageList({ progress }: { progress: readonly StageProgress[] }) {
  const t = useTranslations("devices.hostInstall")
  if (progress.length === 0) return null
  const current =
    progress.find((entry) => entry.status === "running" || entry.status === "failed") ??
    [...progress].reverse().find((entry) => entry.status === "done") ??
    null
  return (
    <div className="space-y-2">
      <ol
        className="space-y-1.5"
        aria-label={t("progress.title")}
        data-testid="host-install-stages"
      >
        {progress.map((entry) => {
          const Icon = STAGE_ICON[entry.status]
          return (
            <li
              key={entry.stage}
              className="flex items-center gap-2 text-sm"
              data-stage={entry.stage}
              data-status={entry.status}
            >
              <Icon
                className={
                  entry.status === "running"
                    ? "size-4 animate-spin text-primary"
                    : entry.status === "done"
                      ? "size-4 text-emerald-600 dark:text-emerald-400"
                      : entry.status === "failed"
                        ? "size-4 text-destructive"
                        : "size-4 text-muted-foreground"
                }
                aria-hidden
              />
              <span>{t(`stage.${entry.stage}`)}</span>
              <span className="sr-only">{t(`stageStatus.${entry.status}`)}</span>
            </li>
          )
        })}
      </ol>
      <p className="sr-only" aria-live="polite" data-testid="host-install-announce">
        {current
          ? t("progress.announce", {
              stage: t(`stage.${current.stage}`),
              status: t(`stageStatus.${current.status}`),
            })
          : ""}
      </p>
    </div>
  )
}

function Uninstalled({
  profile,
  dataDeleted,
  hostname,
  onClose,
}: {
  profile: SshHostProfile
  dataDeleted: boolean
  hostname: string
  onClose: () => void
}) {
  const t = useTranslations("devices.hostInstall")
  // The Host this desktop filed for the machine, if any. Its pairing is
  // useless once the data is gone; with the data kept, installing again
  // brings the same Host back, so removing it stays the user's call.
  const bound = useRemoteHostStore((s) =>
    s.hosts.find((host) => host.installBinding?.profileId === profile.id)
  )
  const removeHost = useRemoteHostStore((s) => s.removeHost)
  const [removed, setRemoved] = useState<string | null>(null)
  return (
    <div className="space-y-3" data-testid="host-install-uninstalled">
      <Alert>
        <CheckCircle2Icon className="size-4" />
        <AlertTitle>{t("done.uninstalledTitle", { hostname })}</AlertTitle>
        <AlertDescription>
          {dataDeleted ? t("done.uninstalledDataDeleted") : t("done.uninstalledDataKept")}
        </AlertDescription>
      </Alert>
      {bound ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            removeHost(bound.id)
            setRemoved(bound.label)
          }}
          data-testid="host-install-forget"
        >
          {t("done.forget", { label: bound.label })}
        </Button>
      ) : null}
      {removed ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("done.forgotten", { label: removed })}
        </p>
      ) : null}
      <Button size="sm" onClick={onClose} data-testid="host-install-close">
        {t("done.close")}
      </Button>
    </div>
  )
}

function Failed({
  phase,
  profile,
  install,
  onClose,
  forgetHostKey,
}: {
  phase: Extract<HostInstallPhase, { kind: "failed" }>
  profile: SshHostProfile
  install: ReturnType<typeof useHostInstall>
  onClose: () => void
  forgetHostKey: typeof forgetSshHostKey
}) {
  const t = useTranslations("devices.hostInstall")
  const native = phase.failure.source === "installer" ? phase.failure.failure : null
  const hostKeyChange = native?.kind === "host_key_changed" ? native.change : null
  const [reviewingKey, setReviewingKey] = useState(false)

  return (
    <div className="space-y-3" data-testid="host-install-failed" data-next={phase.next}>
      <StageList progress={phase.progress} />
      <FailureBody failure={phase.failure} />
      {hostKeyChange ? (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setReviewingKey(true)}
            data-testid="host-install-review-key"
          >
            {t("next.hostKey")}
          </Button>
          <SshHostKeyDialog
            change={reviewingKey ? hostKeyChange : null}
            onDismiss={() => setReviewingKey(false)}
            onTrust={async (change) => {
              await forgetHostKey(change.host, change.port, change.knownFingerprint ?? undefined)
              setReviewingKey(false)
              await install.connect()
            }}
          />
        </>
      ) : null}
      <NextStepButton next={phase.next} install={install} onClose={onClose} />
      {native?.kind === "connect" ? (
        <Button asChild size="sm" variant="ghost">
          <Link href={sshHostSettingsHref(profile.id)}>
            <SettingsIcon className="size-3.5" />
            {t("invalidProfile.edit")}
          </Link>
        </Button>
      ) : null}
    </div>
  )
}

function NextStepButton({
  next,
  install,
  onClose,
}: {
  next: NextStep
  install: ReturnType<typeof useHostInstall>
  onClose: () => void
}) {
  const t = useTranslations("devices.hostInstall")
  const action =
    next === "retry"
      ? install.retry
      : next === "reinspect"
        ? install.reinspect
        : next === "reconnect"
          ? install.connect
          : null
  return (
    <Button
      size="sm"
      variant={action ? "default" : "outline"}
      onClick={() => (action ? void action() : onClose())}
      data-testid="host-install-next"
    >
      {t(`next.${next}`)}
    </Button>
  )
}

function FailureBody({ failure }: { failure: HostInstallFailure }) {
  const t = useTranslations("devices.hostInstall")
  if (failure.source === "pair") {
    // The pairing taxonomy is the add-host form's own; the invitation it
    // talks about was minted for this run and is never shown.
    return <PairFailurePanel failure={failure.failure} />
  }
  const copy = failureCopy(failure.failure, formatBytes)
  return (
    <Alert
      variant="destructive"
      data-testid="host-install-failure"
      data-kind={failure.failure.kind}
    >
      <AlertTitle>{t(`failure.${copy.key}`, copy.values)}</AlertTitle>
      <AlertDescription className="space-y-1">
        {copy.stage ? <p>{t("failure.during", { stage: t(`stage.${copy.stage}`) })}</p> : null}
        {copy.detail ? <FailureDetail detail={copy.detail} /> : null}
      </AlertDescription>
    </Alert>
  )
}

function FailureDetail({ detail }: { detail: string }) {
  const t = useTranslations("devices.hostInstall")
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-xs underline underline-offset-2">
        {t("failure.detail")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]">
          {detail}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

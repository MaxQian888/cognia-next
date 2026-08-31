"use client"

/**
 * Which machine this window's calls actually land on, said out loud and
 * changeable in one place.
 *
 * Activating a remote host repoints every `target: "execution"` command in the
 * companion manifest (448 of them) at another machine, and the active host is
 * session-scoped so it never survives a relaunch. Until now the only evidence
 * of that state lived inside `/devices` and in the scheduler's own host bar,
 * which answers a different question ("whose schedule is this?"). Every remote
 * development product that got this right, from VS Code Remote-SSH to
 * JetBrains Gateway to Coder, pins the current host permanently in the chrome
 * for the same reason: running a command on the wrong machine is silent, and
 * a toast that already faded is not an answer.
 *
 * One component, three mounts: the desktop status bar, the `/devices` header,
 * and the mobile console header. The popover is shared so the switch behaves
 * identically wherever it is opened from.
 *
 * Switching while work is in flight asks first. `aggregateRunState` is the
 * app-wide "is anything running" answer, and repointing the transport under a
 * live turn strands it on a machine the UI has stopped talking to.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { CheckIcon, MonitorSmartphoneIcon, ServerIcon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SITE_TONE_DOT, SITE_TONE_TEXT, type SiteTone } from "@/components/sites/site-status"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"
import { cn } from "@/lib/utils"

/**
 * Connection state to tone.
 *
 * Deliberately five states, not "connected / not connected". `degraded` is a
 * host that answered but failed its capability probe, `versionMismatch` is one
 * that needs an upgrade before it will accept writes, and `revoked` is one that
 * threw this device out. Collapsing them loses the only information that says
 * what to do next.
 */
const STATE_TONE: Record<RemoteHost["connectionState"], SiteTone> = {
  ready: "success",
  connecting: "info",
  degraded: "warning",
  versionMismatch: "warning",
  revoked: "danger",
  disconnected: "neutral",
}

export function hostTone(host: RemoteHost | null): SiteTone {
  // No host means local execution, which is a fact rather than a status: the
  // dot stays neutral so the bar does not read as an alert at rest.
  return host ? STATE_TONE[host.connectionState] : "neutral"
}

interface SwitcherState {
  hosts: readonly RemoteHost[]
  active: RemoteHost | null
  activate: (id: string) => void
  deactivate: () => void
}

function useSwitcherState(): SwitcherState {
  const hosts = useRemoteHostStore((s) => s.hosts)
  const activeHostId = useRemoteHostStore((s) => s.activeHostId)
  const activate = useRemoteHostStore((s) => s.activateHost)
  const deactivate = useRemoteHostStore((s) => s.deactivate)
  const active = useMemo(
    () => hosts.find((host) => host.id === activeHostId) ?? null,
    [hosts, activeHostId]
  )
  return { hosts, active, activate, deactivate }
}

export interface ExecutionHostSwitcherProps {
  /**
   * `chip` is a bordered pill for a page header. `status-bar` is the flat
   * 24px-high segment the desktop bottom bar draws.
   */
  variant?: "chip" | "status-bar"
  className?: string
  /** Opens the add-host sheet instead of linking to `/devices`, where one exists. */
  onAddHost?: () => void
}

export function ExecutionHostSwitcher({
  variant = "chip",
  className,
  onAddHost,
}: ExecutionHostSwitcherProps) {
  const t = useTranslations("devices.executionHost")
  const { hosts, active, activate, deactivate } = useSwitcherState()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<RemoteHost | null | undefined>(undefined)

  const tone = hostTone(active)
  const label = active ? active.label : t("local")

  const commit = useCallback(
    (host: RemoteHost | null) => {
      if (host) activate(host.id)
      else deactivate()
      setOpen(false)
    },
    [activate, deactivate]
  )

  /**
   * Ask before repointing the transport while a turn is streaming. Read lazily
   * rather than subscribed: this control renders in the desktop status bar on
   * every route, and subscribing to run state there would re-render the whole
   * bar on every token.
   */
  const request = useCallback(
    async (host: RemoteHost | null) => {
      const currentId = active?.id ?? null
      if ((host?.id ?? null) === currentId) {
        setOpen(false)
        return
      }
      const { anyRunActive } = await import("@/lib/devices/execution-host-guard")
      if (await anyRunActive()) {
        setPending(host)
        return
      }
      commit(host)
    },
    [active, commit]
  )

  const trigger =
    variant === "status-bar" ? (
      <button
        type="button"
        aria-label={t("aria", { label })}
        title={t("aria", { label })}
        data-testid="status-execution-host"
        data-tone={tone}
        className="flex h-6 items-center gap-1 px-2 text-[11px] transition-colors hover:bg-muted"
      >
        <span
          aria-hidden
          className={cn("inline-block size-1.5 rounded-full", SITE_TONE_DOT[tone])}
        />
        <span className="max-w-32 truncate">{label}</span>
      </button>
    ) : (
      // A real `Button`, not a hand-rolled pill: the outline variant already
      // owns the border, radius and hover surface, and `audit:surfaces` rightly
      // refuses a bespoke element that carries all three itself.
      <Button
        variant="outline"
        size="sm"
        aria-label={t("aria", { label })}
        data-testid="execution-host-chip"
        data-tone={tone}
        className={cn("h-7 shrink-0 gap-1.5 px-2.5 text-xs font-normal", className)}
      >
        <span
          aria-hidden
          className={cn("inline-block size-1.5 rounded-full", SITE_TONE_DOT[tone])}
        />
        <span className="max-w-28 truncate">{label}</span>
      </Button>
    )

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1.5" data-testid="execution-host-popover">
          <p className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">{t("hint")}</p>

          <HostOption
            selected={!active}
            icon={MonitorSmartphoneIcon}
            label={t("local")}
            detail={t("localDetail")}
            tone="neutral"
            onSelect={() => void request(null)}
            testId="execution-host-local"
          />

          {hosts.map((host) => (
            <HostOption
              key={host.id}
              selected={active?.id === host.id}
              icon={ServerIcon}
              label={host.label}
              detail={host.connectionError ?? host.config.baseUrl}
              stateLabel={t(`state.${host.connectionState}`)}
              tone={STATE_TONE[host.connectionState]}
              onSelect={() => void request(host)}
              testId={`execution-host-${host.id}`}
            />
          ))}

          <div className="mt-1 flex items-center gap-1 border-t pt-1">
            {onAddHost ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 flex-1 justify-start px-2 text-xs"
                onClick={() => {
                  setOpen(false)
                  onAddHost()
                }}
              >
                {t("addHost")}
              </Button>
            ) : null}
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="h-7 flex-1 justify-start px-2 text-xs"
            >
              <Link href="/devices" onClick={() => setOpen(false)}>
                {t("manage")}
              </Link>
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <AlertDialog
        open={pending !== undefined}
        onOpenChange={(next) => {
          if (!next) setPending(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmBody", { label: pending ? pending.label : t("local") })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirmCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending !== undefined) commit(pending)
                setPending(undefined)
              }}
              data-testid="execution-host-confirm"
            >
              {t("confirmSwitch")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function HostOption({
  selected,
  icon: Icon,
  label,
  detail,
  stateLabel,
  tone,
  onSelect,
  testId,
}: {
  selected: boolean
  icon: typeof ServerIcon
  label: string
  detail?: string
  stateLabel?: string
  tone: SiteTone
  onSelect: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-testid={testId}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
        selected && "bg-muted"
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{label}</span>
          {stateLabel ? (
            <span className={cn("shrink-0 text-[10px]", SITE_TONE_TEXT[tone])}>{stateLabel}</span>
          ) : null}
        </span>
        {detail ? (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {selected ? <CheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : null}
    </button>
  )
}

/** Page-header form. Named separately so callers do not pass magic strings. */
export function ExecutionHostChip(props: Omit<ExecutionHostSwitcherProps, "variant">) {
  return <ExecutionHostSwitcher {...props} variant="chip" />
}

/**
 * Status-bar form.
 *
 * Renders nothing when there is no host to switch to AND nothing is active:
 * a permanent "Local" chip on a machine that has never seen a remote host is
 * rent with no information, and `CHROME_BUDGET.statusBar` is finite. The same
 * rule `StatusBarTerminal` and `agentThreads` already follow.
 */
export function StatusBarExecutionHost() {
  const { hosts, active } = useSwitcherState()
  if (hosts.length === 0 && !active) return null
  return <ExecutionHostSwitcher variant="status-bar" />
}

export default StatusBarExecutionHost

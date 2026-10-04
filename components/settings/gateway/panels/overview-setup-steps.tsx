"use client"

/**
 * Settings → Gateway → Overview → "Get started".
 *
 * Getting a first request through the gateway takes three steps on three
 * different surfaces: issue a key (API keys panel), start the listener (the
 * Overview switch, which stays locked until a key exists), and point a client
 * at it (the connect snippets further down Overview). Before this, a new user
 * landed on a disabled switch and one muted line saying a key was needed, with
 * nothing pointing at where keys live.
 *
 * Each step's done-state is read from live status — `hasToken`, `running`,
 * `callsTotal` — never remembered locally, so the list cannot drift from what
 * the gateway is doing. It disappears once the first request has been served.
 */

import { useTranslations } from "next-intl"
import { CheckIcon, KeyRoundIcon, LockIcon, PlayIcon, PlugIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

import { GatewayPanelSection } from "../shared/panel-section"

export type GatewaySetupStepId = "key" | "start" | "connect"

export interface GatewaySetupProgress {
  hasToken: boolean
  running: boolean
  callsTotal: number
}

/** Which steps are done, in order. */
export function gatewaySetupDone(
  progress: GatewaySetupProgress
): Record<GatewaySetupStepId, boolean> {
  return {
    key: progress.hasToken,
    start: progress.running,
    connect: progress.callsTotal > 0,
  }
}

/** True once every step is done — the list is then hidden. */
export function isGatewaySetupComplete(progress: GatewaySetupProgress): boolean {
  const done = gatewaySetupDone(progress)
  return done.key && done.start && done.connect
}

export interface GatewaySetupStepsProps extends GatewaySetupProgress {
  /** An account-scoped gateway with no unlocked account cannot issue keys. */
  accountLocked: boolean
  /** A start/stop round-trip is in flight. */
  starting: boolean
  onCreateKey: () => void
  onStart: () => void
  onShowConnect: () => void
}

const STEP_ORDER: readonly GatewaySetupStepId[] = ["key", "start", "connect"]

export function GatewaySetupSteps({
  hasToken,
  running,
  callsTotal,
  accountLocked,
  starting,
  onCreateKey,
  onStart,
  onShowConnect,
}: GatewaySetupStepsProps) {
  const t = useTranslations("settings.gateway.setup")
  const done = gatewaySetupDone({ hasToken, running, callsTotal })
  const doneCount = STEP_ORDER.filter((id) => done[id]).length
  // The first unfinished step is the one to do next; later ones stay visible
  // so the whole path is clear, but read as "not yet".
  const current = STEP_ORDER.find((id) => !done[id])

  const steps: Record<
    GatewaySetupStepId,
    { icon: React.ReactNode; action: React.ReactNode; note?: string }
  > = {
    key: {
      icon: <KeyRoundIcon className="size-3.5" aria-hidden />,
      note: accountLocked ? t("stepKeyLocked") : undefined,
      action: (
        <Button
          size="sm"
          variant={current === "key" ? "default" : "outline"}
          disabled={accountLocked}
          onClick={onCreateKey}
          data-testid="gateway-setup-action-key"
        >
          {accountLocked ? (
            <LockIcon className="size-3.5" aria-hidden />
          ) : (
            <KeyRoundIcon className="size-3.5" aria-hidden />
          )}
          {t("stepKeyAction")}
        </Button>
      ),
    },
    start: {
      icon: <PlayIcon className="size-3.5" aria-hidden />,
      note: !hasToken ? t("stepStartBlocked") : undefined,
      action: (
        <Button
          size="sm"
          variant={current === "start" ? "default" : "outline"}
          // The listener refuses to start without a key; the step says why.
          disabled={!hasToken || starting}
          onClick={onStart}
          data-testid="gateway-setup-action-start"
        >
          {starting ? (
            <Spinner className="size-3.5" aria-hidden />
          ) : (
            <PlayIcon className="size-3.5" aria-hidden />
          )}
          {t("stepStartAction")}
        </Button>
      ),
    },
    connect: {
      icon: <PlugIcon className="size-3.5" aria-hidden />,
      action: (
        <Button
          size="sm"
          variant={current === "connect" ? "default" : "outline"}
          onClick={onShowConnect}
          data-testid="gateway-setup-action-connect"
        >
          <PlugIcon className="size-3.5" aria-hidden />
          {t("stepConnectAction")}
        </Button>
      ),
    },
  }

  return (
    <GatewayPanelSection
      title={t("title")}
      description={t("description")}
      badge={t("progress", { done: doneCount, total: STEP_ORDER.length })}
      badgeVariant="outline"
      className="rounded-lg border bg-muted/30 p-3 @lg/gateway-pane:p-4"
    >
      <ol className="flex flex-col gap-2" data-testid="gateway-setup-steps">
        {STEP_ORDER.map((id, index) => {
          const step = steps[id]
          const isDone = done[id]
          const isCurrent = current === id
          return (
            <li
              key={id}
              aria-current={isCurrent ? "step" : undefined}
              data-state={isDone ? "done" : isCurrent ? "current" : "pending"}
              data-testid={`gateway-setup-step-${id}`}
              className={cn(
                "flex flex-col gap-2 rounded-md border bg-background px-3 py-2.5 @md/gateway-pane:flex-row @md/gateway-pane:items-center",
                isCurrent && "border-primary/40",
                !isDone && !isCurrent && "opacity-80"
              )}
            >
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums",
                    isDone && "border-transparent bg-success text-success-foreground",
                    isCurrent && "border-primary text-primary"
                  )}
                >
                  {isDone ? <CheckIcon className="size-3" /> : index + 1}
                </span>
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {step.icon}
                    {t(`steps.${id}.title`)}
                    {isDone ? (
                      <Badge variant="success" className="text-[10px] font-normal">
                        {t("done")}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{t(`steps.${id}.help`)}</p>
                  {!isDone && step.note ? (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid={`gateway-setup-note-${id}`}
                    >
                      {step.note}
                    </p>
                  ) : null}
                </div>
              </div>
              {isDone ? null : <div className="flex shrink-0 justify-end">{step.action}</div>}
            </li>
          )
        })}
      </ol>
    </GatewayPanelSection>
  )
}

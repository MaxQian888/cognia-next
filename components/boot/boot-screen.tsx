"use client"

/**
 * BootScreen — the workspace boot / page-load screen.
 *
 * Mounted, in turn, by every owner that has to hold the app back while
 * something real finishes (see `lib/boot/boot-progress.ts` for the sequence
 * and why the state lives outside the component). Each owner passes the
 * `milestone` it stands for; the screen renders the *whole* timeline with the
 * earlier steps ticked (and timed), this step live, later steps pending — so
 * a hand-over from one owner to the next reads as one continuous wait.
 *
 * What the user sees, top to bottom:
 *
 *   - the brand mark with a rotating accent arc and breathing halo, and the
 *     runtime + version at the right so a screenshot of a stuck boot already
 *     says which build it is;
 *   - the title / description;
 *   - a progress bar that leans into the current step and snaps forward when
 *     a step completes, captioned "Step n of N" rather than a percentage the
 *     app has no way to know;
 *   - the step list, each row with its measured duration once done, and —
 *     while the workspace step is loading — the runtime capabilities that
 *     have come up so far, straight from `lib/boot/capabilities.ts`;
 *   - reassurance once the wait is prolonged, an offline note when that is
 *     the likely cause, and a reload offer once it has gone on long enough
 *     that a way out is worth more than another second of spinner.
 *
 * Motion is CSS-only and compositor-friendly (transform/opacity), which is
 * what keeps it fluid while the main thread is busy booting; the classes and
 * the reduce-motion reasoning live in the "Workspace boot screen" section of
 * globals.css.
 */

import { CheckIcon, RefreshCw, Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from "react"

import { BootPreview, type BootPreviewSettled } from "@/components/boot/boot-preview"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useBootProgress, type BootMilestoneView } from "@/hooks/boot/use-boot-progress"
import { useLoadingPhase } from "@/hooks/ui/use-loading-phase"
import { usePlatform } from "@/hooks/use-platform"
import { APP_VERSION } from "@/lib/app-version"
import {
  getBootCapabilitySnapshot,
  getBootDiagnosticsSnapshot,
  subscribeBootCapabilities,
  type BootCapability,
} from "@/lib/boot/capabilities"
import { bootMilestoneIndex, type BootMilestone } from "@/lib/boot/boot-progress"
import { cn } from "@/lib/utils"

export interface BootScreenProps {
  /** The boot milestone this mount stands for. */
  milestone: BootMilestone
  /** Overrides the default heading. */
  title?: string
  /** Overrides the default sub-heading; pass `null` to omit it. */
  description?: string | null
  /** Offer a reload once the wait has escalated. */
  allowReload?: boolean
  className?: string
}

/**
 * Where the progress fill last stood, remembered across mounts so the next
 * owner's bar picks up from there instead of jumping. Module state on purpose:
 * it is a purely visual continuity detail, not part of the boot model.
 */
let lastFillFraction = 0

export function __resetBootScreenForTesting(): void {
  lastFillFraction = 0
}

function formatDuration(ms: number): string {
  return Math.max(0.1, ms / 1000).toFixed(1)
}

const serverCapabilitySnapshot = () => 0

export function BootScreen({
  milestone,
  title,
  description,
  allowReload = false,
  className,
}: BootScreenProps) {
  const t = useTranslations("loading.page")
  const tLoading = useTranslations("loading")
  const titleId = useId()
  const platform = usePlatform()

  const view = useBootProgress(milestone)
  const { elapsedMs, offline, phase } = useLoadingPhase({
    canEscalate: allowReload,
    startedAt: view.sequenceStartedAt,
  })

  // Runtime capabilities (chat, plugins, workflows…) — meaningful once the
  // provider stack that boots them is mounted, i.e. during the workspace step.
  useSyncExternalStore(
    subscribeBootCapabilities,
    getBootCapabilitySnapshot,
    serverCapabilitySnapshot
  )
  const capabilities = getBootDiagnosticsSnapshot()

  // Progress fill. The element mounts at the previous owner's value (so a
  // hand-over never jumps) and is then moved to this mount's target
  // imperatively: forcing a style resolution first gives the CSS transition a
  // computed start value to run from. Deliberately not `requestAnimationFrame`
  // — rAF is paused in a hidden document, and a boot that begins in a
  // background tab must still be at the right place when the tab is shown.
  const target = view.fraction
  const [initialFill] = useState(() => lastFillFraction)
  const fillRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = fillRef.current
    if (!el) return
    void getComputedStyle(el).transform
    el.style.setProperty("--boot-fill", String(target))
    lastFillFraction = target
  }, [target])

  const prolonged = phase === "prolonged" || phase === "escalated"
  // `useLoadingPhase` only reaches "escalated" when `canEscalate` — i.e. when
  // a reload was offered — so this needs no second `allowReload` guard.
  const escalated = phase === "escalated"
  const waitDetail = offline
    ? tLoading("offline")
    : tLoading("stillWorking", { seconds: Math.round(elapsedMs / 1000) })

  const heading = title ?? t("title")
  const detail = description === undefined ? t("description") : description

  // Every step before this mount's own is behind us — including the ones a
  // route transition never lists — so the preview's chrome for them is real.
  const settled: BootPreviewSettled = {
    accounts: isBehind("accounts", milestone),
    preferences: isBehind("preferences", milestone),
    interface: isBehind("interface", milestone),
    workspace: isBehind("workspace", milestone),
  }

  // Only the step that just finished pops its check; steps ticked long ago
  // (or on the very first mount, where nothing has finished yet) sit still.
  const justCompletedIndex = view.playIntro ? -1 : view.index - 1

  return (
    <div
      data-slot="boot-screen"
      data-milestone={milestone}
      className={cn(
        "boot-screen flex min-h-[max(400px,calc(100dvh-5rem))] w-full items-center justify-center px-4 py-6 sm:px-8",
        className
      )}
    >
      <section
        aria-busy="true"
        aria-labelledby={titleId}
        className={cn(
          // Opaque on purpose: a translucent card would force a backdrop
          // re-composite every frame the ambient field behind it drifts.
          "grid w-full max-w-3xl overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_40px_-16px_rgb(0_0_0/0.18)] sm:grid-cols-[minmax(0,1.15fr)_minmax(15rem,0.85fr)]",
          view.playIntro && "boot-screen__card--intro"
        )}
      >
        <div className="flex min-w-0 flex-col justify-center p-6 sm:p-8">
          {/* Header: mark + runtime/version. */}
          <div className="boot-enter mb-6 flex items-center gap-4" style={stagger(0)}>
            <div className="relative shrink-0">
              <span aria-hidden="true" className="boot-mark__glow" />
              <div className="boot-mark">
                <div className="boot-mark__tile flex size-11 items-center justify-center bg-card text-foreground">
                  <Sparkles aria-hidden="true" className="size-5" />
                </div>
              </div>
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 size-3 rounded-full border-2 border-card bg-success"
              />
            </div>
            <div className="h-px flex-1 bg-border" aria-hidden="true" />
            <p className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              <span>{t(`platform.${platform}`)}</span>
              <span aria-hidden="true" className="mx-1.5 text-border">
                ·
              </span>
              <span>{t("version", { version: APP_VERSION })}</span>
            </p>
          </div>

          <div className="boot-enter space-y-2" style={stagger(1)}>
            <h1
              id={titleId}
              className="text-balance text-xl font-semibold tracking-tight sm:text-2xl"
            >
              {heading}
            </h1>
            {detail ? (
              <p className="max-w-md text-sm leading-6 text-muted-foreground">{detail}</p>
            ) : null}
          </div>

          {/* Progress. */}
          <div className="boot-enter mt-6 space-y-2" style={stagger(2)}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="font-medium text-foreground">{t("progressLabel")}</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {t("stepOf", { current: view.index + 1, total: view.total })}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={t("progressLabel")}
              aria-valuemin={0}
              aria-valuemax={view.total}
              aria-valuenow={view.index + 1}
              aria-valuetext={t(`milestones.${milestone}.label`)}
              className="boot-bar"
            >
              <div
                ref={fillRef}
                data-slot="boot-bar-fill"
                className="boot-bar__fill"
                style={{ "--boot-fill": initialFill } as CSSProperties}
              />
            </div>
          </div>

          {/* Steps. */}
          <ol aria-label={t("stepsLabel")} className="mt-5 space-y-1">
            {view.milestones.map((row, index) => (
              <MilestoneRow
                key={row.id}
                row={row}
                order={index}
                pop={index === justCompletedIndex}
                capabilities={
                  row.id === "workspace" && row.status === "active" ? capabilities : null
                }
              />
            ))}
          </ol>

          {/* Footer: reassurance once prolonged, the reload offer once escalated.
              One reserved row for both (`min-h-9`, the button's height), so
              neither arrival re-centres the card under the user's eyes. */}
          <div className="mt-4 flex min-h-9 items-center justify-between gap-3">
            <p
              role="status"
              aria-live="polite"
              className="min-w-0 text-xs leading-5 text-muted-foreground"
            >
              {escalated ? (
                <span className="boot-appear block">{t("reloadHint")}</span>
              ) : prolonged ? (
                <span className="boot-appear block">{waitDetail}</span>
              ) : null}
            </p>
            {escalated ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="boot-appear shrink-0"
                onClick={() => window.location.reload()}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                {t("reload")}
              </Button>
            ) : null}
          </div>
        </div>

        <BootPreview settled={settled} />
      </section>
    </div>
  )
}

function isBehind(candidate: BootMilestone, current: BootMilestone): boolean {
  return bootMilestoneIndex(candidate) < bootMilestoneIndex(current)
}

function stagger(index: number): CSSProperties {
  return { "--boot-i": index } as CSSProperties
}

interface MilestoneRowProps {
  row: BootMilestoneView
  order: number
  /** Play the check-mark pop — the row finished just now. */
  pop: boolean
  /** Runtime capability state to show under this row, or `null` for none. */
  capabilities: ReturnType<typeof getBootDiagnosticsSnapshot> | null
}

function MilestoneRow({ row, order, pop, capabilities }: MilestoneRowProps) {
  const t = useTranslations("loading.page")
  const active = row.status === "active"
  const done = row.status === "done"
  const showCapabilities = capabilities !== null && capabilities.requested.length > 0

  return (
    <li
      data-slot="boot-milestone"
      data-milestone={row.id}
      data-status={row.status}
      aria-current={active ? "step" : undefined}
      className="boot-enter rounded-lg px-1 py-1.5"
      style={stagger(3 + order)}
    >
      <div className="flex items-center gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
          {done ? (
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full bg-success/15 text-success",
                pop && "boot-check"
              )}
            >
              <CheckIcon className="size-3" strokeWidth={3} />
            </span>
          ) : active ? (
            <Spinner className="size-4 text-foreground" />
          ) : (
            <span className="size-1.5 rounded-full bg-border" />
          )}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm transition-colors duration-300",
            active
              ? "font-medium text-foreground"
              : done
                ? "text-muted-foreground"
                : "text-muted-foreground/60"
          )}
        >
          {t(`milestones.${row.id}.label`)}
        </span>
        <span className="sr-only">
          {t(active ? "statusActive" : done ? "statusDone" : "statusPending")}
        </span>
        {done && row.durationMs !== null ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {t("milestoneDuration", { seconds: formatDuration(row.durationMs) })}
          </span>
        ) : null}
      </div>

      {active ? (
        <div className="boot-appear pl-8 pt-1">
          <p className="text-xs leading-5 text-muted-foreground">
            {showCapabilities
              ? t("capabilitiesReady", {
                  ready: capabilities.ready.length,
                  total: capabilities.requested.length,
                })
              : t(`milestones.${row.id}.detail`)}
          </p>
          {showCapabilities ? (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {capabilities.requested.map((capability) => (
                <CapabilityChip
                  key={capability}
                  capability={capability}
                  ready={capabilities.ready.includes(capability)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function CapabilityChip({ capability, ready }: { capability: BootCapability; ready: boolean }) {
  const t = useTranslations("loading.page")
  return (
    <li
      data-slot="boot-capability"
      data-capability={capability}
      data-ready={ready ? "true" : "false"}
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[10px] leading-none transition-colors duration-300",
        ready
          ? "border-success/40 bg-success/10 text-foreground"
          : "border-border bg-transparent text-muted-foreground"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          ready ? "bg-success" : "animate-pulse bg-muted-foreground/50"
        )}
      />
      {t(`capabilities.${capability}`)}
    </li>
  )
}

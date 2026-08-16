"use client"

/**
 * MobileBootScreen — the phone's boot / page-load screen.
 *
 * One component, three moments:
 *
 *   - the **splash overlay** (`milestone={null}`), mounted by `AppSplash` the
 *     instant the gates let the shell mount. It paints the same `#01061e`
 *     canvas as the native launch splash (Android 12's system splash and the
 *     iOS launch storyboard can only show a static mark on a flat colour), so
 *     the native → web hand-over is invisible, and then renders the branded
 *     motion the native surface can't: a coin logo inside a spinning accent
 *     arc, orbiting satellites, a breathing halo, and — the part that was
 *     missing — a live timeline of what the phone is actually doing;
 *   - a **cold-boot gate** (`milestone="accounts" | "preferences"`), the same
 *     canvas, mounted by the account / onboarding gates while they resolve.
 *     Usually still under the native splash; visible only when a first-open
 *     schema upgrade or a slow registry read outlives it;
 *   - a **route transition** (`milestone="workspace"` starting its own
 *     sequence), rendered in flow inside the themed shell as a compact mark
 *     plus a bar — a page load is not a boot and must not flash the splash
 *     canvas over a light theme.
 *
 * The rows come from `useMobileBoot`, which merges the shared boot milestones
 * with the Capacitor stages `CompanionBootProvider` reports; each row shows
 * its measured duration once done and its outcome (paired / standalone /
 * online / offline …) as a chip. The whole thing is one continuous timeline
 * across the hand-overs, not a loader that forgets at every mount.
 *
 * Motion budget (Capacitor WebViews, iOS 15+ / Android 7+ per Capacitor 8):
 * every loop drives only `transform` / `opacity`, so it stays on the
 * compositor while the main thread is busy booting; there is no
 * `backdrop-filter`, no animated `filter: blur()`, no `color-mix()` (Safari
 * 16.2+), no `@property`; the ambient fields are pre-softened radial
 * gradients that are painted once and then translated. The reduce-motion
 * policy is the global one in `globals.css` — everything here is decorative
 * except the row spinner, which is exempt as status. The classes and their
 * reasoning live in the "Mobile boot screen" section of `globals.css`.
 */

import { AlertCircle, CheckIcon, MinusIcon, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useMobileBoot, type MobileBootRow } from "@/hooks/boot/use-mobile-boot"
import { useLoadingPhase } from "@/hooks/ui/use-loading-phase"
import { APP_VERSION } from "@/lib/app-version"
import type { BootMilestone } from "@/lib/boot/boot-progress"
import type { MobileBootStageDetail } from "@/lib/boot/mobile-boot-stages"
import { cn } from "@/lib/utils"

/** Matches `@color/splash_background` + the native `windowSplashScreenBackground`. */
export const MOBILE_SPLASH_BACKDROP = "#01061e"

export interface MobileBootScreenProps {
  /**
   * The boot milestone this mount stands for, or `null` for the splash
   * overlay that owns none and only reads the timeline.
   */
  milestone: BootMilestone | null
  /** Overlay only: play the exit (fade + gentle push) — the owner unmounts after it. */
  leaving?: boolean
  /** Gate only: offer a reload once the wait has escalated. */
  allowReload?: boolean
  className?: string
}

/**
 * Where the progress fill last stood, remembered across mounts so the next
 * owner's bar picks up from there instead of jumping. Purely visual continuity,
 * not part of the boot model — hence module state.
 */
let lastFillFraction = 0

export function __resetMobileBootScreenForTesting(): void {
  lastFillFraction = 0
}

function formatDuration(ms: number): string {
  return Math.max(0.1, ms / 1000).toFixed(1)
}

function stagger(index: number): CSSProperties {
  return { "--mboot-i": index } as CSSProperties
}

/** Outcome chips: what colour a qualifier deserves. */
const OUTCOME_TONE: Record<MobileBootStageDetail, "good" | "warn" | "muted"> = {
  registered: "good",
  unavailable: "warn",
  paired: "good",
  standalone: "good",
  unpaired: "muted",
  linked: "good",
  offline: "warn",
  incompatible: "warn",
  synced: "good",
  syncFailed: "warn",
  notNeeded: "muted",
}

export function MobileBootScreen({
  milestone,
  leaving = false,
  allowReload = false,
  className,
}: MobileBootScreenProps) {
  const t = useTranslations("mobile.splash")
  const tLoading = useTranslations("loading")
  const titleId = useId()
  const overlay = milestone === null

  const view = useMobileBoot(milestone)
  const gate = !overlay
  const { elapsedMs, offline, phase } = useLoadingPhase({
    canEscalate: gate && allowReload,
    startedAt: view.sequenceStartedAt,
  })

  // Progress fill. Mounts at the previous owner's value (so a hand-over never
  // jumps) and is then moved to this mount's target imperatively, after a
  // forced style resolution so the transition has a computed start value.
  // Not `requestAnimationFrame` on purpose: rAF is paused in a hidden
  // document, and a boot that begins backgrounded must still be right when
  // the app is brought forward.
  const target = view.fraction
  const [initialFill] = useState(() => lastFillFraction)
  const fillRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = fillRef.current
    if (!el) return
    void getComputedStyle(el).transform
    el.style.setProperty("--mboot-fill", String(target))
    lastFillFraction = target
  }, [target])

  // Glide. The native splash paints its icon at the exact centre of the
  // screen; the overlay's first frame must too, or the hand-over jumps. The
  // grid puts the coin wherever the timeline below leaves room, so on mount we
  // measure how far that is from the centre and let CSS animate the coin from
  // there into its slot (`.mboot__mark--glide`). Layout effect: the value has
  // to be on the element before the first paint. Only for the intro — later
  // mounts render settled, and route transitions have no native counterpart.
  const markRef = useRef<HTMLDivElement>(null)
  const glide = view.playIntro && view.layout === "boot"
  useLayoutEffect(() => {
    const el = markRef.current
    if (!el || !glide) return
    const rect = el.getBoundingClientRect()
    const shift = window.innerHeight / 2 - (rect.top + rect.height / 2)
    el.style.setProperty("--mboot-mark-shift", `${Math.round(shift)}px`)
  }, [glide])

  const prolonged = phase === "prolonged" || phase === "escalated"
  const escalated = phase === "escalated"
  const waitDetail = offline
    ? tLoading("offline")
    : tLoading("stillWorking", { seconds: Math.round(elapsedMs / 1000) })

  const route = view.layout === "route"
  const allEnded = view.completed === view.total
  const settled = !route && (view.settled || allEnded)
  const heading = route
    ? t("headline.route")
    : settled
      ? t("headline.settled")
      : t("headline.boot")
  const activeRow = view.rows.find((row) => row.id === view.activeId) ?? null

  // Only the row that just finished pops its check; rows ticked long ago (or
  // on the very first mount, where nothing has finished yet) sit still.
  const justCompletedIndex = view.playIntro
    ? -1
    : view.rows.findIndex((row, index) => {
        const next = view.rows[index + 1]
        return row.status === "done" && (next === undefined || next.status !== "done")
      })

  return (
    <div
      data-slot="mobile-boot"
      data-layout={view.layout}
      data-state={leaving ? "leaving" : settled ? "settled" : "running"}
      data-testid={overlay ? "app-splash" : undefined}
      role={overlay ? "status" : undefined}
      aria-label={overlay ? t("label") : undefined}
      aria-busy={overlay ? undefined : "true"}
      aria-labelledby={overlay ? undefined : titleId}
      className={cn(
        "mboot",
        route
          ? "mboot--route flex min-h-[max(400px,calc(100dvh-5rem))] w-full items-center justify-center px-6 py-8"
          : cn("mboot--boot fixed inset-0", overlay ? "z-[9999]" : "z-30"),
        view.playIntro && "mboot--intro",
        settled && "mboot--settled",
        leaving && "mboot--leaving",
        className
      )}
    >
      {route ? null : (
        <>
          <span aria-hidden="true" className="mboot__aurora mboot__aurora--a" />
          <span aria-hidden="true" className="mboot__aurora mboot__aurora--b" />
        </>
      )}

      <div className={cn("mboot__stage", route ? "mboot__stage--route" : "mboot__stage--boot")}>
        {route ? null : <div aria-hidden="true" />}

        {/* Brand mark. The coin sits exactly where the native splash left it;
            the halo, orbits and arc fade in around it. */}
        <div
          ref={markRef}
          className={cn(
            "mboot__mark",
            route ? "mboot__mark--sm" : "mboot__mark--lg",
            glide && "mboot__mark--glide"
          )}
        >
          <span aria-hidden="true" className="mboot__halo mboot__enter" style={stagger(0)} />
          {route ? null : (
            <>
              <span aria-hidden="true" className="mboot__orbit mboot__orbit--a mboot__enter" style={stagger(0)}>
                <i className="mboot__sat mboot__sat--a" />
                <i className="mboot__sat mboot__sat--b" />
                <i className="mboot__sat mboot__sat--c" />
              </span>
              <span aria-hidden="true" className="mboot__orbit mboot__orbit--b mboot__enter" style={stagger(0)}>
                <i className="mboot__sat mboot__sat--d" />
              </span>
            </>
          )}
          <span aria-hidden="true" className="mboot__ring mboot__enter" style={stagger(0)} />
          <span aria-hidden="true" className="mboot__ring-solid" />
          <span
            aria-hidden="true"
            className="mboot__logo"
            style={{ backgroundImage: "url(/icons/icon-512.png)" }}
          />
          <span aria-hidden="true" className="mboot__badge">
            <CheckIcon className="size-3" strokeWidth={3} />
          </span>
        </div>

        <div className={cn("mboot__body", route && "mboot__body--route")}>
          {route ? null : (
            <div className="mboot__enter mboot__brand" style={stagger(1)}>
              <p className="mboot__wordmark">{t("wordmark")}</p>
              <span aria-hidden="true" className="mboot__hairline" />
            </div>
          )}

          <h1 id={titleId} className="mboot__enter mboot__headline" style={stagger(2)}>
            {heading}
          </h1>

          {/* Short viewports (landscape phones) hide the list and show only the
              live row here — CSS decides, so nothing re-lays-out on rotate. */}
          {activeRow && !route ? (
            <p aria-hidden="true" className="mboot__active-line">
              {t(`rows.${activeRow.id}.label`)}
            </p>
          ) : null}

          <div className="mboot__enter mboot__progress" style={stagger(3)}>
            <div
              role="progressbar"
              aria-label={t("progressLabel")}
              aria-valuemin={0}
              aria-valuemax={view.total}
              aria-valuenow={view.completed}
              aria-valuetext={activeRow ? t(`rows.${activeRow.id}.label`) : heading}
              className="mboot__bar"
            >
              <div
                ref={fillRef}
                data-slot="mobile-boot-fill"
                className="mboot__bar-fill"
                style={{ "--mboot-fill": initialFill } as CSSProperties}
              />
            </div>
            {route ? null : (
              <span className="mboot__counter">
                {t("stepsOf", { completed: view.completed, total: view.total })}
              </span>
            )}
          </div>

          {route ? null : (
            <ol aria-label={t("stepsLabel")} className="mboot__rows">
              {view.rows.map((row, index) => (
                <Row key={row.id} row={row} order={index} pop={index === justCompletedIndex} />
              ))}
            </ol>
          )}

          {/* Footer: build stamp; reassurance once prolonged; a reload once
              escalated (gates only — the overlay has its own ceiling). One
              reserved row for all of it so nothing re-centres under the eye. */}
          <div className="mboot__enter mboot__footer" style={stagger(4 + view.rows.length)}>
            <p className="mboot__build">{t("build", { version: APP_VERSION })}</p>
            <p role="status" aria-live="polite" className="mboot__wait">
              {escalated ? (
                <span className="mboot__appear">{tLoading("page.reloadHint")}</span>
              ) : prolonged ? (
                <span className="mboot__appear">{waitDetail}</span>
              ) : null}
            </p>
            {escalated ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mboot__appear mboot__reload"
                onClick={() => window.location.reload()}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                {tLoading("page.reload")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

interface RowProps {
  row: MobileBootRow
  order: number
  /** Play the check-mark pop — the row finished just now. */
  pop: boolean
}

function Row({ row, order, pop }: RowProps) {
  const t = useTranslations("mobile.splash")
  const { status } = row
  const active = status === "active"
  const statusKey =
    status === "active"
      ? "statusActive"
      : status === "done"
        ? "statusDone"
        : status === "failed"
          ? "statusFailed"
          : status === "skipped"
            ? "statusSkipped"
            : "statusPending"

  return (
    <li
      data-slot="mobile-boot-row"
      data-row={row.id}
      data-status={status}
      aria-current={active ? "step" : undefined}
      className="mboot__enter mboot__row"
      style={stagger(4 + order)}
    >
      <div className="mboot__row-line">
        <span className="mboot__row-icon" aria-hidden="true">
          {status === "done" ? (
            <span className={cn("mboot__check", pop && "mboot__check--pop")}>
              <CheckIcon className="size-3" strokeWidth={3} />
            </span>
          ) : status === "failed" ? (
            <span className="mboot__check mboot__check--warn">
              <AlertCircle className="size-3.5" strokeWidth={2.5} />
            </span>
          ) : status === "skipped" ? (
            <span className="mboot__check mboot__check--muted">
              <MinusIcon className="size-3" strokeWidth={3} />
            </span>
          ) : active ? (
            <Spinner className="mboot__spinner size-4" />
          ) : (
            <span className="mboot__dot" />
          )}
        </span>
        <span className="mboot__row-label">{t(`rows.${row.id}.label`)}</span>
        <span className="sr-only">{t(statusKey)}</span>
        {row.detail ? (
          <span
            data-slot="mobile-boot-outcome"
            data-tone={OUTCOME_TONE[row.detail]}
            className="mboot__chip"
          >
            {t(`outcomes.${row.detail}`)}
          </span>
        ) : status === "done" && row.durationMs !== null ? (
          <span className="mboot__duration">
            {t("duration", { seconds: formatDuration(row.durationMs) })}
          </span>
        ) : null}
        {row.detail && row.durationMs !== null ? (
          <span className="mboot__duration">
            {t("duration", { seconds: formatDuration(row.durationMs) })}
          </span>
        ) : null}
      </div>
      {active ? (
        <p className="mboot__appear mboot__row-detail">{t(`rows.${row.id}.detail`)}</p>
      ) : null}
    </li>
  )
}

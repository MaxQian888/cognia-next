"use client"

/**
 * The window `/pair` renders into.
 *
 * # Why this exists
 *
 * `/pair` is a shell-bypass route (`lib/shell/bypass-routes.ts`), so nothing
 * paints behind it. The page used to be a bare `<main>` with no background of
 * its own, which meant `body[data-bg-enabled="true"]::before` — the fixed,
 * full-window wallpaper layer in `globals.css` — showed straight through under
 * the body text. Every string on the screen sat on whatever photo the user had
 * picked, at whatever contrast that happened to give. An opaque
 * `bg-background` here is the whole fix, and it is the reason this is a shell
 * rather than a set of classes on the page: the surface has to be the thing
 * that owns the viewport, or the next route-level change loses it again.
 *
 * # Geometry
 *
 * Deliberately the same as `components/onboarding/step-shell.tsx`, because
 * `/pair` and `/onboarding` are the same kind of screen — a full-window
 * first-contact flow — and looked like two different products.
 *
 * ```
 * md and up                              below md
 * ┌──────────────┬────────────────┐      ┌──────────────────────┐
 * │  mesh        │                │      │ mesh · scene · line  │
 * │  ┌────────┐  │  step body     │      ├──────────────────────┤
 * │  │ scene  │  │  (scrolls)     │      │  step body           │
 * │  └────────┘  │                │      │                      │
 * │  title/line  │                │      └──────────────────────┘
 * │  status      │                │        one document scroll
 * │  stepper     │                │
 * │  aside       │                │
 * └──────────────┴────────────────┘
 *   26rem / 30rem   independent scrolls
 * ```
 *
 * The two width regimes scroll differently on purpose. At `md` and up each
 * column owns its own overflow, so a long panel (the web flow's command block)
 * never pushes the field off screen. Below `md` there is one scroll for the
 * whole stack — a narrow browser window genuinely cannot show a picture, a
 * command and a form at once, and two nested scroll regions in that space is
 * worse than one honest page scroll.
 *
 * # It must own a definite height
 *
 * `h-[100dvh]` here is only correct because `MobileShellWrapper` gives `/pair`
 * the same `flex h-[100dvh] flex-col overflow-hidden` treatment it gives
 * `/onboarding` — otherwise the offline banner takes a row *above* a
 * full-viewport child and the page grows a scrollbar nobody asked for. The
 * `flex-1 min-h-0` beside it is what makes that work: flex-basis governs a
 * column child's main size, so one class list serves the wrapper's column and
 * the bare desktop/web mount where this element is the viewport.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

import { PairScene, type PairSceneState } from "./pair-scene"
import { PairStepper, type PairStep } from "./pair-stepper"

export interface PairShellProps {
  /** Which client to draw, and which copy register to use. */
  client: "web" | "mobile"
  /** Drives the scene and the panel's one line of narration. */
  sceneState: PairSceneState
  step: PairStep
  /** Steps to show in the row. The web flow has no Discover step. */
  steps?: readonly PairStep[]
  /**
   * Panel material that is invariant across steps — on web, how to mint an
   * invitation. Rendered under the stepper, inside the panel's own scroll.
   */
  aside?: ReactNode
  /** A live line about the far end (the loopback probe's verdict on web). */
  status?: ReactNode
  /** Recovery / mode context, rendered above the step body. */
  notice?: ReactNode
  /** Keys the body's entrance so only it replays on a step change. */
  bodyKey: string
  children: ReactNode
}

export function PairShell({
  client,
  sceneState,
  step,
  steps,
  aside,
  status,
  notice,
  bodyKey,
  children,
}: PairShellProps) {
  const t = useTranslations("mobile.pair")

  return (
    <div
      className="flex h-[100dvh] min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground safe-area-pt"
      data-testid="pair-shell"
      data-client={client}
      data-scene-state={sceneState}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <aside
          data-testid="pair-narrative-panel"
          className={cn(
            "relative flex shrink-0 flex-col border-border/60",
            "w-full border-b",
            "md:h-auto md:w-[26rem] md:overflow-y-auto md:border-r md:border-b-0 lg:w-[30rem]"
          )}
        >
          {/* Substrate. Two soft brand stops over the app's own background, so
              the panel reads as a different surface without becoming a
              different product. Same recipe and same tokens as the onboarding
              panel — `--brand-action` is 1.69:1 on a light ground, so it is a
              mesh at 12–18% alpha and never sits behind text. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-background"
            style={{
              backgroundImage:
                "radial-gradient(90% 70% at 18% 12%, var(--brand-mesh-from), transparent 70%), radial-gradient(80% 60% at 88% 96%, var(--brand-mesh-to), transparent 72%)",
            }}
          />

          <div className="relative flex min-h-0 flex-1 flex-col gap-4 px-6 py-5 md:gap-6 md:px-9 md:py-10">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="size-2 rounded-full bg-brand-action" />
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {t("brandMark")}
              </span>
            </div>

            <div
              key={sceneState}
              data-testid="pair-scene-slot"
              className="flex w-full justify-center animate-in fade-in zoom-in-95 duration-300"
            >
              {/* Much smaller on a narrow viewport: below `md` the panel is a
                  band above the step body, and a scene sized for the wide
                  column would take half a phone screen to say something the
                  line underneath it already says. */}
              <PairScene
                state={sceneState}
                client={client}
                className="max-w-[8.5rem] md:max-w-[17rem]"
              />
            </div>

            <div className="flex flex-col gap-2">
              <h1 className="text-balance text-xl font-semibold tracking-tight md:text-2xl">
                {client === "web" ? t("web.title") : t("title")}
              </h1>
              <p
                className="text-sm leading-relaxed text-muted-foreground"
                data-testid="pair-narration"
              >
                {t(`narration.${sceneState}`)}
              </p>
            </div>

            {status}

            <PairStepper current={step} steps={steps} />

            {aside ? <div className="flex flex-col gap-3">{aside}</div> : null}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col md:overflow-y-auto">
            {/* Keyed on the step so only the body replays its entrance; the
                panel, the scene and the action row stay put. The global
                reduce-motion guards in globals.css collapse this to ~1ms. */}
            <div
              key={bodyKey}
              data-testid="pair-step-body"
              className="mx-auto flex w-full max-w-[34rem] flex-1 flex-col justify-center gap-4 px-6 py-8 sm:px-9 lg:py-10 animate-in fade-in slide-in-from-bottom-2 duration-200"
            >
              {notice}
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

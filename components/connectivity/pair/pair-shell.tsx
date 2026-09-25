"use client"

/**
 * The window `/pair` renders into — the shared guide shell (ADR-0193).
 *
 * # Why this exists
 *
 * `/pair` is a shell-bypass route (`lib/shell/bypass-routes.ts`), so nothing
 * paints behind it. The page used to be a bare `<main>` with no background of
 * its own, which meant `body[data-bg-enabled="true"]::before` — the fixed,
 * full-window wallpaper layer in `globals.css` — showed straight through under
 * the body text. `GuideShell` owns the viewport with an opaque background, so
 * the next route-level change cannot lose it again.
 *
 * # One design with `/onboarding`
 *
 * `/pair` and `/onboarding` are the same kind of screen — a full-window
 * first-contact flow — and this file used to be a hand-made copy of the
 * onboarding shell that had drifted from it: its own padding, a narrower body,
 * no entrance, a brand mark inside the panel instead of the window bar, and
 * the page title in the panel where onboarding narrates. Both now render the
 * same `components/guide/` parts: the same window bar, the same narrative
 * panel (a headline that narrates the scene, one line under it, the stepper),
 * and a step body that opens with the step's own `GuideHeading`.
 *
 * # It scrolls as a page below `md`
 *
 * The one thing that differs, on purpose, is `overflow="scroll"`. On the web
 * the panel carries real material (how to mint an invitation), so below `md`
 * the panel and the body share one page scroll instead of the onboarding
 * band's capped height — a narrow browser window genuinely cannot show a
 * picture, a command and a form at once, and two nested scroll regions in that
 * space is worse than one honest page scroll. At `md` and up each column owns
 * its own overflow, as on `/onboarding`.
 *
 * # It must own a definite height
 *
 * `h-[100dvh]` is only correct because `MobileShellWrapper` gives `/pair` the
 * same `flex h-[100dvh] flex-col overflow-hidden` treatment it gives
 * `/onboarding`; `GuideShell`'s `flex-1 min-h-0` is what makes one class list
 * serve that column and the bare desktop/web mount alike.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"

import { GuideHeading } from "@/components/guide/guide-heading"
import { GuideNarrativePanel } from "@/components/guide/guide-narrative-panel"
import { GuideShell } from "@/components/guide/guide-shell"
import { GuideWindowBar } from "@/components/guide/guide-window-bar"

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
  /** The step's page heading, rendered at the top of the body. */
  heading?: { title: string; description?: string }
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
  heading,
  aside,
  status,
  notice,
  bodyKey,
  children,
}: PairShellProps) {
  const t = useTranslations("mobile.pair")

  return (
    <GuideShell
      testIdPrefix="pair"
      overflow="scroll"
      bodyKey={bodyKey}
      dataAttributes={{ "data-client": client, "data-scene-state": sceneState }}
      windowBar={<GuideWindowBar wordmark={t("brandMark")} testIdPrefix="pair" />}
      panel={
        <GuideNarrativePanel
          testIdPrefix="pair"
          overflow="scroll"
          sceneKey={sceneState}
          scene={<PairScene state={sceneState} client={client} />}
          headline={client === "web" ? t("web.title") : t("title")}
          body={t(`narration.${sceneState}`)}
          copyKey={sceneState}
          status={status}
          stepper={<PairStepper current={step} steps={steps} />}
          aside={aside}
        />
      }
    >
      <div className="flex flex-col gap-4">
        {heading && (
          <GuideHeading title={heading.title} description={heading.description} className="mb-2" />
        )}
        {notice}
        {children}
      </div>
    </GuideShell>
  )
}

import type {
  A2UIGuideStep,
  A2UIInteractiveGuideComponentDef,
} from "@/types/a2ui/interactive-guide"

/**
 * The six capability slides, as a fixed A2UI `InteractiveGuide` payload
 * (ADR-0122, decisions 11 and 17).
 *
 * **Why fixed rather than model-generated.** A2UI payloads normally come out of
 * a model turn, but this surface has to work for someone who skipped the
 * provider step and has no model at all — and that is exactly the person most
 * in need of "what can this thing do". Building the payload as a constant and
 * handing it straight to the renderer makes the tour deterministic, offline,
 * and free.
 *
 * **Why A2UI at all, rather than a bespoke carousel.** `A2UIInteractiveGuide`
 * was already registered in `components/a2ui/a2ui-renderer.tsx` with zero
 * product authors — built, wired, and never used. Routing the tour through it
 * gives that component its first real caller, and leaves the door open for an
 * agent to render a guide of its own later through the identical path.
 *
 * The slides moved off the flow's critical path: the old three-step dialog
 * ended on this carousel, which meant a user finished setup having been *told*
 * about six subsystems and shown none. It is now optional and reachable after
 * the fact.
 */

/** Slide ids, in order. Each maps to `onboarding.tour.<id>.*` copy and to a
 *  Settings deep link. */
export const TOUR_SLIDE_IDS = [
  "sandbox",
  "ocr",
  "computerUse",
  "connectors",
  "mobile",
  "twin",
] as const

export type TourSlideId = (typeof TOUR_SLIDE_IDS)[number]

/** Where each slide's CTA goes. */
export const TOUR_SLIDE_HREFS: Record<TourSlideId, string> = {
  sandbox: "/settings?section=sandbox",
  ocr: "/settings?section=ocr",
  computerUse: "/settings?section=automation",
  connectors: "/settings?section=connections",
  mobile: "/settings?section=companion",
  twin: "/settings?section=twin",
}

/** Lucide icon name per slide, resolved by the host. */
export const TOUR_SLIDE_ICONS: Record<TourSlideId, string> = {
  sandbox: "shield-check",
  ocr: "scan-text",
  computerUse: "terminal",
  connectors: "cable",
  mobile: "smartphone",
  twin: "brain-circuit",
}

/**
 * Build the payload. Copy is passed in rather than read here so this stays a
 * pure function the caller can drive with `useTranslations` — the module has no
 * business knowing which locale is active.
 *
 * @param t Resolver for an `onboarding.tour.*` key suffix.
 */
export function buildTourPayload(t: (key: string) => string): A2UIInteractiveGuideComponentDef {
  const steps: A2UIGuideStep[] = TOUR_SLIDE_IDS.map((id) => ({
    id,
    title: t(`${id}.title`),
    description: t(`${id}.description`),
    // No child components: each slide is title + description + the CTA the
    // host renders from `TOUR_SLIDE_HREFS`. Declaring content ids that resolve
    // to nothing would leave the renderer looking up dangling references.
    content: [],
    icon: TOUR_SLIDE_ICONS[id],
  }))

  return {
    id: "onboarding-tour",
    component: "InteractiveGuide",
    title: t("title"),
    steps,
    showProgress: true,
    showNavigation: true,
    showStepIndicator: true,
    // No onStepChange / onComplete / onSkip: A2UI actions are dispatched to the
    // agent runtime, and there is no agent behind a surface nothing generated,
    // so any action declared here would be emitted into a void. Navigation to
    // the six Settings pages is host-side — see `CapabilityTour`.
    // The tour is entirely optional now that it is off the critical path, so
    // leaving is always one click away.
    allowSkip: true,
  }
}

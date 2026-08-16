"use client"

import { useEffect, useMemo } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  BrainCircuitIcon,
  CableIcon,
  ScanTextIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react"

import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { A2UIRenderer } from "@/components/a2ui/a2ui-renderer"
import { Button } from "@/components/ui/button"
import {
  TOUR_SLIDE_HREFS,
  TOUR_SLIDE_IDS,
  buildTourPayload,
  type TourSlideId,
} from "@/lib/onboarding/tour-payload"
import { useA2UIStore } from "@/stores/a2ui/a2ui-store"
import type { A2UIComponent } from "@/types/artifact/a2ui"

/** Fixed surface id — one tour, reused every time it is opened. */
const TOUR_SURFACE_ID = "onboarding-tour"

const ICONS: Record<TourSlideId, LucideIcon> = {
  sandbox: ShieldCheckIcon,
  ocr: ScanTextIcon,
  computerUse: TerminalIcon,
  connectors: CableIcon,
  mobile: SmartphoneIcon,
  twin: BrainCircuitIcon,
}

/**
 * The six capability slides, rendered through the A2UI `InteractiveGuide`
 * component (ADR-0122, decisions 11 and 17).
 *
 * **The payload is a constant, not a model turn.** That is the whole point: a
 * user who skipped the provider step has no model at all, and they are exactly
 * the person most in need of "what can this thing do". `buildTourPayload`
 * returns the same object every time, so this surface is deterministic,
 * offline, and free.
 *
 * **It goes through the real A2UI stack** — a registered surface, the provider,
 * the renderer — rather than importing `A2UIInteractiveGuide` directly. That
 * component had been registered in the renderer with zero product authors;
 * reaching around it would have left it that way, and would not have worked
 * anyway, since it reads the A2UI data context.
 *
 * **The payload emits no actions.** A2UI actions are dispatched to the agent
 * runtime, and there is no agent behind a surface nothing generated — an
 * `onStepChange` here would be sent into a void. So the deep links live outside
 * the guide, as a row covering all six subsystems. That also beats a single CTA
 * tied to the visible slide: the user can jump to whichever one they came for,
 * without paging to it first.
 */
export function CapabilityTour() {
  const t = useTranslations("onboarding.tour")
  const router = useRouter()
  const createSurface = useA2UIStore((s) => s.createSurface)
  const updateComponents = useA2UIStore((s) => s.updateComponents)

  const payload = useMemo(() => buildTourPayload((key) => t(key)), [t])

  useEffect(() => {
    createSurface(TOUR_SURFACE_ID, "inline", { title: payload.title as string })
    updateComponents(TOUR_SURFACE_ID, [payload as unknown as A2UIComponent])
  }, [createSurface, updateComponents, payload])

  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-capability-tour">
      <A2UIProvider
        surfaceId={TOUR_SURFACE_ID}
        renderComponent={(component) => <A2UIRenderer key={component.id} component={component} />}
      >
        <A2UIRenderer component={payload as unknown as A2UIComponent} />
      </A2UIProvider>

      <div className="flex flex-wrap gap-2">
        {TOUR_SLIDE_IDS.map((id) => {
          const Icon = ICONS[id]
          return (
            <Button
              key={id}
              variant="outline"
              size="sm"
              onClick={() => router.push(TOUR_SLIDE_HREFS[id])}
              data-testid={`onboarding-tour-cta-${id}`}
            >
              <Icon className="size-3.5" aria-hidden />
              {t(`${id}.cta`)}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

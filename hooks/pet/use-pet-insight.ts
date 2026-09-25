"use client"

/**
 * Pet insight teaser — when a fresh Attention Radar report lands, the pet says
 * so in a bubble that offers "Open Insights", the console tab where the report
 * is read. Main-window only (this hook lives in the widget); the bubble, its
 * action included, mirrors to the overlay over the cross-window bridge.
 *
 * Detection is not done here any more. `lib/pet/events/sources/radar-source.ts`
 * emits `radarReport` on the pet's event bus, which is also what turns the pet
 * `happy`, so the visual state and the bubble can no longer disagree about
 * whether a report is new. That source owns the baseline (a pre-existing report
 * never fires) and the radar's own opt-in. The event carries only the report
 * id; the text is read here.
 *
 * The line is the report's own `verdict` (or its first at-a-glance point),
 * spoken through `sayAsPet`: it is model-derived text about what the user has
 * been reading, so it takes the PII gate and the shared speak budget like every
 * other authored line. When the gate refuses it, the limiter is spent, or the
 * report has nothing to say, a fixed line announces the report instead, so a
 * fresh report is never silently lost. Muting bubbles is the caller's switch
 * (`enabled`), and a muted pet stays quiet.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { getRadarReport } from "@/lib/db/radar-reports"
import { bubbleActionForKind } from "@/lib/pet/bubbles/action"
import { sayAsPet } from "@/lib/pet/bubbles/say"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { usePetStore } from "@/stores/pet/pet-store"
import { loggers } from "@cognia/logging"

/** Long enough to read the line and reach the button. */
export const INSIGHT_BUBBLE_MS = 10_000

/** Authored fallback lines under `pet.insight.fallback.<n>`. */
const FALLBACK_VARIANTS = 2

export function usePetInsight(enabled: boolean): void {
  const t = useTranslations("pet")

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    const off = getPetEventBus().subscribe((event) => {
      if (event.kind !== "radarReport") return
      const reportId = typeof event.meta?.reportId === "string" ? event.meta.reportId : null
      const action = bubbleActionForKind("radarReport")
      void (async () => {
        let line = ""
        try {
          const report = reportId ? await getRadarReport(reportId) : undefined
          line = report?.verdict?.trim() || report?.atAGlance?.[0]?.trim() || ""
        } catch (err) {
          loggers.app.warn("pet insight: could not read the radar report", {
            error: String(err),
          })
        }
        if (disposed) return
        const said = line
          ? sayAsPet(line, { origin: "system", action, durationMs: INSIGHT_BUBBLE_MS })
          : null
        if (said?.ok) return
        // Nothing sayable: announce the report with fixed copy (no content, so
        // no gate), keeping the action so the report is one click away.
        const text = t(`insight.fallback.${Math.abs(Math.trunc(event.at)) % FALLBACK_VARIANTS}`)
        const store = usePetStore.getState()
        store.setBubble({ text, origin: "template", ...(action ? { action } : {}) })
        setTimeout(() => {
          // Only clear our own bubble; a newer one must not be cut short.
          if (usePetStore.getState().bubble?.text === text) usePetStore.getState().setBubble(null)
        }, INSIGHT_BUBBLE_MS)
      })()
    })
    return () => {
      disposed = true
      off()
    }
  }, [enabled, t])
}

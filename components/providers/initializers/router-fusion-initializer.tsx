"use client"

// Router + Fusion boot wiring (ADR-0188 D38/D39), desktop window only.
//
//  1. Breaker persistence: a surface that tripped stays on the original path
//     across restarts, and the user is told when a surface trips. This only
//     subscribes to the in-memory breaker; it writes nothing unless a surface
//     is on and actually trips.
//  2. Boot recovery: once any wired surface is on, seal the runs a closed
//     window left holding a session lock or a budget hold, and replay their
//     outbox. Since B2 that is not only chat: a utility call, a workflow prompt
//     or a Run API run can be abandoned the same way.
//  3. Retention: while any wired surface is on, apply the fusion database's
//     retention now and daily (expired artifact content, idempotency keys, the
//     trail of long-finished runs).
//
// With every switch off nothing is loaded and the fusion database is never
// opened — every step is behind the zero-import gate.

import { useEffect } from "react"
import { useTranslations } from "next-intl"

import {
  effectiveSurface,
  WIRED_ROUTER_FUSION_SURFACES,
} from "@cognia/router-fusion/settings/switches"
import { recoverRouterFusionRuns, startRouterFusionRetention } from "@/lib/router-fusion/gate/boot"
import {
  startBreakerPersistence,
  type PersistedTrips,
} from "@/lib/router-fusion/gate/breaker-persistence"
import { settingsHref } from "@/lib/settings/deep-link"
import { useSettingsStore } from "@/stores/settings"

async function writeTrips(trips: PersistedTrips): Promise<void> {
  const { saveRouterFusionSettings } =
    await import("@/lib/router-fusion/settings/save-router-fusion-settings")
  await saveRouterFusionSettings({ trippedSurfaces: trips })
}

export function RouterFusionInitializer() {
  const t = useTranslations("routerFusion")
  const loaded = useSettingsStore((s) => s.loaded)
  const anyOn = useSettingsStore((s) =>
    WIRED_ROUTER_FUSION_SURFACES.some((surface) =>
      effectiveSurface(s.settings?.routerFusion, surface)
    )
  )

  useEffect(() => {
    if (!loaded) return
    return startBreakerPersistence({
      readTrips: () => useSettingsStore.getState().settings?.routerFusion?.trippedSurfaces,
      writeTrips,
      notifyTripped: (surface, trip) => {
        void import("@/lib/notifications/runtime")
          .then(({ notify }) =>
            notify({
              source: "system",
              level: "warning",
              title: t("breakerToast.title", {
                surface: t(`settings.surface.${surface}.label` as never),
              }),
              body: t("breakerToast.body", { reason: trip.reason }),
              channels: ["center", "toast"],
              dedupeKey: `router-fusion-breaker-${surface}`,
              href: settingsHref("ai-connections"),
            })
          )
          .catch((error) => console.warn("[router-fusion] breaker notice failed", error))
      },
    })
  }, [loaded, t])

  useEffect(() => {
    if (!loaded || !anyOn) return
    void recoverRouterFusionRuns(useSettingsStore.getState().settings)
  }, [loaded, anyOn])

  useEffect(() => {
    if (!loaded || !anyOn) return
    return startRouterFusionRetention(() => useSettingsStore.getState().settings)
  }, [loaded, anyOn])

  return null
}

export default RouterFusionInitializer

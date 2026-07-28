"use client"

/**
 * Root-mounted sink for diagnostics raised outside React.
 *
 * This is where a code becomes text: `lib/` emits a locale-free
 * {@link CogniaDiagnostic} on the bus, and this component resolves its label
 * and files it through `notify()` — the notification center (ADR-0042), which
 * already owns durable storage, dedupe-with-count, DND, per-source mute and
 * fan-out to toast / OS. It is NOT re-implemented here; an earlier draft grew
 * its own sonner call and immediately bypassed all of that.
 *
 * Deliberately additive: it does not intercept the paths that already surface
 * their own errors (the chat card, `PluginErrorToaster`). It exists to give the
 * previously-silent sources somewhere to land.
 *
 * Sibling of `PluginErrorToaster`, mounted the same way and for the same reason.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { subscribeDiagnostic } from "@/lib/diagnostics/bus"
import { resolveSurface } from "@/lib/diagnostics/surface-router"
import { CASCADE_WINDOW_MS } from "@/lib/diagnostics/cascade"
import { toNotificationInput } from "@/lib/diagnostics/notification-mapping"
import { notify } from "@/lib/notifications/runtime"
import { actionI18nKey } from "@cognia/diagnostics"
import type { DiagnosticActionKind } from "@cognia/diagnostics"

export function DiagnosticNotifier() {
  const t = useTranslations("diagnostics")
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    /** Raise times inside the cascade window, for the burst check. */
    const recent: number[] = []

    return subscribeDiagnostic(({ diagnostic, origin }) => {
      const now = diagnostic.at
      // Trim first, so a long-idle app doesn't count yesterday's failures.
      while (recent.length > 0 && now - recent[0] > CASCADE_WINDOW_MS) recent.shift()
      recent.push(now)

      const decision = resolveSurface(diagnostic, {
        origin: origin ?? { kind: "background" },
        // Anything raised through the bus is unwatched by construction: a
        // surface the user is looking at renders its own card inline instead.
        watching: false,
        hasInlineHost: false,
        recentCount: recent.length,
        bootScope: diagnostic.severity === "fatal",
      })

      // A `modal` decision belongs to the component that owns that dialog (the
      // blocked-upgrade dialog subscribes to its own signal). The durable record
      // is still worth writing so the condition survives that dialog unmounting.
      const tr = tRef.current
      const labelKey = `code.${diagnostic.code}.label`

      void notify(
        toNotificationInput(diagnostic, {
          ...(origin ? { origin } : {}),
          resolveTitle: () => (tr.has(labelKey) ? tr(labelKey) : diagnostic.code),
          resolveActionLabel: (kind: DiagnosticActionKind) => {
            const key = `action.${actionI18nKey(kind)}`
            return tr.has(key) ? tr(key) : kind
          },
          ...(decision.collapsed
            ? { collapsed: true, collapsedTitle: tr("surface.cascade", { count: recent.length }) }
            : {}),
        })
      ).catch(() => {
        // `dispatchDiagnostic` already wrote the structured log line, so the
        // failure is not lost. A notification-center write that throws must not
        // propagate out of an event subscriber.
      })
    })
  }, [])

  return null
}

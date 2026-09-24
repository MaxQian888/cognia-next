"use client"

/**
 * The functional toast's host component — what `showToast` mounts through
 * `toast.custom`. It owns the render-time half of the contract: translations,
 * locale and the render clock go into the factory context, the registry turns
 * the record into a spec, and the frame draws it. When the factory returns
 * null (a record from before the meta existed, or a producer that ships no
 * structured payload) the card falls back to title+body inside the same
 * chrome rather than leaving a hole in the stack.
 */

import { useMemo } from "react"
import { useLocale, useNow, useTranslations } from "next-intl"

import { useTriggerText } from "@/components/scheduler/kind-visuals"
import type { NotificationRecord } from "@/types/notifications"

import { FunctionalToast } from "./frame"
import { resolveFunctionalToastSpec } from "./registry"
import type { FunctionalToastActionSpec, FunctionalToastSpec } from "./types"

export function FunctionalToastCard({
  rec,
  onAction,
  onDismiss,
}: {
  rec: NotificationRecord
  onAction: (action: FunctionalToastActionSpec) => void
  onDismiss: () => void
}) {
  const t = useTranslations("functionalToast")
  const locale = useLocale()
  const triggerText = useTriggerText()
  // The timeline's render clock — minute granularity is finer than any chip
  // the card shows, and useNow keeps it out of the impure-during-render rule.
  const now = useNow({ updateInterval: 60_000 })
  const spec = useMemo<FunctionalToastSpec | null>(
    () =>
      resolveFunctionalToastSpec(rec, {
        t: (key, values) => t(key as never, values as never),
        locale,
        now: now.getTime(),
        triggerText,
      }),
    [rec, t, locale, now, triggerText]
  )

  return (
    <FunctionalToast
      spec={spec ?? fallbackSpec(rec, t)}
      onAction={onAction}
      onDismiss={onDismiss}
      dismissLabel={t("dismiss")}
    />
  )
}

/** Plain title/body inside the shared chrome — the factory-less record. */
function fallbackSpec(rec: NotificationRecord, t: (key: string) => string): FunctionalToastSpec {
  return {
    icon: null,
    eyebrow: { text: t("generic"), tone: "muted" },
    title: rec.title,
    body: rec.body ? (
      <p className="mt-1.5 line-clamp-3 text-[12px] leading-snug text-muted-foreground">
        {rec.body}
      </p>
    ) : undefined,
    actions: rec.actions?.slice(0, 3).map((action) => ({
      id: action.id,
      label: action.label,
      strong: action.variant === "primary",
      notificationAction: action,
    })),
  }
}

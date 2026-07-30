/**
 * Locale-resolved strings for scheduler-driven IM deliveries.
 *
 * Why a bag and not next-intl: this code runs in the connector runtime, which is
 * not a React tree, so `useTranslations()` is unavailable. The repo has two
 * precedents for IM-outbound text — `runtime.ts`'s `IM_FAILURE_NOTICE` uses
 * inline bilingual strings because those call sites have no `AppSettings`, while
 * `lib/connectors/activity/i18n.ts` resolves by locale because its call site
 * does. The scheduled-digest path already loads `AppSettings` (it needs
 * `resolveSendOptions`), so it follows the locale-resolved precedent.
 *
 * Kept separate from `activity/i18n.ts` because that bag is the live-activity
 * card's vocabulary; this one is the scheduler→IM seam, and W2.2's notification
 * titles belong here too rather than widening the card's bag.
 */

export interface ScheduledNoticeI18n {
  /**
   * Prefix for a delivery that fired from a missed slot — the operator needs to
   * know the content is for an earlier time, or a digest arriving at 09:12 reads
   * as if it were the 09:12 state.
   */
  lateDelivery: (scheduledFor: string) => string
}

const EN: ScheduledNoticeI18n = {
  lateDelivery: (scheduledFor) => `_Delayed — scheduled for ${scheduledFor}._`,
}

const ZH: ScheduledNoticeI18n = {
  lateDelivery: (scheduledFor) => `_延迟送达 —— 原定 ${scheduledFor}。_`,
}

const MAPS: Record<string, ScheduledNoticeI18n> = {
  en: EN,
  "en-US": EN,
  "zh-CN": ZH,
  zh: ZH,
  "zh-Hans": ZH,
}

/**
 * Resolve the scheduled-notice bag. Falls back to English for an unrecognized
 * locale so an unknown setting never produces empty text.
 */
export function resolveScheduledNoticeI18n(locale: string | undefined | null): ScheduledNoticeI18n {
  if (locale && MAPS[locale]) return MAPS[locale]
  return EN
}

/**
 * Format the slot a late delivery was scheduled for. Uses the host locale's
 * short date+time — the operator is reading it in a chat window, not parsing it.
 */
export function formatScheduledSlot(slot: Date, locale: string | undefined | null): string {
  try {
    return new Intl.DateTimeFormat(locale ?? "en", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(slot)
  } catch {
    // An invalid locale tag must not cost the delivery.
    return slot.toISOString()
  }
}

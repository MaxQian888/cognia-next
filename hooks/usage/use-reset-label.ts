"use client"

/**
 * One phrasing for "when does this quota window reset", shared by every surface
 * that shows one: the Subscription meters (`MeterRow`), the desktop status-bar
 * popover that reuses them, and the in-transcript `/usage` card.
 *
 * Near resets read as a countdown ("Resets in 2h 41m"); anything a day or more
 * out reads as a weekday + clock time ("Resets Mon 8:00 AM"), because the weekly
 * windows were rendering as three-digit hour counts nobody could act on. The
 * cutover point and the expired/unknown cases live in the pure
 * {@link describeReset}; this hook only resolves the i18n key and formats the
 * instant in the active locale.
 */

import { useLocale, useTranslations } from "next-intl"

import { describeReset, type ResetDescriptor } from "@/lib/subscription/anthropic/usage-analytics"

export interface UseResetLabelOptions {
  /**
   * Translation namespace holding `resetsInHm` / `resetsInM` / `resetsAt` /
   * `resetExpired`. Defaults to `subscription.limits`; the Usage tab's gauges
   * live under `subscription.usage.window` and pass their own.
   */
  namespace?: string
}

/**
 * Format one reset instant. Returns `null` when the window reported no reset
 * time at all — callers render nothing rather than inventing "unknown", since
 * a missing countdown is already visible as a missing line.
 */
export function useResetLabel(
  resetAt: number | null | undefined,
  now: number,
  options: UseResetLabelOptions = {}
): string | null {
  const { namespace = "subscription.limits" } = options
  const t = useTranslations(namespace)
  const locale = useLocale()
  const descriptor = describeReset(resetAt, now)
  return formatResetDescriptor(descriptor, locale, (key, values) => t(key, values))
}

/** Locale-aware "Mon 8:00 AM" for an absolute reset instant. */
export function formatResetInstant(at: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(at))
  } catch {
    // An unsupported locale tag must not take the whole card down.
    return new Date(at).toLocaleString()
  }
}

/**
 * Pure projection of a descriptor onto a label, with the translator injected.
 * Exported so non-hook call sites (and tests) can reuse the exact same mapping.
 */
export function formatResetDescriptor(
  descriptor: ResetDescriptor,
  locale: string,
  translate: (key: string, values?: Record<string, string | number>) => string
): string | null {
  switch (descriptor.kind) {
    case "unknown":
      return null
    case "expired":
      return translate("resetExpired")
    case "absolute":
      return translate("resetsAt", { at: formatResetInstant(descriptor.at, locale) })
    case "countdown":
      return descriptor.hours > 0
        ? translate("resetsInHm", { hours: descriptor.hours, minutes: descriptor.minutes })
        : translate("resetsInM", { minutes: descriptor.minutes })
  }
}

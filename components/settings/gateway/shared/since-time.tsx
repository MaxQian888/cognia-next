"use client"

/**
 * "How long ago" for a past instant, with the absolute time on hover.
 *
 * Two traps in formatting it inline, which is how the gateway panels first
 * did it:
 *
 * - Status is re-read every 5s but `useNow` ticks slower, so an event newer
 *   than the last tick is in the *future* relative to it and `relativeTime`
 *   renders "in 4 seconds" — which zh-CN turns into "4秒钟后发布", a promise.
 *   The instant is clamped to `now`.
 * - Inside the first minute `relativeTime` says "now" / "现在", which reads as
 *   an instruction ("现在发布" = "publish now") once it is dropped into a
 *   sentence. That window gets its own "just now" wording instead.
 */

import type { ReactNode } from "react"
import { useFormatter, useTranslations } from "next-intl"

/** Below this age an instant is "just now". */
export const JUST_NOW_MS = 60_000

const FULL_TIMESTAMP = { dateStyle: "medium", timeStyle: "medium" } as const

export interface SinceTimeProps {
  date: Date
  now: Date
  /** Wraps the relative phrase, e.g. into "published {time}". */
  label?: (relative: string) => ReactNode
}

export function SinceTime({ date, now, label }: SinceTimeProps) {
  const t = useTranslations("settings.gateway")
  const format = useFormatter()
  const age = now.getTime() - date.getTime()
  const relative = age < JUST_NOW_MS ? t("justNow") : format.relativeTime(date, now)

  return (
    <time dateTime={date.toISOString()} title={format.dateTime(date, FULL_TIMESTAMP)}>
      {label ? label(relative) : relative}
    </time>
  )
}

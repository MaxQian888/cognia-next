"use client"

// The lock screen's backdrop, and the clock and greeting that sit on it.
//
// Rendered BEHIND the unlock card, never around it. That separation is the
// whole safety property of the feature: the card keeps its own surface and its
// own contrast whatever the backdrop is doing, so no combination of wallpaper,
// blur and dim can make the password field hard to read.
//
// The dim layer is not decoration. A bright photograph behind a translucent
// card is exactly the case that turns a lock screen into a guessing game, so
// the dim is applied over the image and defaults high.

import { useEffect, useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { resolveSourceToCss } from "@/lib/appearance/wallpaper-storage"
import { withBuiltinPresets } from "@/lib/appearance/presets"
import { prefersReducedMotion } from "@/lib/appearance/reduced-motion"
import {
  clampLockBlur,
  clampLockDim,
  greetingKeyForHour,
  type LockScreenSettings,
} from "@/types/appearance/lock-screen"
import type { Wallpaper } from "@/types/appearance"

export interface LockScreenBackdropProps {
  settings: LockScreenSettings
  /**
   * The wallpaper the app was last showing. Passed in rather than read,
   * because the settings row it lives in is locked at this moment.
   */
  activeWallpaperId?: string | null
  /** The gallery to resolve ids against. Defaults to the built-in presets. */
  wallpapers?: Wallpaper[]
  /** Injectable so the settings preview can pin a time. */
  now?: Date
}

export function LockScreenBackdrop({
  settings,
  activeWallpaperId = null,
  wallpapers,
  now,
}: LockScreenBackdropProps) {
  const t = useTranslations("account.lockScreen")
  const format = useFormatter()
  const [image, setImage] = useState<string | null>(null)
  const [tick, setTick] = useState(() => now ?? new Date())

  const gallery = useMemo(() => withBuiltinPresets(wallpapers ?? []), [wallpapers])

  // Which wallpaper, if any, this backdrop wants.
  const wallpaperId =
    settings.backdrop === "wallpaper"
      ? activeWallpaperId
      : settings.backdrop === "pinned"
        ? settings.pinnedWallpaperId
        : null

  useEffect(() => {
    let cancelled = false
    // Every branch resolves through the same promise rather than calling
    // setState synchronously first. A missing or deleted wallpaper degrades to
    // the theme backdrop, because being unable to see the unlock card is never
    // an acceptable outcome of a decoration setting.
    const wallpaper = wallpaperId
      ? (gallery.find((entry) => entry.id === wallpaperId) ?? null)
      : null
    const pending = wallpaper
      ? resolveSourceToCss(wallpaper.source).catch(() => null)
      : Promise.resolve(null)

    void pending.then((css) => {
      if (!cancelled) setImage(css)
    })
    return () => {
      cancelled = true
    }
  }, [wallpaperId, gallery])

  // The clock only ticks when there is a clock. A lock screen with no clock
  // must not re-render once a second for nothing.
  const wantsClock = settings.clock !== "none"
  useEffect(() => {
    if (!wantsClock || now) return
    const timer = window.setInterval(() => setTick(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [wantsClock, now])

  const current = now ?? tick
  const motion = settings.respectSystemMotion && prefersReducedMotion() ? "none" : settings.motion

  const greeting =
    settings.greeting === "custom"
      ? settings.customGreeting.trim()
      : settings.greeting === "timeOfDay"
        ? t(`greeting.${greetingKeyForHour(current.getHours())}`)
        : null

  const hourCycleOptions =
    settings.hourCycle === "auto" ? {} : { hour12: settings.hourCycle === "h12" }

  // The DEVICE's timezone, explicitly, not whatever next-intl is configured
  // with. A clock on a lock screen answers "what time is it here", and the
  // greeting above it is already derived from local hours, so leaving the two
  // on different clocks would let them disagree: "Good morning" over 01:41 AM
  // is exactly what this produced before it was pinned.
  const timeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return undefined
    }
  }, [])

  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        data-testid="lock-screen-backdrop"
        data-backdrop={settings.backdrop}
        data-motion={motion}
      >
        {settings.backdrop === "solid" && (
          <div className="absolute inset-0" style={{ background: settings.solidColor }} />
        )}

        {image && (
          <div
            className={cn(
              "absolute inset-0 bg-cover bg-center",
              motion === "drift" &&
                "motion-safe:animate-[cognia-ken-burns_60s_ease-in-out_infinite_alternate]"
            )}
            style={{
              backgroundImage: image,
              filter: `blur(${clampLockBlur(settings.blurPx)}px)`,
              // Scaled up so the blur does not reveal the layer's own edges.
              transform: settings.blurPx > 0 ? "scale(1.08)" : undefined,
            }}
            data-testid="lock-screen-backdrop-image"
          />
        )}

        {/* The dim. Applied over the image and under the card, which is what
            keeps the unlock field legible on a bright photograph. */}
        {(image !== null || settings.backdrop === "solid") && (
          <div
            className="absolute inset-0 bg-black"
            style={{ opacity: clampLockDim(settings.dim) }}
            data-testid="lock-screen-backdrop-dim"
          />
        )}

        {motion === "aurora" && (
          <div
            className="absolute inset-0 opacity-40 mix-blend-screen motion-safe:animate-[cognia-aurora_18s_ease-in-out_infinite_alternate]"
            style={{
              background:
                "radial-gradient(60% 60% at 30% 30%, var(--primary) 0%, transparent 60%), radial-gradient(50% 50% at 70% 70%, var(--accent) 0%, transparent 60%)",
            }}
            data-testid="lock-screen-backdrop-aurora"
          />
        )}
      </div>

      {(greeting || wantsClock) && (
        <div
          className="flex flex-col items-center gap-1 text-center"
          data-testid="lock-screen-clock"
        >
          {greeting && (
            <p className="text-sm text-muted-foreground" data-testid="lock-screen-greeting">
              {greeting}
            </p>
          )}
          {wantsClock && (
            <>
              <p className="text-5xl font-light tabular-nums" data-testid="lock-screen-time">
                {format.dateTime(current, {
                  hour: "2-digit",
                  minute: "2-digit",
                  ...(timeZone ? { timeZone } : {}),
                  ...hourCycleOptions,
                })}
              </p>
              {settings.clock === "timeAndDate" && (
                <p className="text-xs text-muted-foreground" data-testid="lock-screen-date">
                  {format.dateTime(current, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    ...(timeZone ? { timeZone } : {}),
                  })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
}

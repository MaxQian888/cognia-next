"use client"

/**
 * Shared vocabulary for the device console: how reachability, lifecycle state,
 * device kind, a capability cell, and a grant look wherever they appear.
 *
 * Same discipline as `components/servers/server-visuals.tsx` — a fleet reads
 * wrong if the same state is one colour in the list and another in the detail,
 * so the mapping lives here once instead of being re-picked per component. The
 * palettes are deliberately the same four hues that workspace already uses, so
 * a user who has learned "amber means look at this" does not have to relearn
 * it one route over.
 */

import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  LaptopIcon,
  ServerIcon,
  SmartphoneIcon,
  CpuIcon,
  type LucideIcon,
} from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type {
  DeviceAdminState,
  DeviceCapabilityState,
  DeviceGrantState,
  DeviceKind,
  DeviceReachability,
} from "@/lib/devices/types"
import { cn } from "@/lib/utils"

export const DEVICE_REACHABILITIES: readonly DeviceReachability[] = [
  "online",
  "recently-active",
  "offline",
  "unknown",
]

/**
 * `unknown` is muted rather than a fifth hue: "we have never heard from it" is
 * the absence of a signal, not a fifth severity. `recently-active` is amber
 * because it is the state that needs a second look — the device is worth
 * showing but must not be treated as able to act.
 */
const REACHABILITY_DOT: Record<DeviceReachability, string> = {
  online: "bg-emerald-500",
  "recently-active": "bg-amber-500",
  offline: "bg-muted-foreground/40",
  unknown: "bg-muted-foreground/50",
}

const REACHABILITY_TEXT: Record<DeviceReachability, string> = {
  online: "text-emerald-600 dark:text-emerald-400",
  "recently-active": "text-amber-600 dark:text-amber-400",
  offline: "text-muted-foreground",
  unknown: "text-muted-foreground",
}

const REACHABILITY_ICON: Record<DeviceReachability, LucideIcon> = {
  online: CircleCheckIcon,
  "recently-active": CircleAlertIcon,
  offline: CircleSlashIcon,
  unknown: CircleDashedIcon,
}

const ADMIN_TONE: Record<DeviceAdminState, string> = {
  active: "text-muted-foreground",
  paused: "text-amber-600 dark:text-amber-400",
  revoked: "text-destructive",
  unknown: "text-muted-foreground",
}

const KIND_ICON: Record<DeviceKind, LucideIcon> = {
  local: LaptopIcon,
  "paired-device": SmartphoneIcon,
  "remote-host": ServerIcon,
  worker: CpuIcon,
}

/**
 * Capability tones.
 *
 * `expected` and `unknown` share amber on purpose — both mean "nobody
 * confirmed this" — while `absent` is muted, because a device that answered
 * and simply lacks the capability has given us a real, unalarming fact.
 */
const CAPABILITY_TONE: Record<DeviceCapabilityState, string> = {
  reported: "text-emerald-600 dark:text-emerald-400",
  expected: "text-amber-600 dark:text-amber-400",
  absent: "text-muted-foreground",
  unknown: "text-amber-600 dark:text-amber-400",
}

const CAPABILITY_DOT: Record<DeviceCapabilityState, string> = {
  reported: "bg-emerald-500",
  expected: "bg-amber-500/60",
  absent: "bg-muted-foreground/30",
  unknown: "bg-amber-500/40",
}

const GRANT_TONE: Record<DeviceGrantState, string> = {
  granted: "text-emerald-600 dark:text-emerald-400",
  // Partial is the state this console exists to expose, so it gets the colour
  // that means "look at this" rather than sharing "off".
  partial: "text-amber-600 dark:text-amber-400",
  denied: "text-muted-foreground",
  unknown: "text-muted-foreground",
}

export function ReachabilityDot({
  reachability,
  className,
}: {
  reachability: DeviceReachability
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        REACHABILITY_DOT[reachability],
        className
      )}
    />
  )
}

export function ReachabilityLabel({
  reachability,
  className,
}: {
  reachability: DeviceReachability
  className?: string
}) {
  const t = useTranslations("devices")
  const Icon = REACHABILITY_ICON[reachability]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        REACHABILITY_TEXT[reachability],
        className
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t(`reachability.${reachability}`)}
    </span>
  )
}

/** Only rendered when it says something — an `active` device needs no badge. */
export function AdminStateBadge({ state }: { state: DeviceAdminState }) {
  const t = useTranslations("devices")
  if (state === "active") return null
  return (
    <Badge variant="outline" className={cn("font-normal", ADMIN_TONE[state])}>
      {t(`adminState.${state}`)}
    </Badge>
  )
}

export function DeviceKindIcon({ kind, className }: { kind: DeviceKind; className?: string }) {
  const Icon = KIND_ICON[kind]
  return (
    <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden="true" />
  )
}

export function DeviceKindLabel({ kind }: { kind: DeviceKind }) {
  const t = useTranslations("devices")
  return <>{t(`kind.${kind}`)}</>
}

export function CapabilityDot({
  state,
  className,
}: {
  state: DeviceCapabilityState
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        CAPABILITY_DOT[state],
        className
      )}
    />
  )
}

export function capabilityToneClass(state: DeviceCapabilityState): string {
  return CAPABILITY_TONE[state]
}

export function GrantStateBadge({ state }: { state: DeviceGrantState }) {
  const t = useTranslations("devices")
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", GRANT_TONE[state])}>
      <span className="inline-block size-1.5 rounded-full bg-current" aria-hidden="true" />
      {t(`grantState.${state}`)}
    </Badge>
  )
}

/**
 * "3 minutes ago" for an epoch-ms instant, in the app's locale.
 *
 * `@cognia/time`'s `formatRelative` is hard-coded English, which was tolerable
 * for the old table and is not for a new surface — Working Rule 4 counts every
 * user-facing string, and "5m ago" is one.
 */
export function useDeviceRelativeTime(): (value: number | undefined) => string {
  const format = useFormatter()
  const t = useTranslations("devices")
  return (value) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return t("never")
    return format.relativeTime(new Date(value))
  }
}

export function useDeviceAbsoluteTime(): (value: number | undefined) => string {
  const format = useFormatter()
  const t = useTranslations("devices")
  return (value) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return t("notAvailable")
    return format.dateTime(new Date(value), { dateStyle: "medium", timeStyle: "short" })
  }
}

/**
 * Shorten a 64-character SPKI fingerprint keeping both ends.
 *
 * The old card truncated to the first 12 characters, which is exactly the part
 * two fingerprints are most likely to be compared on and least likely to
 * differ in a screenshot. Head-and-tail is what makes two of them
 * distinguishable at a glance — the same reasoning as `shortenDigest` in the
 * Servers workspace, applied to a different identifier.
 */
export function shortenFingerprint(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed.length <= 24) return trimmed
  return `${trimmed.slice(0, 12)}…${trimmed.slice(-8)}`
}

"use client"

/**
 * The Sites console's status vocabulary.
 *
 * Two rules hold the whole surface together:
 *
 *  1. **Every status is a tinted outline pill.** Exactly one solid badge is
 *     allowed on screen — the active deployment on the production-URL strip —
 *     so "this is live" never competes with six other filled chips.
 *  2. **Red means failure, never scope.** Resource *ownership* decides what a
 *     purge deletes, and it gets its own channel (a left-edge stripe plus an
 *     icon chip) in amber/neutral/blue. Painting "will be deleted" in red would
 *     read as "something is broken".
 *
 * Colours come from the semantic tokens registered in `app/globals.css`
 * (`success` / `info` / `warning` / `destructive`), so both themes track
 * automatically and no raw palette value appears here.
 */
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  GlobeIcon,
  HistoryIcon,
  KeyRoundIcon,
  LinkIcon,
  Loader2Icon,
  PauseCircleIcon,
  PackageIcon,
  RocketIcon,
  ShieldCheckIcon,
  ShieldIcon,
  TriangleAlertIcon,
  Trash2Icon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type {
  SiteDeploymentStatus,
  SiteLifecycle,
  SiteOperationEventType,
  SiteOperationStatus,
  SiteResourceKind,
  SiteResourceOwnership,
  SiteResourceStatus,
  SiteVersionStatus,
} from "@/types/sites"

export type SiteTone = "success" | "info" | "warning" | "danger" | "neutral"

export const SITE_TONE_PILL: Record<SiteTone, string> = {
  success: "border-success/40 bg-success/12 text-success",
  info: "border-info/40 bg-info/12 text-info",
  warning: "border-warning/45 bg-warning/15 text-warning",
  danger: "border-destructive/40 bg-destructive/12 text-destructive",
  neutral: "border-border bg-muted text-muted-foreground",
}

export const SITE_TONE_DOT: Record<SiteTone, string> = {
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground/40",
}

export const SITE_TONE_TEXT: Record<SiteTone, string> = {
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  danger: "text-destructive",
  neutral: "text-muted-foreground",
}

interface StatusFace {
  tone: SiteTone
  icon: LucideIcon
  /** Spinning glyph — the icon carries live progress, not decoration. */
  spin?: boolean
}

export const SITE_LIFECYCLE_FACE: Record<SiteLifecycle, StatusFace> = {
  active: { tone: "success", icon: GlobeIcon },
  "taken-down": { tone: "warning", icon: PauseCircleIcon },
  deleting: { tone: "danger", icon: Loader2Icon, spin: true },
  deleted: { tone: "neutral", icon: CircleSlashIcon },
}

export const SITE_VERSION_FACE: Record<SiteVersionStatus, StatusFace> = {
  building: { tone: "info", icon: Loader2Icon, spin: true },
  ready: { tone: "success", icon: CheckCircle2Icon },
  failed: { tone: "danger", icon: CircleAlertIcon },
}

export const SITE_DEPLOYMENT_FACE: Record<SiteDeploymentStatus, StatusFace> = {
  pending: { tone: "neutral", icon: CircleDashedIcon },
  deploying: { tone: "info", icon: Loader2Icon, spin: true },
  active: { tone: "success", icon: RocketIcon },
  failed: { tone: "danger", icon: CircleAlertIcon },
  superseded: { tone: "neutral", icon: HistoryIcon },
  "taken-down": { tone: "warning", icon: PauseCircleIcon },
}

export const SITE_OPERATION_FACE: Record<SiteOperationStatus, StatusFace> = {
  queued: { tone: "neutral", icon: CircleDashedIcon },
  running: { tone: "info", icon: Loader2Icon, spin: true },
  "waiting-reconcile": { tone: "warning", icon: CircleAlertIcon },
  succeeded: { tone: "success", icon: CheckCircle2Icon },
  failed: { tone: "danger", icon: CircleAlertIcon },
  cancelled: { tone: "neutral", icon: CircleSlashIcon },
}

export const SITE_EVENT_TONE: Record<SiteOperationEventType, SiteTone> = {
  queued: "neutral",
  claimed: "info",
  "waiting-reconcile": "warning",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
}

export const SITE_RESOURCE_FACE: Record<SiteResourceStatus, StatusFace> = {
  active: { tone: "success", icon: CheckCircle2Icon },
  deleting: { tone: "info", icon: Loader2Icon, spin: true },
  deleted: { tone: "neutral", icon: CircleSlashIcon },
  orphaned: { tone: "warning", icon: TriangleAlertIcon },
}

/** Ownership decides purge scope, so it never borrows the failure colour. */
export const SITE_OWNERSHIP_STRIPE: Record<SiteResourceOwnership, string> = {
  managed: "border-l-warning/70",
  adopted: "border-l-border",
  shared: "border-l-info/60",
}

export const SITE_OWNERSHIP_CHIP: Record<SiteResourceOwnership, string> = {
  managed: "border-warning/45 bg-warning/12 text-warning",
  adopted: "border-border bg-muted text-muted-foreground",
  shared: "border-info/40 bg-info/12 text-info",
}

export const SITE_OWNERSHIP_ICON: Record<SiteResourceOwnership, LucideIcon> = {
  managed: Trash2Icon,
  adopted: LinkIcon,
  shared: UsersIcon,
}

export const SITE_RESOURCE_KIND_ICON: Record<SiteResourceKind, LucideIcon> = {
  worker: PackageIcon,
  "worker-version": HistoryIcon,
  "d1-database": PackageIcon,
  "r2-bucket": PackageIcon,
  "custom-domain": LinkIcon,
  "access-application": ShieldIcon,
  "access-policy": ShieldCheckIcon,
  secret: KeyRoundIcon,
}

export interface SiteStatusPillProps {
  face: StatusFace
  label: string
  /**
   * Fill the pill instead of tinting it. Reserved for the single "this is the
   * current truth" badge — the active deployment beside the production URL.
   */
  solid?: boolean
  className?: string
  testId?: string
}

export function SiteStatusPill({ face, label, solid, className, testId }: SiteStatusPillProps) {
  const Icon = face.icon
  return (
    <Badge
      variant={solid ? "success" : "outline"}
      data-testid={testId}
      data-tone={face.tone}
      className={cn("gap-1 font-normal", !solid && SITE_TONE_PILL[face.tone], className)}
    >
      {/*
        Bare `animate-spin`, not `motion-safe:animate-spin`: the reduced-motion
        tier in `app/globals.css` deliberately exempts `.animate-spin` because
        removing distraction must not remove status.
      */}
      <Icon aria-hidden className={cn("size-3", face.spin && "animate-spin")} />
      {label}
    </Badge>
  )
}

export interface SiteOwnershipChipProps {
  ownership: SiteResourceOwnership
  label: string
  className?: string
}

export function SiteOwnershipChip({ ownership, label, className }: SiteOwnershipChipProps) {
  const Icon = SITE_OWNERSHIP_ICON[ownership]
  return (
    <Badge
      variant="outline"
      data-ownership={ownership}
      className={cn("gap-1 font-normal", SITE_OWNERSHIP_CHIP[ownership], className)}
    >
      <Icon aria-hidden className="size-3" />
      {label}
    </Badge>
  )
}

/** Small state dot used in the Site rail. */
export function SiteStatusDot({
  tone,
  live,
  className,
}: {
  tone: SiteTone
  /** Pulse while an operation is in flight. Degrades to a static dot under reduced motion. */
  live?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={cn(
        "size-1.5 shrink-0 rounded-full transition-colors duration-300 motion-reduce:transition-none",
        SITE_TONE_DOT[tone],
        live && "animate-pulse",
        className
      )}
    />
  )
}

"use client"

/**
 * Is this agent's CLI actually on the machine that would run it?
 *
 * The badge answers before the user commits to a preset, which is the whole
 * point: choosing `codex`, filling in a form, saving, connecting and only then
 * meeting `No such file or directory (os error 2)` is a long way to learn a
 * one-word fact the host knew all along.
 *
 * Four states, and none of them is a guess:
 *
 *   - **installed** carries the version when the probe could be read, and the
 *     resolved path in the tooltip. A version that could not be parsed still
 *     reads as installed, because it was found.
 *   - **missing** means the host looked on PATH and its known install roots and
 *     found nothing.
 *   - **package-runner** means the runtime launches through `npx`, so presence
 *     cannot be established without a network install. Saying "installed" or
 *     "missing" here would both be inventions.
 *   - **unknown** is the absence of an answer: nothing was asked, the host is
 *     still handshaking, or this device may not ask. It renders as nothing at
 *     all rather than as a neutral-looking "missing".
 */

import { useTranslations } from "next-intl"
import { CheckCircle2, CircleDashed, PackageOpen, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type {
  InstalledRuntime,
  RuntimeResolution,
} from "@/lib/ai/agent/external/installed-runtimes"
import { cn } from "@/lib/utils"

const VISUALS: Record<
  RuntimeResolution,
  {
    labelKey: string
    variant: "default" | "secondary" | "destructive" | "outline"
    Icon: typeof CheckCircle2
    tone: string
  }
> = {
  installed: {
    labelKey: "detectionInstalled",
    variant: "outline",
    Icon: CheckCircle2,
    tone: "text-emerald-600 dark:text-emerald-400",
  },
  missing: {
    labelKey: "detectionMissing",
    variant: "outline",
    Icon: XCircle,
    tone: "text-muted-foreground",
  },
  "package-runner": {
    labelKey: "detectionPackageRunner",
    variant: "outline",
    Icon: PackageOpen,
    tone: "text-muted-foreground",
  },
  "not-local": {
    labelKey: "detectionNotLocal",
    variant: "outline",
    Icon: CircleDashed,
    tone: "text-muted-foreground",
  },
}

export function RuntimeDetectionBadge({
  detection,
  showVersion = false,
  className,
}: {
  /** `undefined` means nothing is known, and the badge renders nothing. */
  detection: InstalledRuntime | undefined
  /** Append the version beside the label when one was read. */
  showVersion?: boolean
  className?: string
}) {
  const t = useTranslations("externalAgent")
  if (!detection) return null

  const visual = VISUALS[detection.resolution]
  // The versioned label SAYS "Installed", so only a runtime that is may wear
  // it. The wire shape allows `versionOutput` on any row, so a host reporting
  // the last-fetched version of a package-runner runtime would otherwise get
  // "Installed v1.2.3" drawn beside the not-installed icon, which is the one
  // thing none of these four states is allowed to be: a guess.
  const label =
    showVersion && detection.version && detection.resolution === "installed"
      ? t("detectionInstalledWithVersion", { version: detection.version })
      : t(visual.labelKey)

  const badge = (
    <Badge
      variant={visual.variant}
      className={cn("gap-1 text-[10px] font-normal", className)}
      data-detection={detection.resolution}
    >
      <visual.Icon className={cn("h-3 w-3", visual.tone)} aria-hidden="true" />
      {label}
    </Badge>
  )

  // The path is the part a user needs when the answer surprises them: two
  // `codex` binaries on one machine is common, and the badge is only useful if
  // it says which one the host would launch.
  const detail = detection.executablePath ?? detection.detail
  if (!detail) return badge

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-all font-mono text-[11px]">{detail}</TooltipContent>
    </Tooltip>
  )
}

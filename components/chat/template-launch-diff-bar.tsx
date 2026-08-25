"use client"

// "This template expects a different setup than the conversation you are in."
//
// It only ever offers. Inserting a template into a live conversation must not
// re-point the agent, the team or the repository underneath it: half the
// transcript would then have been produced by something other than what the
// header claims, and nothing in the history says when it changed. Starting a
// fresh conversation is the honest way to get the setup the template wants.
//
// Rendered above the composer, and only when something would actually differ —
// a bar that warns about non-changes is one people learn to dismiss unread.

import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { LaunchSpecDifference } from "@/lib/chat/template/launch-spec"

export interface TemplateLaunchDiffBarProps {
  /** What the template would change. Empty means the bar does not render. */
  differences: readonly LaunchSpecDifference[]
  /** Template name, so the bar says whose suggestion this is. */
  templateName: string
  /** Human labels for ids, so the bar reads "code reviewer" not "c_a1b2". */
  labelFor?: (difference: LaunchSpecDifference) => string
  onStartNewSession(): void
  onDismiss(): void
  className?: string
}

export function TemplateLaunchDiffBar({
  differences,
  templateName,
  labelFor,
  onStartNewSession,
  onDismiss,
  className,
}: TemplateLaunchDiffBarProps) {
  const t = useTranslations("chat.composer.launchDiff")
  if (differences.length === 0) return null

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs",
        className
      )}
      data-testid="template-launch-diff-bar"
    >
      <span className="text-muted-foreground">{t("summary", { name: templateName })}</span>
      {differences.map((difference) => (
        <span
          key={difference.field}
          className="rounded-md bg-background/70 px-1.5 py-0.5 font-medium"
          data-launch-diff-field={difference.field}
        >
          {labelFor?.(difference) ?? difference.wanted}
        </span>
      ))}
      <span className="ms-auto flex items-center gap-1">
        <Button size="sm" variant="secondary" className="h-6 text-xs" onClick={onStartNewSession}>
          {t("startNew")}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          aria-label={t("dismiss")}
          onClick={onDismiss}
        >
          <XIcon className="size-3.5" />
        </Button>
      </span>
    </div>
  )
}

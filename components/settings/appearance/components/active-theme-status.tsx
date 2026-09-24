"use client"

/**
 * "Active", said precisely.
 *
 * A theme card used to say only "Active". There is one active theme for both
 * modes, and the light / dark radio picks which of its palettes is painted, so
 * a dark theme such as Dracula read "Active" while the app sat in light mode
 * showing something that did not look like Dracula at all. It looked as if the
 * selection had not taken. These two pieces say which mode the theme is active
 * for and what the current mode is actually painting (see
 * `lib/appearance/active-theme-variant.ts` for the four states).
 *
 * The `dormant` state is intentional (a single-palette theme contributes
 * nothing outside its own mode) and is labeled inert here: muted, marked
 * `data-dormant`, and worded "inactive in … mode" rather than just "Active".
 */

import { CircleSlashIcon, InfoIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ActiveThemeVariant } from "@/lib/appearance/active-theme-variant"
import { cn } from "@/lib/utils"

/**
 * The message key for a status, under `activeVariant.badge` / `.applied`.
 *
 * Plain per-mode keys rather than ICU `select`, so each sentence is a whole
 * sentence for the translator. `fixed` reads the same in both modes. A dormant
 * theme that records its own variant says which mode it belongs to and when it
 * applies again (`dormantOnly.<its variant>`); one that records none, or that
 * is dormant in its own mode, says only that it is inactive in this mode.
 */
export function activeThemeMessageKey(status: ActiveThemeVariant): string {
  if (status.kind === "fixed") return "fixed"
  if (
    status.kind === "dormant" &&
    status.themeVariant !== null &&
    status.themeVariant !== status.mode
  ) {
    return `dormantOnly.${status.themeVariant}`
  }
  return `${status.kind}.${status.mode}`
}

/**
 * The badge on an active theme card. `status` is `null` while next-themes has
 * not resolved a mode yet, when the plain label is all that can be said.
 */
export function ActiveThemeBadge({
  status,
  className,
}: {
  status: ActiveThemeVariant | null
  className?: string
}) {
  const t = useTranslations("settings.appearance.vscode")
  if (!status) {
    return (
      <span className={cn("text-[10px] text-primary", className)} data-testid="active-theme-badge">
        {t("activeLabel")}
      </span>
    )
  }
  const dormant = status.kind === "dormant"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px]",
        dormant ? "text-muted-foreground" : "text-primary",
        className
      )}
      data-testid="active-theme-badge"
      data-active-kind={status.kind}
      data-dormant={dormant || undefined}
    >
      {dormant && <CircleSlashIcon className="size-3 shrink-0" aria-hidden />}
      {t(`activeVariant.badge.${activeThemeMessageKey(status)}`)}
    </span>
  )
}

/**
 * One sentence under a theme list that says what the current mode is painting
 * from the active theme. Announced politely when the mode flips.
 */
export function ActiveThemeAppliedNote({
  status,
  name,
  className,
}: {
  status: ActiveThemeVariant | null
  name: string | null
  className?: string
}) {
  const t = useTranslations("settings.appearance.vscode")
  if (!status || !name) return null
  const dormant = status.kind === "dormant"
  const Icon = dormant ? CircleSlashIcon : InfoIcon
  return (
    <p
      role="status"
      className={cn("flex items-start gap-1.5 text-[11px] text-muted-foreground", className)}
      data-testid="active-theme-applied-note"
      data-active-kind={status.kind}
      data-dormant={dormant || undefined}
    >
      <Icon className="mt-px size-3 shrink-0" aria-hidden />
      <span>{t(`activeVariant.applied.${activeThemeMessageKey(status)}`, { name })}</span>
    </p>
  )
}

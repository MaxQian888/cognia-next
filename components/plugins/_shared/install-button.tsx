"use client"

/**
 * Single source of truth for the Install / Uninstall button used across
 * the marketplace card, detail Sheet, discover sheet rows, and plugin
 * discovery hero strip.
 *
 * Replaces 4 near-duplicates that each picked their own loading text
 * and disabled handling.
 */

import { useTranslations } from "next-intl"
import type { ComponentProps, ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

interface Props {
  installed: boolean
  installing: boolean
  onInstall: () => void
  onUninstall?: () => void
  /** Override Tailwind sizing on the rendered Button. */
  size?: ComponentProps<typeof Button>["size"]
  /** Visual variant of the install button. Defaults to "outline". */
  variant?: ComponentProps<typeof Button>["variant"]
  /** Override the install / installing labels. */
  installLabel?: ReactNode
  installingLabel?: ReactNode
  uninstallLabel?: ReactNode
  uninstallingLabel?: ReactNode
  /** Optional class for the rendered Button. */
  className?: string
  /** Force disabled regardless of installing state (e.g. mobile gating). */
  disabled?: boolean
  dataTestId?: string
}

export function InstallButton({
  installed,
  installing,
  onInstall,
  onUninstall,
  size = "sm",
  variant = "outline",
  installLabel,
  installingLabel,
  uninstallLabel,
  uninstallingLabel,
  className,
  disabled,
  dataTestId,
}: Props) {
  const t = useTranslations("plugins.shared")
  const isUninstall = installed && Boolean(onUninstall)
  const label = isUninstall
    ? installing
      ? (uninstallingLabel ?? t("uninstalling"))
      : (uninstallLabel ?? t("uninstall"))
    : installing
      ? (installingLabel ?? t("installing"))
      : (installLabel ?? t("install"))

  const isDisabled = Boolean(disabled) || installing
  return (
    <Button
      size={size}
      variant={isUninstall ? "ghost" : variant}
      onClick={isUninstall ? onUninstall : onInstall}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      data-testid={dataTestId}
      className={cn("gap-1.5", className)}
    >
      {installing && <Spinner className="size-3" />}
      <span>{label}</span>
    </Button>
  )
}

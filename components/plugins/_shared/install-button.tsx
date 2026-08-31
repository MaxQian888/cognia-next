"use client"

/**
 * Single source of truth for the Install / Uninstall button used across
 * the marketplace card, detail Sheet, discover sheet rows, and plugin
 * discovery hero strip.
 *
 * Replaces 4 near-duplicates that each picked their own loading text
 * and disabled handling.
 *
 * It also owns the host gate. `PluginMarketplace.installPlugin` refuses off
 * the desktop shell (`marketplace.ts`, "Plugin installation requires the
 * Cognia desktop app") because the download and checksum verification run in
 * the Rust backend. Nothing surfaced that: the button looked live everywhere,
 * and a web user learned the truth from a toast carrying an un-translated
 * English sentence. The gate belongs here rather than at four call sites,
 * which is how three of them ended up without one.
 *
 * Uninstall is NOT gated: removing a row is a Dexie delete and works on every
 * host.
 */

import { useTranslations } from "next-intl"
import type { ComponentProps, ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { canUseTauriInvoke } from "@/lib/native/utils"
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
  /**
   * Opt out of the desktop-host gate. Only for a surface whose install path
   * genuinely does not go through the Rust backend.
   */
  skipHostGate?: boolean
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
  skipHostGate = false,
  dataTestId,
}: Props) {
  const t = useTranslations("plugins.shared")
  const tCompat = useTranslations("plugins.compatibility")
  const isUninstall = installed && Boolean(onUninstall)
  const label = isUninstall
    ? installing
      ? (uninstallingLabel ?? t("uninstalling"))
      : (uninstallLabel ?? t("uninstall"))
    : installing
      ? (installingLabel ?? t("installing"))
      : (installLabel ?? t("install"))

  const hostBlocked = !isUninstall && !skipHostGate && !canUseTauriInvoke()
  const isDisabled = Boolean(disabled) || installing || hostBlocked
  const button = (
    <Button
      size={size}
      variant={isUninstall ? "ghost" : variant}
      onClick={isUninstall ? onUninstall : onInstall}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      data-testid={dataTestId}
      data-host-blocked={hostBlocked || undefined}
      className={cn("gap-1.5", className)}
    >
      {installing && <Spinner className="size-3" />}
      <span>{label}</span>
    </Button>
  )

  if (!hostBlocked) return button

  return (
    // Self-contained provider: this button is rendered by stories and unit
    // tests that have no `app/layout.tsx` above them. A disabled button
    // swallows pointer events, so the trigger wraps it in a span.
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-64 text-xs">{tCompat("installBlocked")}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

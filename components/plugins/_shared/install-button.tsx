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
 * Uninstall is NOT host-gated here: it is routed through the shared confirm
 * dialog (`setDeleteTarget`), whose `uninstallPluginForHost` decides what this
 * host can do and says so.
 *
 * The reason Install is disabled sits behind a `PluginHint` info trigger next
 * to the button (tooltip on hover, popover on tap, focusable). It used to be a
 * hover-only Tooltip around a disabled button, which a phone — the host that
 * is actually blocked — could never open.
 */

import { useTranslations } from "next-intl"
import type { ComponentProps, ReactNode } from "react"

import { InfoIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { cn } from "@/lib/utils"

import { PluginHint } from "./plugin-hint"

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
    <span className="inline-flex items-center gap-0.5" data-testid="install-button-host-blocked">
      {button}
      <PluginHint
        label={tCompat("installBlockedLabel")}
        content={<p>{tCompat("installBlocked")}</p>}
        className="size-7 justify-center pointer-coarse:size-9"
      >
        <InfoIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </PluginHint>
    </span>
  )
}

// The /pet console's identity header: the pet, its name (editable once it has
// one), a level / stage / coins line, the skin status, and the "out on the
// desktop" toggle.
//
// Presentational: every action arrives as a prop from `PetConsole`, which is
// the one place that decides what renaming or summoning the pet actually runs.
// On a phone the pet shrinks to 40px and the toggle to its icon, so the header
// costs one short row above the tab strip.
//
// Caring for the desktop pet from a paired phone (ADR-0219), two things in the
// header are the desktop's to change: the toggle becomes a read-only chip
// saying whether the pet is out on the desktop, and a skin this device cannot
// draw (Live2D models and sprite packs stay on the desktop) is a neutral note
// rather than a fallback warning with retry and configure actions.

"use client"

import { useTranslations } from "next-intl"
import { Loader2Icon, MonitorIcon, MonitorOffIcon, MonitorUpIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useIsNarrow } from "@/hooks/ui/use-media-query"
import { normalizeCoins } from "@/types/pet"
import type { PetAssetDiagnostic, PetProfile, PetSkinId, PetSkinSelection } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import { PetRenderer } from "../pet-renderer"
import { PetNameEditor } from "../pet-name-editor"
import { PetSkinStatus } from "../settings/pet-skin-status"

export interface PetConsoleHeaderProps {
  profile: PetProfile
  view: PetView
  /** Skin as configured, and as it actually renders (a fallback may apply). */
  requestedSkinId: string
  effectiveSkinId: PetSkinId
  selection: PetSkinSelection
  lowPower?: boolean
  diagnostics: PetAssetDiagnostic[]
  onRetrySkin?: () => void
  onConfigureSkin?: () => void
  onRename: (name: string) => void
  /** Desktop overlay state + toggle. Omitted, the toggle is not offered. */
  desktop?: {
    onDesktop: boolean
    pending: boolean
    onToggle: () => void
  }
  /**
   * Remote care: whether the pet is out on the desktop, shown as a read-only
   * chip in place of the toggle (only the desktop can send it out).
   */
  desktopStatus?: { visible: boolean }
  /**
   * Remote care: this device draws a simplified look of a skin it cannot
   * render. Replaces the skin fallback warning, which would offer a retry and
   * a configure action that only exist on the desktop.
   */
  simplifiedLook?: boolean
}

export function PetConsoleHeader({
  profile,
  view,
  requestedSkinId,
  effectiveSkinId,
  selection,
  lowPower,
  diagnostics,
  onRetrySkin,
  onConfigureSkin,
  onRename,
  desktop,
  desktopStatus,
  simplifiedLook,
}: PetConsoleHeaderProps) {
  const t = useTranslations("pet")
  const narrow = useIsNarrow()
  const desktopLabel = desktop?.onDesktop
    ? t("quickMenu.hideDesktopPet")
    : t("quickMenu.showDesktopPet")

  return (
    <header data-testid="pet-console-header" className="flex items-center gap-3 px-4 py-3">
      <PetRenderer
        bones={view.effectiveBones}
        stage={profile.stage}
        state="idle"
        size={narrow ? 40 : 48}
        skinId={effectiveSkinId}
        selection={selection}
        renderPriority="console"
        lowPower={lowPower}
        flavor={profile.evolutionFlavor}
      />
      <div className="min-w-0 flex-1">
        {profile.soul ? (
          <PetNameEditor
            name={profile.soul.name}
            onRename={onRename}
            nameClassName="text-lg md:text-xl"
          />
        ) : (
          <h1 className="text-lg font-semibold md:text-xl">{t("console.title")}</h1>
        )}
        <p
          data-testid="pet-console-meta"
          className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground tabular-nums md:text-sm"
        >
          <span>{t("panel.level", { level: profile.level })}</span>
          <span aria-hidden>·</span>
          <span>{t(`console.stages.${profile.stage}`)}</span>
          <span aria-hidden>·</span>
          <span>{t("shop.balance", { coins: normalizeCoins(profile.coins) })}</span>
        </p>
        {simplifiedLook ? (
          <p data-testid="pet-console-simplified-look" className="text-xs text-muted-foreground">
            {t("console.remote.simplifiedLook")}
          </p>
        ) : (
          <PetSkinStatus
            requestedSkinId={requestedSkinId}
            effectiveSkinId={effectiveSkinId}
            diagnostics={diagnostics}
            onRetry={onRetrySkin}
            onConfigure={onConfigureSkin}
          />
        )}
      </div>
      {desktopStatus ? (
        <Badge
          variant="outline"
          data-testid="pet-console-desktop-status"
          data-visible={desktopStatus.visible}
          className="shrink-0 gap-1 text-muted-foreground"
        >
          <MonitorIcon className="size-3" aria-hidden />
          {desktopStatus.visible
            ? t("console.remote.desktopVisible")
            : t("console.remote.desktopHidden")}
        </Badge>
      ) : null}
      {/* The console is where people look after the pet, so it is also
          where they send it out to the desktop and call it back, without a
          detour through Settings or the title bar. */}
      {desktop ? (
        <Button
          type="button"
          size={narrow ? "icon" : "sm"}
          variant={desktop.onDesktop ? "outline" : "secondary"}
          // 44px on a phone: it is the header's only tap target.
          className={narrow ? "size-11 shrink-0" : "shrink-0"}
          data-testid="pet-console-desktop-toggle"
          aria-pressed={desktop.onDesktop}
          aria-busy={desktop.pending || undefined}
          disabled={desktop.pending}
          onClick={desktop.onToggle}
        >
          {desktop.pending ? (
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
          ) : desktop.onDesktop ? (
            <MonitorOffIcon className="size-4" aria-hidden />
          ) : (
            <MonitorUpIcon className="size-4" aria-hidden />
          )}
          <span className="hidden sm:inline">{desktopLabel}</span>
          <span className="sr-only sm:hidden">{desktopLabel}</span>
        </Button>
      ) : null}
    </header>
  )
}

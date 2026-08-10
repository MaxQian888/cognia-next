"use client"

// The cursor-pack picker (Settings → Appearance → Pointer).
//
// Packs are grouped by family so the anime set reads as a set rather than as
// five loose entries at the bottom of a flat grid. Each card previews the pack's
// *default* glyph rendered with the palette that is actually going to be used —
// including the "follow my accent" tint — so the swatch never disagrees with
// what the pointer becomes on click.
//
// The "System" card is first and is not a pack: it clears the override and
// hands the pointer back to the operating system.

import { CheckIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { CURSOR_PACK_FAMILIES, packsInFamily } from "@/lib/appearance/cursor/cursor-packs"
import { buildCursorSvg } from "@/lib/appearance/cursor/cursor-art"
import {
  resolveCursorPalette,
  shapeForPack,
  svgToDataUrl,
} from "@/lib/appearance/cursor/render-cursor"
import { cn } from "@/lib/utils"
import type { CursorColorMode, CursorPack } from "@/types/appearance"
import { SYSTEM_CURSOR_PACK_ID } from "@/types/appearance"

/** Preview glyph edge in CSS px — large enough to judge, small enough to grid. */
const PREVIEW_PX = 30

export interface CursorPackGridProps {
  activePackId: string
  colorMode: CursorColorMode
  customColor?: string
  /** Live theme accent, for the `"accent"` color mode. */
  accentColor?: string
  onSelect: (packId: string) => void
}

/** Data URL for one pack's default glyph under the active color mode. */
export function packPreviewUrl(
  pack: CursorPack,
  colorMode: CursorColorMode,
  customColor: string | undefined,
  accentColor: string | undefined
): string {
  const palette = resolveCursorPalette({ pack, colorMode, customColor, accentColor })
  return svgToDataUrl(
    buildCursorSvg({
      role: "default",
      shape: shapeForPack(pack),
      palette,
      sizePx: PREVIEW_PX,
    })
  )
}

function PackCard({
  label,
  selected,
  onSelect,
  children,
}: {
  label: string
  selected: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group relative h-auto flex-col items-center gap-1.5 whitespace-normal rounded-md p-3 font-normal",
        selected ? "border-primary bg-primary/5" : "hover:bg-accent/40"
      )}
    >
      <span className="flex h-8 items-center justify-center">{children}</span>
      <span className="max-w-full truncate text-[11px] leading-none">{label}</span>
      {selected ? (
        <CheckIcon
          aria-hidden
          className="absolute right-1 top-1 size-3 text-primary"
          data-testid="pack-selected"
        />
      ) : null}
    </Button>
  )
}

export function CursorPackGrid({
  activePackId,
  colorMode,
  customColor,
  accentColor,
  onSelect,
}: CursorPackGridProps) {
  const t = useTranslations("settings.appearance.cursor")

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-[11px] font-medium text-muted-foreground">{t("families.system")}</p>
        <div className="grid grid-cols-3 gap-2 @md/appearance-pane:grid-cols-4">
          <PackCard
            label={t("systemPack")}
            selected={activePackId === SYSTEM_CURSOR_PACK_ID}
            onSelect={() => onSelect(SYSTEM_CURSOR_PACK_ID)}
          >
            {/* Deliberately not a glyph: the OS cursor is whatever the user's
                platform theme says, and inventing an arrow for it here would
                be a picture of a lie. */}
            <span className="text-[11px] text-muted-foreground">{t("systemPackHint")}</span>
          </PackCard>
        </div>
      </div>

      {CURSOR_PACK_FAMILIES.map((family) => (
        <div key={family} className="space-y-2">
          <p className="text-[11px] font-medium text-muted-foreground">{t(`families.${family}`)}</p>
          <div className="grid grid-cols-3 gap-2 @md/appearance-pane:grid-cols-4">
            {packsInFamily(family).map((pack) => (
              <PackCard
                key={pack.id}
                label={pack.name}
                selected={activePackId === pack.id}
                onSelect={() => onSelect(pack.id)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- generated SVG data: URL, nothing for next/image to optimize */}
                <img
                  src={packPreviewUrl(pack, colorMode, customColor, accentColor)}
                  alt=""
                  width={PREVIEW_PX}
                  height={PREVIEW_PX}
                  className="size-[30px]"
                  data-testid={`cursor-pack-preview-${pack.id}`}
                />
              </PackCard>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

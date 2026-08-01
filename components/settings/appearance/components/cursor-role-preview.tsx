"use client"

// Role read-out for the active cursor pack.
//
// Two jobs, and the second is the important one:
//   1. show every glyph the pack paints, at the size the pack will actually be
//      painted at, so the size slider has visible consequences;
//   2. name the roles the pack does NOT paint. Packs may declare a subset (see
//      `cursor-packs.ts`), and a user who picks Graphite and then wonders why
//      the "busy" pointer still looks like the system one deserves an answer in
//      the UI rather than in a source comment.

import { useLocale, useTranslations } from "next-intl"
import { buildCursorSvg } from "@/lib/appearance/cursor/cursor-art"
import { shapeForPack, svgToDataUrl } from "@/lib/appearance/cursor/render-cursor"
import { cn } from "@/lib/utils"
import {
  CURSOR_ROLES,
  type CursorPack,
  type CursorPalette,
  type CursorRole,
} from "@/types/appearance"

export interface CursorRolePreviewProps {
  pack: CursorPack
  palette: CursorPalette
  /** Rendered edge in CSS px — the same value the applier will use. */
  sizePx: number
  className?: string
}

/**
 * Join already-translated role names with the locale's own list conjunction.
 * Falls back to a comma join on runtimes without `Intl.ListFormat`.
 */
export function formatRoleList(locale: string, items: string[]): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items)
  } catch {
    return items.join(", ")
  }
}

/** Roles a pack paints and roles it hands back to the platform. */
export function splitRoles(pack: CursorPack): { painted: CursorRole[]; native: CursorRole[] } {
  const declared = new Set(pack.roles)
  const painted: CursorRole[] = []
  const native: CursorRole[] = []
  for (const role of CURSOR_ROLES) {
    if (declared.has(role)) painted.push(role)
    else native.push(role)
  }
  return { painted, native }
}

export function CursorRolePreview({ pack, palette, sizePx, className }: CursorRolePreviewProps) {
  const t = useTranslations("settings.appearance.cursor")
  const locale = useLocale()
  const { painted, native } = splitRoles(pack)
  const shape = shapeForPack(pack)
  // `Intl.ListFormat` rather than a hard-coded separator: "、" is right for
  // zh-CN and wrong for en, and this string is user-facing.
  const nativeLabel = formatRoleList(
    locale,
    native.map((role) => t(`roles.${role}`))
  )

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap gap-3" data-testid="cursor-role-preview">
        {painted.map((role) => (
          <div key={role} className="flex w-16 flex-col items-center gap-1">
            <span className="flex h-10 items-center justify-center rounded-md border bg-card px-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- generated SVG data: URL, nothing for next/image to optimize */}
              <img
                src={svgToDataUrl(buildCursorSvg({ role, shape, palette, sizePx }))}
                alt=""
                width={sizePx}
                height={sizePx}
                style={{ width: sizePx, height: sizePx }}
                data-testid={`cursor-role-${role}`}
              />
            </span>
            <span className="text-center text-[10px] leading-tight text-muted-foreground">
              {t(`roles.${role}`)}
            </span>
          </div>
        ))}
      </div>
      {native.length > 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="cursor-native-roles">
          {t("nativeRoles", { roles: nativeLabel })}
        </p>
      ) : null}
    </div>
  )
}

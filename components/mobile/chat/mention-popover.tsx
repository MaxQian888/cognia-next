"use client"

import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useKeyboardInsets } from "@/hooks/ui/use-keyboard-insets"
import { avatarColor } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import type { Character } from "@cognia/agent-config-types"

interface Props {
  open: boolean
  query: string
  members: readonly Character[]
  /**
   * Measured composer height (px). The panel floats this far above the bottom
   * edge so it clears the composer regardless of how tall it has grown
   * (attachments, goal/loop pills, multi-line draft). Falls back to ~5rem
   * (80px) until the composer has been measured.
   */
  composerHeight?: number
  onPick: (character: Character) => void
  onDismiss: () => void
  className?: string
}

/** Fallback composer clearance (~5rem) used until a real measurement lands. */
const FALLBACK_COMPOSER_PX = 80

/**
 * Mobile @-mention picker.
 *
 * Migrated from a hand-rolled fixed overlay + backdrop `<button>` to shadcn
 * Sheet so we inherit focus trap, escape-to-dismiss, outside-click dismiss,
 * and the slide-in/out animation for free. The Sheet anchors at the bottom
 * of the viewport; we override its inline `bottom` so the panel floats
 * above the composer + virtual keyboard rather than sitting flush with the
 * bottom edge.
 */
export function MentionPopover({
  open,
  query,
  members,
  composerHeight,
  onPick,
  onDismiss,
  className,
}: Props) {
  const t = useTranslations("mobile.mentionPopover")
  const keyboard = useKeyboardInsets()
  const clearance = composerHeight && composerHeight > 0 ? composerHeight : FALLBACK_COMPOSER_PX

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return members
    return members.filter((m) => m.name.toLowerCase().includes(q))
  }, [members, query])

  return (
    // modal={false}: the picker opens while the user is TYPING an @-query in
    // the composer. A modal Sheet would steal focus on open (blurring the
    // textarea and dismissing the virtual keyboard) and its overlay would
    // swallow taps on the composer — making type-to-filter impossible.
    <Sheet
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={() => onDismiss()}
        data-testid="mobile-mention-popover-panel"
        className={cn(
          // Float as a centred popover, not a true edge-to-edge bottom
          // sheet: matches the original visual (max-md, rounded all
          // corners) while still receiving Sheet's animation tokens.
          "mx-auto w-[calc(100%-1rem)] max-w-md gap-0 rounded-2xl border bg-popover p-0 text-popover-foreground",
          className
        )}
        style={{
          // Push above composer + keyboard. `clearance` is the *measured*
          // composer height (falls back to ~5rem until measured); safe-area
          // covers the iOS home indicator; keyboardHeight is ~0 under the
          // native-resize strategy but kept for the visualViewport overlay
          // case. Inline style overrides Sheet's `bottom-0`.
          bottom: `calc(env(safe-area-inset-bottom, 0px) + ${clearance}px + ${keyboard.keyboardHeight}px)`,
        }}
      >
        <div data-testid="mobile-mention-popover" className="contents">
          <SheetHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b px-3 py-2">
            <SheetTitle className="text-xs font-medium text-muted-foreground">
              {t("title")}
            </SheetTitle>
            <SheetDescription className="text-xs font-medium text-muted-foreground">
              {t("count", { count: filtered.length })}
            </SheetDescription>
          </SheetHeader>
          {members.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t("empty")}</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("noMatches", { query })}
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {filtered.map((member) => (
                <li key={member.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-12 w-full justify-start gap-3 rounded-none px-3 py-2 text-left text-sm font-normal"
                    onClick={() => onPick(member)}
                  >
                    <AvatarBadge subject={member} size={28} textClassName="text-xs" />
                    <span
                      className="min-w-0 flex-1 truncate font-medium"
                      style={{ color: avatarColor(member) }}
                    >
                      {member.name}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

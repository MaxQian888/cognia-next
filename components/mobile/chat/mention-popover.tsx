"use client"

import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { useKeyboardInsets } from "@/hooks/ui/use-keyboard-insets"
import { avatarColor } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import type { Character } from "@/lib/claude/types"

interface Props {
  open: boolean
  query: string
  members: readonly Character[]
  onPick: (character: Character) => void
  onDismiss: () => void
  className?: string
}

export function MentionPopover({ open, query, members, onPick, onDismiss, className }: Props) {
  const t = useTranslations("mobile.mentionPopover")
  const keyboard = useKeyboardInsets()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return members
    return members.filter((m) => m.name.toLowerCase().includes(q))
  }, [members, query])

  if (!open) return null

  return (
    <div
      className={cn("fixed inset-0 z-40 flex items-end justify-center", className)}
      data-testid="mobile-mention-popover"
    >
      <button
        type="button"
        aria-label={t("dismiss")}
        className="absolute inset-0 bg-background/40 backdrop-blur-sm"
        data-testid="mobile-mention-popover-backdrop"
        onClick={onDismiss}
      />
      <div
        className="relative z-10 mx-2 w-full max-w-md rounded-2xl border bg-popover text-popover-foreground shadow-lg"
        style={{
          marginBottom: `calc(env(safe-area-inset-bottom, 0px) + 5rem + ${keyboard.keyboardHeight}px)`,
        }}
        data-testid="mobile-mention-popover-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
          <span>{t("title")}</span>
          <span>{t("count", { count: filtered.length })}</span>
        </div>
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
                <button
                  type="button"
                  className="flex w-full min-h-12 items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent active:bg-accent"
                  onClick={() => onPick(member)}
                >
                  <AvatarBadge subject={member} size={28} textClassName="text-xs" />
                  <span
                    className="min-w-0 flex-1 truncate font-medium"
                    style={{ color: avatarColor(member) }}
                  >
                    {member.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

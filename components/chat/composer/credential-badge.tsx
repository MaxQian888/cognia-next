"use client"

/**
 * "No API key" — the one credential state that stops the next send.
 *
 * It sat in the chat header; with the header projected into the title bar a
 * red badge there read as window chrome shouting. The composer's status line
 * is where the send will fail, so this is where the warning belongs. Reactive
 * through `useCredentialStatus`, so a subscription bearer that lands after
 * boot clears it without a reload. Clicking it opens provider settings.
 */

import { KeyRoundIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { cn } from "@/lib/utils"

interface Props {
  onOpenSettings?: () => void
  className?: string
}

export function ComposerCredentialBadge({ onOpenSettings, className }: Props) {
  const t = useTranslations("chat.header")
  const { keyOk } = useCredentialStatus()
  if (keyOk !== false) return null
  return (
    <Badge
      variant="destructive"
      className={cn("h-6 cursor-pointer gap-1 px-2 text-[11px]", className)}
      onClick={onOpenSettings}
      role={onOpenSettings ? "button" : undefined}
      data-testid="composer-credential-badge"
    >
      <KeyRoundIcon className="size-3" />
      {t("noApiKey")}
    </Badge>
  )
}

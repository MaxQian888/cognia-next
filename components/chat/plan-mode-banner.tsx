"use client"

/**
 * Distinct plan-mode state banner above the composer (Claude Code parity: the
 * amber "plan mode" affordance is more than the tiny mode chip). Self-hides
 * outside plan mode. Pairs with the composer surface's amber tint.
 */

import { useTranslations } from "next-intl"
import { NotebookPenIcon } from "lucide-react"
import { useComposerPermissionMode } from "@/stores/chat"

import { useComposerSessionId } from "./composer/composer-session-context"

export function PlanModeBanner() {
  const t = useTranslations("chat.planMode")
  // The conversation whose composer this banner sits above, not the focused
  // one: rendered inside an unfocused split pane it announced plan mode for the
  // pane beside it, and hid it for its own.
  const permissionMode = useComposerPermissionMode(useComposerSessionId())
  if (permissionMode !== "plan") return null

  return (
    <div
      className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400"
      data-testid="plan-mode-banner"
    >
      <NotebookPenIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t("banner")}</span>
      <kbd className="shrink-0 rounded border border-amber-500/40 px-1 font-mono text-[10px]">
        {t("hint")}
      </kbd>
    </div>
  )
}

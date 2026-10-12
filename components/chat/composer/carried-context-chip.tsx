"use client"

/**
 * Context envelopes carried over from a message the user put back into the
 * composer (`lib/chat/composer-restore.ts`): the referenced material and web
 * results that message was sent with. Its original chips were consumed by that
 * send, so the envelope is re-sent verbatim with the next turn — this chip is
 * where the user sees that it will be, and removes it if it no longer applies.
 *
 * One chip per envelope, in the context chip row beside the reply target and
 * the attachments, read through `useComposerSessionId` like its neighbours.
 */

import { useTranslations } from "next-intl"
import { LayersIcon, XIcon } from "lucide-react"

import { Surface } from "@/components/surface/surface"
import { Button } from "@/components/ui/button"
import type { CarriedPromptPreamble } from "@/lib/chat/prompt-preamble"
import { useChatStore, useComposerCarriedPreambles } from "@/stores/chat"
import { useComposerSessionId } from "./composer-session-context"

function chipTitle(entry: CarriedPromptPreamble): string | null {
  const titles = entry.summary?.references.map((ref) => ref.title).filter(Boolean) ?? []
  return titles.length > 0 ? titles.join(", ") : null
}

export function CarriedContextChips() {
  const t = useTranslations("chat.composer.carriedContext")
  const composerSessionId = useComposerSessionId()
  const carried = useComposerCarriedPreambles(composerSessionId)
  const removeCarriedPreamble = useChatStore((state) => state.removeCarriedPreamble)

  if (carried.length === 0) return null
  return (
    <>
      {carried.map((entry, index) => {
        const count = entry.summary?.references.length ?? 0
        const title = chipTitle(entry)
        return (
          <Surface
            key={entry.preamble}
            className="flex min-w-0 items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-xs"
            title={title ?? t("hint")}
            data-testid="composer-carried-context-chip"
          >
            <LayersIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 text-muted-foreground">{t("label")}</span>
            <span className="max-w-[min(240px,calc(100vw-8rem))] truncate">
              {count > 0 ? t("references", { count }) : t("generic")}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("remove")}
              onClick={() => removeCarriedPreamble(index, composerSessionId)}
              className="size-5 opacity-60 transition-opacity hover:opacity-100"
              data-testid="composer-carried-context-remove"
            >
              <XIcon className="size-3" />
            </Button>
          </Surface>
        )
      })}
    </>
  )
}

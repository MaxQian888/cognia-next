"use client"

/**
 * Pending-draft notice — the entry point to the inline DraftEditor.
 *
 * Presentation only; `InboxNoticeArea` owns the query and decides whether to
 * mount it. The Sheet stays here so the editor lives with its trigger.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PenLineIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import { DraftEditor } from "./draft-editor"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { NoticeItem } from "./notices/notice-item"

export interface DraftNoticeProps {
  draft: ConnectorDraftRow
  conversationKey: string
}

export function DraftNotice({ draft, conversationKey }: DraftNoticeProps) {
  const t = useTranslations("inbox.draftBanner")
  const [open, setOpen] = useState(false)

  return (
    <>
      <NoticeItem
        severity="info"
        icon={<PenLineIcon className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />}
        title={t("pending")}
        data-testid="draft-banner"
        actions={
          <>
            {/* Plugin contributions: per-draft actions (kick back, rewrite,
             * "ask a teammate to review", …). Hidden when no plugin contributes.
             * The point name is in the slot manifest — `pnpm audit:slots`
             * fails if it changes or disappears. */}
            <PluginExtensionSlot
              point="inbox.draft.actions"
              className="flex items-center gap-1 empty:hidden"
              context={{
                conversationKey,
                draftId: draft.id,
                sessionId: draft.sessionId,
                sourceMessageId: draft.sourceMessageId,
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => setOpen(true)}
              data-testid="draft-review-btn"
            >
              {t("review")}
            </Button>
          </>
        }
      />

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("reviewAria")}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <DraftEditor draft={draft} onClose={() => setOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

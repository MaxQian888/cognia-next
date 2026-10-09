"use client"

/**
 * The triage preview on a phone: the same pane the tablet and desktop show
 * beside the list, in a bottom drawer.
 *
 * A tap on a phone row still opens the chat; "Preview" in the row's long-press
 * sheet opens this instead — a look at the latest messages, drafts, status and
 * owner without leaving the list. The pane is forced into its single-column
 * `stacked` layout and scrolls inside the drawer; dismissal belongs to the
 * drawer (drag down, the overlay, Escape), so the pane's own close button is
 * not drawn.
 *
 * The primary action — replying, which happens in the chat — is a full-width
 * button pinned to the bottom, where a thumb reaches it, padded clear of the
 * home indicator (`env(safe-area-inset-bottom)`).
 *
 * Read-only like the pane: opening it marks nothing read.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { MessageSquareReplyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { TriagePreviewPane } from "./triage-preview-pane"

export interface TriagePreviewTarget {
  sessionId: string
  conversationKey: string
  title: string
}

export interface TriagePreviewDrawerProps {
  /** The conversation to preview; `null` closes the drawer. */
  target: TriagePreviewTarget | null
  onClose: () => void
  onOpenInChat: (conversationKey: string, sessionId: string) => void
}

export function TriagePreviewDrawer({ target, onClose, onOpenInChat }: TriagePreviewDrawerProps) {
  const t = useTranslations("inbox.triage.drawer")
  // Keep the last conversation while the drawer slides out.
  const [shown, setShown] = useState<TriagePreviewTarget | null>(target)
  if (target && target !== shown) setShown(target)

  return (
    <Drawer
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DrawerContent
        className="flex h-[88dvh] flex-col data-[vaul-drawer-direction=bottom]:max-h-[88dvh]"
        data-testid="triage-preview-drawer"
        data-edge-swipe-ignore=""
      >
        <DrawerHeader className="sr-only">
          <DrawerTitle>
            {shown ? t("title", { name: shown.title }) : t("titleFallback")}
          </DrawerTitle>
          <DrawerDescription>{t("description")}</DrawerDescription>
        </DrawerHeader>
        {shown ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col">
              <TriagePreviewPane
                key={shown.sessionId}
                sessionId={shown.sessionId}
                layout="stacked"
                onOpenInChat={(conversation) =>
                  onOpenInChat(conversation.conversationKey, conversation.session.id)
                }
              />
            </div>
            <div className="shrink-0 border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button
                type="button"
                className="min-h-11 w-full gap-2"
                onClick={() => onOpenInChat(shown.conversationKey, shown.sessionId)}
                data-testid="triage-drawer-reply"
              >
                <MessageSquareReplyIcon className="size-4" aria-hidden />
                {t("reply")}
              </Button>
            </div>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

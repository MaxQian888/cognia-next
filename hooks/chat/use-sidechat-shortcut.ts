"use client"

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { useChatStore } from "@/stores/chat"
import { openSideChat } from "@/lib/slash-commands/actions/side-chat"

/** Only the active main composer registers, even when split panes stay mounted. */
export function useSidechatShortcut(sessionId?: string, isAside = false): void {
  const mobile = useIsMobile()
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const t = useTranslations("contextWorkbench.asides")
  useAppShortcut(
    "chat.sidechat.toggle",
    () => {
      if (!sessionId) return
      const sidechat = document.activeElement?.closest<HTMLElement>("[data-sidechat-parent]")
      if (sidechat?.dataset.sidechatParent === sessionId) {
        const main = Array.from(
          document.querySelectorAll<HTMLElement>("[data-composer-session]")
        ).find(
          (node) =>
            node.dataset.composerSession === sessionId && !node.closest("[data-sidechat-parent]")
        )
        main?.querySelector<HTMLTextAreaElement>("textarea")?.focus()
      } else {
        void openSideChat(sessionId).catch(() => toast.error(t("openError")))
      }
    },
    {
      enabled: !mobile && !isAside && !!sessionId && activeSessionId === sessionId,
      allowInEditable: true,
      preventDefault: true,
    }
  )
}

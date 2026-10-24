"use client"

/**
 * Mounts the built-in A2UI action handlers (calculator / timer / todo / form /
 * unit-converter / …) once for the whole app. The A2UI event emitter is global,
 * so a single opted-in builder makes every rendered surface interactive — chat
 * messages, the Mini Apps hub and workspace/designer, and preview dialogs alike
 * — without each render site having to wire its own handler. That per-site
 * wiring was the gap that left calculator/todo buttons inert.
 *
 * Whatever the built-in handlers do not own falls through to `onAction`, which
 * here is the chat router (ADR-0240): a gesture on a surface a transcript row
 * bound to a session becomes that session's next user message. Unbound
 * surfaces (Mini Apps, editor, previews) are left alone by the router.
 *
 * Renders nothing. It re-renders when A2UI surface state changes (the builder
 * subscribes to the surfaces map), but it has no children, so it never
 * re-renders the app tree. The subscription itself is de-duplicated at module
 * scope (see `registerBuiltInActionHandler`), so mounting this once is enough.
 */

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useA2UIAppBuilder } from "@/hooks/a2ui/use-app-builder"
import { sendChatMessage } from "@/hooks/chat/chat-send-bridge"
import { createA2UIChatActionRouter } from "@/lib/a2ui/chat-action-routing"
import { useA2UIStore } from "@/stores/a2ui"
import type { A2UIUserAction } from "@/types/a2ui/schema"

export function A2UIBuiltInActionsProvider() {
  const t = useTranslations("a2ui.chatAction")
  const route = useMemo(
    () =>
      createA2UIChatActionRouter({
        getSurface: (surfaceId) => useA2UIStore.getState().surfaces[surfaceId],
        send: sendChatMessage,
      }),
    []
  )
  const onAction = useCallback(
    (action: A2UIUserAction) => {
      if (route(action) === "failed") toast.error(t("sendFailed"))
    },
    [route, t]
  )
  useA2UIAppBuilder({ wireBuiltInActions: true, onAction })
  return null
}

import type { SlashContext } from "../builtin"
import { toast } from "sonner"
import { getRuntimeTranslator } from "@/lib/i18n/runtime-translator"
import { isNativeMobile } from "@/lib/platform/detect"
import { getDb } from "@/lib/db/schema"
import { createResourceSessionRepository } from "@/lib/db/resource-workbench-sessions"
import { ensureResourceWorkbenchSession } from "@/lib/context-workbench/resource-session"
import { getContextResourceKey } from "@/types/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useSideChatRequestStore } from "@/stores/chat/side-chat-request-store"

/** Resolve the same override / ensured primary used by the mounted workbench. */
export async function openSideChat(sessionId: string, question = ""): Promise<void> {
  const binding = { kind: "session" as const, sessionId }
  const resourceKey = getContextResourceKey({ ...binding, capabilities: ["ai"] })
  const workbench = useContextWorkbenchStore.getState()
  const override = workbench.sessionOverrides?.[resourceKey]
  let aside = override ? await getDb().sessions.get(override) : undefined
  if (aside?.kind !== "resource-workbench") {
    if (override) workbench.setSessionOverride(resourceKey, null)
    aside = await ensureResourceWorkbenchSession(
      binding,
      resourceKey,
      createResourceSessionRepository()
    )
  }
  if (question.trim()) useSideChatRequestStore.getState().enqueue(aside.id, question.trim())
  useComposerIntentStore.getState().stage(aside.id, {
    candidateId: crypto.randomUUID(),
    prompt: null,
  })
  useArtifactDockLayoutStore.getState().revealSidechat()
}

export async function dispatchSideChat(ctx: SlashContext): Promise<void> {
  const t = await getRuntimeTranslator("contextWorkbench.asides")
  if (
    ctx.isMobile ||
    isNativeMobile() ||
    (typeof window !== "undefined" && window.matchMedia("(max-width: 767.98px)").matches)
  ) {
    toast.info(t("desktopOnly"))
    return
  }
  if (!ctx.activeSessionId) {
    toast.info(t("needSession"))
    return
  }
  if (ctx.isAside || ctx.activeSessionId.startsWith("resource-workbench:")) return
  try {
    await openSideChat(ctx.activeSessionId, ctx.args)
  } catch {
    toast.error(t("openError"))
  }
}

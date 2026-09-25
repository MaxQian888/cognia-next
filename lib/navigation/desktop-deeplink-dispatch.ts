/**
 * What the desktop shell does with a `cognia://` link.
 *
 * One dispatcher for both ways a link arrives: while the app is running
 * (`hooks/system/use-tauri-events.ts`, the `deep-link://new-url` event) and at
 * cold start (`components/providers/tauri-provider.tsx`, the URLs the OS
 * launched the app with). They used to be two hand-written switches that had
 * drifted apart — cold start parsed the host itself and handled `chat` but not
 * `session`, so `cognia://session/<id>`, the link every Browser Companion
 * submission carries, did nothing when it was the thing that launched Cognia.
 *
 * Parsing stays in `cognia-deeplink.ts`, which the mobile shell shares; this
 * module is only the desktop's answer to each parsed route.
 */
import { publishLogtoDeepLinkCallback } from "@/lib/logto/deep-link-callback"
import { openPathAsWorkspace } from "@/lib/workspace/open-folder"
import { useChatStore } from "@/stores/chat"
import { useUIStore } from "@/stores/ui"

import type { CogniaDeeplinkRoute } from "./cognia-deeplink"

export interface DesktopDeeplinkDeps {
  /** Client-side navigation (`router.push`). */
  navigate: (path: string) => void
  /** A link this shell has no handler for, handed back so the caller can say so. */
  onUnknown: (raw: string) => void
}

/** The Settings section the agent task board lives in. */
export const AGENT_TASK_BOARD_SETTINGS_TAB = "characters"

/** `/issues?id=` — the board reads the selection from the query string. */
export function issuePagePath(issueId: string): string {
  return `/issues?id=${encodeURIComponent(issueId)}`
}

/** Focus one conversation in the chat workspace. */
function openSession(sessionId: string): void {
  useChatStore.getState().setActiveSession(sessionId)
  useUIStore.getState().setSelectedGuild({ kind: "dm" })
}

/**
 * The conversation an agent task's most recent attempt ran in, if any.
 *
 * Newest attempt first: a retried task's earlier attempts ran in conversations
 * that no longer describe what the task is doing. `null` when the task is gone
 * or has not run yet, which the caller answers with the board instead.
 */
export async function agentTaskSessionId(taskId: string): Promise<string | null> {
  const { getAgentTask, listAgentTaskAttempts } = await import("@/lib/db/agent-tasks")
  const task = await getAgentTask(taskId)
  if (!task) return null
  const attempts = await listAgentTaskAttempts(taskId)
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const sessionId = attempts[index]?.sessionId
    if (sessionId) return sessionId
  }
  return null
}

/**
 * Act on one parsed link.
 *
 * Async because three routes resolve something first (the conversation bound
 * to an IM thread, the conversation an agent task ran in, the scheduler task a
 * wake-up names). Every other route acts before the first `await`, so a caller
 * that does not wait still sees it applied synchronously. Failures inside those
 * lookups fall back to the nearest useful place rather than throwing: a link
 * that opened nothing reads as a broken link, one that opened the board reads
 * as "here is where that lives".
 */
export async function dispatchDesktopDeeplink(
  route: CogniaDeeplinkRoute,
  deps: DesktopDeeplinkDeps
): Promise<void> {
  switch (route.kind) {
    case "open_session": {
      if (route.sessionId) openSession(route.sessionId)
      return
    }
    case "open_issue": {
      deps.navigate(route.issueId ? issuePagePath(route.issueId) : "/issues")
      return
    }
    case "open_agent_task": {
      const sessionId = route.taskId
        ? await agentTaskSessionId(route.taskId).catch(() => null)
        : null
      if (sessionId) {
        openSession(sessionId)
        return
      }
      // Not run yet, or gone: the board is where the task can be seen and
      // started, and it lives with the agent in Settings.
      useUIStore.getState().requestOpenSettings(AGENT_TASK_BOARD_SETTINGS_TAB)
      return
    }
    case "open_im": {
      if (!route.conversationKey) return
      const { findActiveSessionForConversation } = await import("@/lib/connectors/session-bindings")
      const session = await findActiveSessionForConversation(route.conversationKey).catch(
        () => null
      )
      if (session) openSession(session.id)
      return
    }
    case "open_scheduler_task": {
      if (!route.taskId) return
      // OS-promoted wake-up: only a link carrying the task's own promotion
      // token may execute; a bare link just navigates.
      const { handlePromotedTaskWake } = await import("@/lib/scheduler/promoted-wake")
      await handlePromotedTaskWake(
        { taskId: route.taskId, runToken: route.runToken },
        { navigate: deps.navigate }
      )
      return
    }
    case "open_settings": {
      useUIStore.getState().requestOpenSettings(route.settingsTab)
      return
    }
    case "open_workspace": {
      // Unified flow: create/activate a real workspace Project for the
      // deep-linked path (consistent with the File menu / switcher).
      if (route.workspacePath) openPathAsWorkspace(route.workspacePath)
      return
    }
    case "open_workflow_run": {
      if (route.workflowId && route.runId) {
        deps.navigate(
          `/workflows/run?id=${encodeURIComponent(route.workflowId)}&runId=${encodeURIComponent(route.runId)}`
        )
      }
      return
    }
    case "logto_callback": {
      // The cloud sign-in gate's desktop driver is waiting on this seam; when
      // nobody is, the callback is dropped by design.
      publishLogtoDeepLinkCallback(route)
      return
    }
    case "oauth_callback":
    case "pair_qr":
    case "share_target":
      // Mobile-owned routes: parsed here for parity, handled by the Capacitor
      // router (`lib/capacitor/deeplink-router.ts`).
      return
    case "unknown":
      deps.onUnknown(route.raw)
      return
  }
}

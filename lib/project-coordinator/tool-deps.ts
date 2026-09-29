import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { ProjectCoordinatorToolDeps } from "@/lib/claude/project-coordinator-builtin-tools"
import { getSession, updateSession } from "@/lib/db/sessions"
import { listMessages } from "@/lib/db/messages"
import { rememberFact } from "@/lib/memory/write/remember-fact"
import { extractAssistantText } from "@/hooks/chat/claude-chat-turn-tasks"
import { sessionStatusOf } from "@/hooks/chat/steer-runtime"
import { setProjectPreference } from "./preferences"
import { projectAccess } from "./project-access"
import { createThreadSession } from "./thread-session"
import {
  checkThreadCreation,
  defaultThreadRuntimeDeps,
  resolveThread,
  sendToThread,
  startThread,
  stopThread,
} from "./thread-runtime"

/** Production wiring for the project-coordinator builtin tools. */
export function resolveProjectCoordinatorToolDeps(): ProjectCoordinatorToolDeps {
  const runtime = defaultThreadRuntimeDeps()
  return {
    getSession,
    listThreads: runtime.listThreads,
    statusOf: sessionStatusOf,
    checkCreation: (projectId, coordinatorSessionId) =>
      checkThreadCreation(projectId, coordinatorSessionId, runtime),
    createThread: (input) => createThreadSession(input),
    startThread: (threadId, by) => startThread(threadId, by, runtime),
    sendToThread: (threadId, text) => sendToThread(threadId, text, runtime),
    stopThread: (threadId) => stopThread(threadId, runtime),
    resolveThread: (threadId) => resolveThread(threadId, "coordinator", runtime),
    listMessages,
    remember: ({ text, sessionId }) => rememberFact({ text, scope: "workspace", sessionId }),
    setPreference: (projectId, key, value) =>
      setProjectPreference(projectId, key, value, projectAccess),
    declareThreadState: async (thread, state) => {
      if (!thread.projectThread) return
      await updateSession(thread.id, {
        projectThread: { ...thread.projectThread, declaredState: state },
      })
    },
    gate: hasNoLeakingPiiDeep,
    assistantText: extractAssistantText,
  }
}

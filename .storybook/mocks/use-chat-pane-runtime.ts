// Storybook-only stand-in for `@/hooks/chat/use-chat-pane-runtime`, aliased in
// `.storybook/main.ts`. The real hook reads the app-wide chat controller via
// `useClaudeChat()`, which throws unless `ClaudeChatRuntimeProvider` is mounted
// at bootstrap. Mounting that provider here would start the real controller
// (sidecar transport, Tauri listeners, approval bridges), and an isolated
// preview must not do that. Same shape as the jest mock in
// `components/chat/chat-view.test.tsx`: this pane owns the session's blocking
// decisions, and every runtime action is a named spy that logs to the Actions
// panel and resolves without doing anything.
import { fn } from "storybook/test"

import type { useChatPaneRuntime as useRealChatPaneRuntime } from "@/hooks/chat/use-chat-pane-runtime"

type ChatPaneRuntime = ReturnType<typeof useRealChatPaneRuntime>
type Runtime = ChatPaneRuntime["runtime"]

const action = (name: string) => fn(async () => undefined).mockName(`runtime.${name}`)

const runtime = {
  send: action("send"),
  stop: action("stop"),
  interruptAndSteer: action("interruptAndSteer"),
  flushSteer: action("flushSteer"),
  respondToApproval: action("respondToApproval"),
  compact: action("compact"),
  setModel: action("setModel"),
  resetRuntime: action("resetRuntime"),
  rewindFiles: action("rewindFiles"),
  close: action("close"),
  editAndResend: action("editAndResend"),
  regenerate: action("regenerate"),
} satisfies Record<keyof Runtime, unknown>

const paneRuntime: ChatPaneRuntime = {
  runtime: runtime as unknown as Runtime,
  ownsDecisions: true,
  resumePlan: fn(async () => undefined).mockName("resumePlan"),
}

export function useChatPaneRuntime(_sessionId: string | null): ChatPaneRuntime {
  return paneRuntime
}

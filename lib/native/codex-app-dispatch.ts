import { invoke } from "@tauri-apps/api/core"

export interface CodexAppDispatchMessage {
  role: "user" | "assistant"
  content: string
  timestampMs?: number
}

export interface CodexAppDispatchRequest {
  title: string
  cwd: string
  messages: CodexAppDispatchMessage[]
}

export interface CodexAppDispatchResult {
  threadId: string
  deepLink: string
}

/** Import a conversation snapshot through the running Codex App's local app-server. */
export function dispatchConversationToCodexApp(
  request: CodexAppDispatchRequest
): Promise<CodexAppDispatchResult> {
  return invoke<CodexAppDispatchResult>("codex_app_dispatch_conversation", { request })
}

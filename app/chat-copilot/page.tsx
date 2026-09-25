"use client"

import { ChatCopilotOverlay } from "@/components/reply-copilot/screen/chat-copilot-overlay"

// Desktop chat copilot overlay (ADR-0194 §8). Rendered inside the frameless,
// non-activating `chat-copilot` Tauri panel that `chat_copilot_open` creates.
// The desktop shell bypasses this prefix (`lib/shell/bypass-routes.ts`) so no
// chrome paints, and the overlay marks <html> with `data-pet-overlay` for a
// transparent page.
export default function ChatCopilotPage() {
  return <ChatCopilotOverlay />
}

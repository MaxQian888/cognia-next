// Chat lifecycle → pet events. Watches the chat store status and maps each
// transition onto the pet's radar: streaming→thinking, awaiting_approval→waiting,
// error→error, and a completed turn (active→idle) into a brief "review".

import { useChatStore } from "@/stores/chat/chat-store"
import type { ChatStatus } from "@/stores/chat/chat-store"
import type { PetEmit } from "../pet-event-bus"

export function chatStatusToEmit(status: ChatStatus, prev: ChatStatus, emit: PetEmit): void {
  if (status === prev) return
  switch (status) {
    case "streaming":
      emit({ source: "chat", kind: "thinking" })
      break
    case "awaiting_approval":
      emit({ source: "chat", kind: "waiting" })
      break
    case "error":
      emit({ source: "chat", kind: "error" })
      break
    case "idle":
      if (prev === "streaming" || prev === "awaiting_approval") {
        emit({ source: "chat", kind: "review", xp: 2 })
      } else {
        emit({ source: "chat", kind: "idle" })
      }
      break
  }
}

export function wireChatSource(emit: PetEmit): () => void {
  return useChatStore.subscribe((state, prev) => {
    chatStatusToEmit(state.status, prev.status, emit)
  })
}

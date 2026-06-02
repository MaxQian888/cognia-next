import { chatStatusToEmit, wireChatSource } from "./chat-source"
import { useChatStore } from "@/stores/chat/chat-store"
import type { PetEvent } from "@/types/pet"

function collect() {
  const events: PetEvent[] = []
  return {
    events,
    emit: (e: Omit<PetEvent, "at"> & { at?: number }) => events.push({ ...e, at: e.at ?? 0 }),
  }
}

describe("chatStatusToEmit", () => {
  it("maps each transition", () => {
    const { events, emit } = collect()
    chatStatusToEmit("streaming", "idle", emit)
    chatStatusToEmit("awaiting_approval", "streaming", emit)
    chatStatusToEmit("error", "streaming", emit)
    chatStatusToEmit("idle", "streaming", emit) // completed turn → review
    chatStatusToEmit("idle", "error", emit) // recovered → idle
    expect(events.map((e) => e.kind)).toEqual(["thinking", "waiting", "error", "review", "idle"])
  })

  it("ignores no-op transitions", () => {
    const { events, emit } = collect()
    chatStatusToEmit("idle", "idle", emit)
    expect(events).toHaveLength(0)
  })
})

describe("wireChatSource", () => {
  it("reacts to real chat store transitions", () => {
    useChatStore.setState({ status: "idle" })
    const { events, emit } = collect()
    const off = wireChatSource(emit)
    useChatStore.setState({ status: "streaming" })
    useChatStore.setState({ status: "idle" })
    off()
    useChatStore.setState({ status: "streaming" })
    expect(events.map((e) => e.kind)).toEqual(["thinking", "review"])
  })
})

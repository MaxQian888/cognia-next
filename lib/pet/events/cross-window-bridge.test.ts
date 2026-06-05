import {
  startMainPetBridge,
  startOverlayPetBridge,
  type BroadcastChannelLike,
} from "./cross-window-bridge"
import type { PetBridgeMessage } from "./cross-window-protocol"
import type { PetBubble } from "@/stores/pet/pet-store"
import type { PetOneShot, PetVisualState } from "@/types/pet"

// A fake channel that records posts and lets the test deliver inbound messages.
class FakeChannel implements BroadcastChannelLike {
  posted: unknown[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  close(): void {
    this.closed = true
  }
  deliver(data: unknown): void {
    this.onmessage?.({ data })
  }
  msgs(): PetBridgeMessage[] {
    return this.posted as PetBridgeMessage[]
  }
}

// Minimal store double matching the subset the bridge touches.
interface FakeState {
  visualState: PetVisualState
  oneShotQueue: PetOneShot[]
  bubble: PetBubble | null
  setVisualState: (s: PetVisualState) => void
  enqueueOneShot: (s: PetOneShot) => void
  setBubble: (b: PetBubble | null) => void
}

function makeStore() {
  const state: FakeState = {
    visualState: "idle",
    oneShotQueue: [],
    bubble: null,
    setVisualState: jest.fn((s: PetVisualState) => {
      state.visualState = s
    }),
    enqueueOneShot: jest.fn((s: PetOneShot) => {
      state.oneShotQueue = [...state.oneShotQueue, s]
    }),
    setBubble: jest.fn((b: PetBubble | null) => {
      state.bubble = b
    }),
  }
  let listener: ((s: FakeState, p: FakeState) => void) | null = null
  const api = {
    getState: () => state,
    subscribe: (cb: (s: FakeState, p: FakeState) => void) => {
      listener = cb
      return () => {
        listener = null
      }
    },
    // Test helper to simulate a store transition through the subscriber.
    emit: (next: Partial<FakeState>) => {
      const prev = { ...state }
      Object.assign(state, next)
      listener?.(state, prev as FakeState)
    },
    hasListener: () => listener !== null,
    __state: state,
  }
  return api
}

describe("startMainPetBridge", () => {
  it("broadcasts visual-state changes", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    startMainPetBridge({ channel, store: store as never })
    store.emit({ visualState: "thinking" })
    expect(channel.msgs()).toContainEqual({ v: 1, t: "visual-state", state: "thinking" })
  })

  it("broadcasts bubble set and clear", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    startMainPetBridge({ channel, store: store as never })
    store.emit({ bubble: { text: "hey", origin: "template" } })
    store.emit({ bubble: null })
    expect(channel.msgs()).toContainEqual({
      v: 1,
      t: "bubble",
      bubble: { text: "hey", origin: "template" },
    })
    expect(channel.msgs()).toContainEqual({ v: 1, t: "bubble", bubble: null })
  })

  it("forwards only newly-appended one-shots", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    startMainPetBridge({ channel, store: store as never })
    store.emit({ oneShotQueue: ["wave"] })
    store.emit({ oneShotQueue: ["wave", "happy", "fed"] })
    const shots = channel.msgs().filter((m) => m.t === "one-shot")
    expect(shots).toEqual([
      { v: 1, t: "one-shot", shot: "wave" },
      { v: 1, t: "one-shot", shot: "happy" },
      { v: 1, t: "one-shot", shot: "fed" },
    ])
  })

  it("does not emit a one-shot when the queue shrinks (drain)", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    startMainPetBridge({ channel, store: store as never })
    store.emit({ oneShotQueue: ["wave"] })
    channel.posted = []
    store.emit({ oneShotQueue: [] })
    expect(channel.msgs().filter((m) => m.t === "one-shot")).toHaveLength(0)
  })

  it("replays inbound interaction as a user pet event", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    const emit = jest.fn()
    startMainPetBridge({ channel, store: store as never, emit })
    channel.deliver({ v: 1, t: "interaction", kind: "petted" })
    expect(emit).toHaveBeenCalledWith({ source: "user", kind: "petted", meta: undefined })
  })

  it("forwards typed talk text as event meta", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    const emit = jest.fn()
    startMainPetBridge({ channel, store: store as never, emit })
    channel.deliver({ v: 1, t: "interaction", kind: "talked", text: "hi pet" })
    expect(emit).toHaveBeenCalledWith({
      source: "user",
      kind: "talked",
      meta: { userText: "hi pet" },
    })
  })

  it("re-broadcasts a snapshot on request-state", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    store.__state.visualState = "happy"
    store.__state.bubble = { text: "yo", origin: "llm" }
    startMainPetBridge({ channel, store: store as never })
    channel.deliver({ v: 1, t: "request-state" })
    expect(channel.msgs()).toContainEqual({ v: 1, t: "visual-state", state: "happy" })
    expect(channel.msgs()).toContainEqual({
      v: 1,
      t: "bubble",
      bubble: { text: "yo", origin: "llm" },
    })
  })

  it("ignores malformed inbound messages", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    const emit = jest.fn()
    startMainPetBridge({ channel, store: store as never, emit })
    channel.deliver({ v: 9, t: "interaction", kind: "petted" })
    channel.deliver("garbage")
    expect(emit).not.toHaveBeenCalled()
  })

  it("dispose unsubscribes and closes the channel", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    const dispose = startMainPetBridge({ channel, store: store as never })
    expect(store.hasListener()).toBe(true)
    dispose()
    expect(store.hasListener()).toBe(false)
    expect(channel.closed).toBe(true)
    expect(channel.onmessage).toBeNull()
  })

  it("returns an inert disposer when BroadcastChannel is unavailable", () => {
    const store = makeStore()
    const dispose = startMainPetBridge({ store: store as never })
    expect(store.hasListener()).toBe(false)
    expect(() => dispose()).not.toThrow()
  })

  it("constructs a BroadcastChannel from the global when none is injected", () => {
    const ctor = jest.fn()
    const real = (globalThis as Record<string, unknown>).BroadcastChannel
    ;(globalThis as Record<string, unknown>).BroadcastChannel = class {
      onmessage: unknown = null
      constructor(name: string) {
        ctor(name)
      }
      postMessage() {}
      close() {}
    } as unknown as typeof BroadcastChannel
    try {
      const store = makeStore()
      const dispose = startMainPetBridge({ store: store as never })
      expect(ctor).toHaveBeenCalledWith("cognia-pet-bridge")
      expect(store.hasListener()).toBe(true)
      dispose()
    } finally {
      ;(globalThis as Record<string, unknown>).BroadcastChannel = real
    }
  })
})

describe("startOverlayPetBridge", () => {
  it("posts request-state on start", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    startOverlayPetBridge({ channel, store: store as never })
    expect(channel.msgs()).toContainEqual({ v: 1, t: "request-state" })
  })

  it("applies visual-state, one-shot, and bubble into the store", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    startOverlayPetBridge({ channel, store: store as never })
    channel.deliver({ v: 1, t: "visual-state", state: "review" })
    channel.deliver({ v: 1, t: "one-shot", shot: "levelUp" })
    channel.deliver({ v: 1, t: "bubble", bubble: { text: "done" } })
    expect(store.__state.setVisualState).toHaveBeenCalledWith("review")
    expect(store.__state.enqueueOneShot).toHaveBeenCalledWith("levelUp")
    expect(store.__state.setBubble).toHaveBeenCalledWith({ text: "done", origin: "system" })
  })

  it("clears the bubble on a null bubble message", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    startOverlayPetBridge({ channel, store: store as never })
    channel.deliver({ v: 1, t: "bubble", bubble: null })
    expect(store.__state.setBubble).toHaveBeenCalledWith(null)
  })

  it("forwards activity pings to onActivity (and tolerates its absence)", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    const onActivity = jest.fn()
    startOverlayPetBridge({ channel, store: store as never, onActivity })
    channel.deliver({ v: 1, t: "activity", at: 12345 })
    expect(onActivity).toHaveBeenCalledWith(12345)

    // No handler installed → message is simply ignored.
    const channel2 = new FakeChannel()
    startOverlayPetBridge({ channel: channel2, store: store as never })
    expect(() => channel2.deliver({ v: 1, t: "activity", at: 1 })).not.toThrow()
  })

  it("ignores main-side-only and malformed messages", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    startOverlayPetBridge({ channel, store: store as never })
    channel.deliver({ v: 1, t: "interaction", kind: "fed" })
    channel.deliver({ v: 1, t: "request-state" })
    channel.deliver("nope")
    expect(store.__state.setVisualState).not.toHaveBeenCalled()
  })

  it("sendInteraction posts an interaction message", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    const { sendInteraction } = startOverlayPetBridge({ channel, store: store as never })
    sendInteraction("talked")
    expect(channel.msgs()).toContainEqual({ v: 1, t: "interaction", kind: "talked" })
  })

  it("sendInteraction carries trimmed talk text and caps it at 500 chars", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    const { sendInteraction } = startOverlayPetBridge({ channel, store: store as never })
    sendInteraction("talked", "hello pet")
    expect(channel.msgs()).toContainEqual({
      v: 1,
      t: "interaction",
      kind: "talked",
      text: "hello pet",
    })
    sendInteraction("talked", "   ")
    expect(channel.msgs()).toContainEqual({ v: 1, t: "interaction", kind: "talked" })
    sendInteraction("talked", "y".repeat(600))
    expect(channel.msgs()).toContainEqual({
      v: 1,
      t: "interaction",
      kind: "talked",
      text: "y".repeat(500),
    })
  })

  it("applies the broadcast bubble origin when present", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    startOverlayPetBridge({ channel, store: store as never })
    channel.deliver({ v: 1, t: "bubble", bubble: { text: "from llm", origin: "llm" } })
    expect(store.__state.setBubble).toHaveBeenCalledWith({ text: "from llm", origin: "llm" })
  })

  it("dispose closes the channel", () => {
    const channel = new FakeChannel()
    const store = makeStore()
    const { dispose } = startOverlayPetBridge({ channel, store: store as never })
    dispose()
    expect(channel.closed).toBe(true)
    expect(channel.onmessage).toBeNull()
  })

  it("returns inert handles when BroadcastChannel is unavailable", () => {
    const store = makeStore()
    const { dispose, sendInteraction } = startOverlayPetBridge({ store: store as never })
    expect(() => sendInteraction("fed")).not.toThrow()
    expect(() => dispose()).not.toThrow()
  })

  it("constructs a BroadcastChannel from the global when none is injected", () => {
    const ctor = jest.fn()
    const real = (globalThis as Record<string, unknown>).BroadcastChannel
    ;(globalThis as Record<string, unknown>).BroadcastChannel = class {
      onmessage: unknown = null
      constructor(name: string) {
        ctor(name)
      }
      postMessage() {}
      close() {}
    } as unknown as typeof BroadcastChannel
    try {
      const store = makeStore()
      const { dispose, sendInteraction } = startOverlayPetBridge({ store: store as never })
      expect(ctor).toHaveBeenCalledWith("cognia-pet-bridge")
      expect(() => sendInteraction("petted")).not.toThrow()
      dispose()
    } finally {
      ;(globalThis as Record<string, unknown>).BroadcastChannel = real
    }
  })
})

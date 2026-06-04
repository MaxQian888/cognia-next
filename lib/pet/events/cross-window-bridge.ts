// Wires the desktop-pet cross-window protocol over a `BroadcastChannel`.
//
// Two roles:
//  - main side (`startMainPetBridge`): the controller window. Subscribes the
//    pet store and broadcasts visual-state / bubble / newly-enqueued one-shots
//    so the overlay mirrors the controller's truth. Listens for "interaction"
//    (replays it as a user `PetEvent`, so XP is awarded exactly once, in the
//    main window) and "request-state" (re-broadcasts the current snapshot for a
//    freshly-opened overlay).
//  - overlay side (`startOverlayPetBridge`): the transparent window. Applies
//    inbound visual-state / one-shot / bubble into its own per-window store and
//    posts "request-state" on start. Exposes `sendInteraction` for the menu.
//
// Both guard environments without `BroadcastChannel` (SSR / older runtimes):
// they degrade to inert disposers so callers never need to feature-check.

import { usePetStore, type PetBubble } from "@/stores/pet/pet-store"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import {
  decodePetBridgeMessage,
  encodePetBridgeMessage,
  PET_BRIDGE_CHANNEL,
  type PetBridgeInteractionKind,
  type PetBridgeMessage,
} from "./cross-window-protocol"

/** Minimal `BroadcastChannel` surface for DI in tests. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

/** The slice of the pet store the bridge depends on (subset for DI in tests). */
type PetStoreApi = typeof usePetStore

function createChannel(provided?: BroadcastChannelLike): BroadcastChannelLike | null {
  if (provided) return provided
  if (typeof BroadcastChannel === "undefined") return null
  return new BroadcastChannel(PET_BRIDGE_CHANNEL) as unknown as BroadcastChannelLike
}

function post(channel: BroadcastChannelLike, msg: PetBridgeMessage): void {
  channel.postMessage(encodePetBridgeMessage(msg))
}

export interface MainPetBridgeDeps {
  channel?: BroadcastChannelLike
  store?: PetStoreApi
  /** DI seam for the user-event replay (defaults to the real pet event bus). */
  emit?: typeof emitPetEvent
}

/**
 * Start the main-window bridge side. Returns a `dispose()` that tears down both
 * the store subscription and the channel.
 */
export function startMainPetBridge(deps: MainPetBridgeDeps = {}): () => void {
  const channel = createChannel(deps.channel)
  if (!channel) return () => {}
  const store = deps.store ?? usePetStore
  const emit = deps.emit ?? emitPetEvent

  // Broadcast the current snapshot so a late-opening overlay catches up.
  const broadcastSnapshot = () => {
    const s = store.getState()
    post(channel, { v: 1, t: "visual-state", state: s.visualState })
    post(channel, { v: 1, t: "bubble", bubble: s.bubble ? { text: s.bubble.text } : null })
  }

  const unsub = store.subscribe((state, prev) => {
    if (state.visualState !== prev.visualState) {
      post(channel, { v: 1, t: "visual-state", state: state.visualState })
    }
    if (state.bubble !== prev.bubble) {
      post(channel, {
        v: 1,
        t: "bubble",
        bubble: state.bubble ? { text: state.bubble.text } : null,
      })
    }
    // One-shots are an append-only queue drained by the animation hook; detect
    // growth and forward only the newly-appended shots.
    if (state.oneShotQueue.length > prev.oneShotQueue.length) {
      const added = state.oneShotQueue.slice(prev.oneShotQueue.length)
      for (const shot of added) post(channel, { v: 1, t: "one-shot", shot })
    }
  })

  channel.onmessage = (event) => {
    const msg = decodePetBridgeMessage(event.data)
    if (!msg) return
    if (msg.t === "interaction") {
      emit({ source: "user", kind: msg.kind })
    } else if (msg.t === "request-state") {
      broadcastSnapshot()
    }
  }

  return () => {
    unsub()
    channel.onmessage = null
    channel.close()
  }
}

export interface OverlayPetBridgeDeps {
  channel?: BroadcastChannelLike
  store?: PetStoreApi
}

export interface OverlayPetBridge {
  dispose: () => void
  sendInteraction: (kind: PetBridgeInteractionKind) => void
}

/**
 * Start the overlay-window bridge side. Applies inbound messages into the
 * overlay's per-window store and posts "request-state" so the main side
 * immediately re-broadcasts its snapshot. Returns `{ dispose, sendInteraction }`.
 */
export function startOverlayPetBridge(deps: OverlayPetBridgeDeps = {}): OverlayPetBridge {
  const channel = createChannel(deps.channel)
  if (!channel) {
    return { dispose: () => {}, sendInteraction: () => {} }
  }
  const store = deps.store ?? usePetStore

  channel.onmessage = (event) => {
    const msg = decodePetBridgeMessage(event.data)
    if (!msg) return
    const api = store.getState()
    switch (msg.t) {
      case "visual-state":
        api.setVisualState(msg.state)
        break
      case "one-shot":
        api.enqueueOneShot(msg.shot)
        break
      case "bubble": {
        const next: PetBubble | null = msg.bubble
          ? { text: msg.bubble.text, origin: "system" }
          : null
        api.setBubble(next)
        break
      }
      // interaction / request-state are main-side concerns; ignore here.
    }
  }

  // Pull the current snapshot from the main side on connect.
  post(channel, { v: 1, t: "request-state" })

  return {
    dispose: () => {
      channel.onmessage = null
      channel.close()
    },
    sendInteraction: (kind) => post(channel, { v: 1, t: "interaction", kind }),
  }
}

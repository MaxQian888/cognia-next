// Versioned, pure wire protocol for the desktop-pet cross-window bridge. The
// main window owns the pet controller (truth for visual state / one-shots /
// bubble); the transparent overlay window mirrors it and sends back user
// interactions. Messages travel over a `BroadcastChannel` (see
// `cross-window-bridge.ts`), which is cross-context within the same origin —
// the same mechanism the scheduler uses (`lib/scheduler/task-scheduler.ts`).
//
// Keep this module pure and dependency-free so both windows agree on the shape
// and it is trivially testable. The profile/needs flow via Dexie liveQuery, not
// this channel, so there is intentionally no profile-snapshot message.

import type { PetOneShot, PetVisualState } from "@/types/pet"

/** Bridge wire text for a speech bubble — already localized by the main side. */
export interface PetBridgeBubble {
  text: string
  /** Bubble provenance so the overlay can style LLM replies like the widget. */
  origin?: "template" | "llm" | "system"
}

/** Interaction kinds the overlay can send back to the main controller. */
export type PetBridgeInteractionKind = "fed" | "played" | "petted" | "talked"

/** Discriminated union of every message that can cross the bridge. */
export type PetBridgeMessage =
  | { v: 1; t: "visual-state"; state: PetVisualState }
  | { v: 1; t: "one-shot"; shot: PetOneShot }
  | { v: 1; t: "bubble"; bubble: PetBridgeBubble | null }
  | { v: 1; t: "interaction"; kind: PetBridgeInteractionKind; text?: string }
  | { v: 1; t: "request-state" }
  // Throttled main-window user-activity ping (Smart-Moving). `at` is epoch ms
  // for ordering only — receivers stamp their OWN clock (the overlay's wander
  // gate runs on performance.now(), a different clock domain).
  | { v: 1; t: "activity"; at: number }

/** The `BroadcastChannel` name shared by both window sides. */
export const PET_BRIDGE_CHANNEL = "cognia-pet-bridge"

const VISUAL_STATES: ReadonlySet<string> = new Set<PetVisualState>([
  "idle",
  "thinking",
  "waiting",
  "review",
  "happy",
  "sad",
  "error",
  "sleeping",
  "greeting",
  "evolving",
  "interacting",
])

const ONE_SHOTS: ReadonlySet<string> = new Set<PetOneShot>([
  "wave",
  "happy",
  "fed",
  "petted",
  "evolving",
  "levelUp",
  "sad",
  "surprised",
  "love",
  "sleepy",
])

const INTERACTION_KINDS: ReadonlySet<string> = new Set<PetBridgeInteractionKind>([
  "fed",
  "played",
  "petted",
  "talked",
])

const BUBBLE_ORIGINS: ReadonlySet<string> = new Set(["template", "llm", "system"])

/** Defensive cap on interaction text — `speakAsPet` also slices to 500. */
const MAX_INTERACTION_TEXT = 500

/**
 * Encode a message for the wire. Identity today, but typed so every post site
 * goes through one place if the transport ever needs framing.
 */
export function encodePetBridgeMessage(msg: PetBridgeMessage): unknown {
  return msg
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Validate and narrow an untrusted wire value into a `PetBridgeMessage`.
 * Anything malformed (wrong version, unknown type, bad payload) → `null`.
 */
export function decodePetBridgeMessage(raw: unknown): PetBridgeMessage | null {
  if (!isRecord(raw)) return null
  if (raw.v !== 1) return null
  const t = raw.t
  switch (t) {
    case "visual-state":
      return typeof raw.state === "string" && VISUAL_STATES.has(raw.state)
        ? { v: 1, t: "visual-state", state: raw.state as PetVisualState }
        : null
    case "one-shot":
      return typeof raw.shot === "string" && ONE_SHOTS.has(raw.shot)
        ? { v: 1, t: "one-shot", shot: raw.shot as PetOneShot }
        : null
    case "bubble": {
      if (raw.bubble === null) return { v: 1, t: "bubble", bubble: null }
      if (isRecord(raw.bubble) && typeof raw.bubble.text === "string") {
        const origin =
          typeof raw.bubble.origin === "string" && BUBBLE_ORIGINS.has(raw.bubble.origin)
            ? (raw.bubble.origin as PetBridgeBubble["origin"])
            : undefined
        return {
          v: 1,
          t: "bubble",
          bubble: { text: raw.bubble.text, ...(origin ? { origin } : {}) },
        }
      }
      return null
    }
    case "interaction": {
      if (typeof raw.kind !== "string" || !INTERACTION_KINDS.has(raw.kind)) return null
      const text =
        typeof raw.text === "string" && raw.text.trim().length > 0
          ? raw.text.slice(0, MAX_INTERACTION_TEXT)
          : undefined
      return {
        v: 1,
        t: "interaction",
        kind: raw.kind as PetBridgeInteractionKind,
        ...(text ? { text } : {}),
      }
    }
    case "request-state":
      return { v: 1, t: "request-state" }
    case "activity":
      return typeof raw.at === "number" && Number.isFinite(raw.at)
        ? { v: 1, t: "activity", at: raw.at }
        : null
    default:
      return null
  }
}

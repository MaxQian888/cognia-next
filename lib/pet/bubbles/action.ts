// An optional follow-up a speech bubble can offer, like "Open Insights" on the
// bubble that announces a fresh Attention Radar report.
//
// Pure and dependency-light on purpose: the store, the cross-window wire
// protocol and the bubble view all import it, and the wire decoder must be
// able to validate an action arriving from another window without pulling in
// React or the event bus.

import { isPetConsoleTab, type PetConsoleTab } from "@/lib/pet/console-tabs"
import type { PetEventKind } from "@/types/pet"

/**
 * What clicking a bubble's action does. One variant today: open the `/pet`
 * console at a tab. A union so a later action cannot be added without every
 * handler (widget, overlay) deciding what it means.
 */
export type PetBubbleAction = { kind: "open-console"; tab: PetConsoleTab }

/**
 * Validate an action from an untrusted source (another window's broadcast).
 * Rebuilds a clean object from the known fields so extra keys never ride
 * along; anything malformed decodes to `null`, and the caller keeps the
 * bubble's text without the action.
 */
export function decodePetBubbleAction(value: unknown): PetBubbleAction | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (raw.kind !== "open-console") return null
  if (!isPetConsoleTab(raw.tab)) return null
  return { kind: "open-console", tab: raw.tab }
}

/** The follow-up a bubble for this event kind offers, if any. */
const ACTION_BY_KIND: Partial<Record<PetEventKind, PetBubbleAction>> = {
  // The radar report is read in the console's Insights tab.
  radarReport: { kind: "open-console", tab: "insights" },
}

/** The action a bubble announcing `kind` should carry, or `undefined`. */
export function bubbleActionForKind(kind: PetEventKind): PetBubbleAction | undefined {
  const action = ACTION_BY_KIND[kind]
  return action ? { ...action } : undefined
}

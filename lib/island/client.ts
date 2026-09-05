"use client"

/**
 * Tauri client for the task control island, both sides of the bridge.
 *
 * Every call is a no-op outside Tauri, so the browser and mobile shells import
 * this module without a guard at each call site and the island simply does not
 * exist there. Modeled on `lib/usage-dock/client.ts`, which solved the same
 * problem for the Capacity Dock: a projection pushed one way, typed intents
 * pushed back, and no shared store between the two windows.
 */

import { loggers } from "@cognia/logging"

import { isTauri } from "@/lib/tauri"
import {
  ISLAND_ACTION_INTENT_EVENT,
  ISLAND_ACTION_RESULT_EVENT,
  ISLAND_DETAIL_REQUEST_EVENT,
  ISLAND_DETAIL_RESPONSE_EVENT,
  ISLAND_STATE_EVENT,
  ISLAND_STATE_REQUEST_EVENT,
  ISLAND_WINDOW_LABEL,
  MAIN_WINDOW_LABEL,
} from "./events"
import type {
  IslandActionIntent,
  IslandActionResult,
  IslandDetailRequest,
  IslandDetailResponse,
  IslandState,
} from "./types"

/**
 * Deliver an event to a sibling WINDOW, by label.
 *
 * `Transport` has `call` and `subscribe` and deliberately no emit, because
 * every other caller is talking to a runtime rather than a window. The import
 * is dynamic so `@tauri-apps/api/event` stays out of the browser and mobile
 * bundles, exactly as `lib/usage-dock/client.ts` and `lib/pet/reveal.ts` do.
 */
async function emitToWindow(label: string, event: string, payload: unknown): Promise<boolean> {
  if (!isTauri()) return false
  try {
    const { emitTo } = await import("@tauri-apps/api/event")
    await emitTo(label, event, payload)
    return true
  } catch (error) {
    // The island is usually closed. Pushing to a window that is not there is
    // the normal case, not an error worth surfacing.
    loggers.tray?.debug?.(`island: emit ${event} failed`, { error: String(error) })
    return false
  }
}

async function listenHere<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  try {
    const { listen } = await import("@tauri-apps/api/event")
    return await listen<T>(event, (e) => handler(e.payload))
  } catch (error) {
    loggers.tray?.warn?.(`island: listen ${event} failed`, { error: String(error) })
    return () => {}
  }
}

/* -- Main-window side ---------------------------------------------------- */

export function sendIslandState(state: IslandState): Promise<boolean> {
  return emitToWindow(ISLAND_WINDOW_LABEL, ISLAND_STATE_EVENT, state)
}

export function sendIslandActionResult(result: IslandActionResult): Promise<boolean> {
  return emitToWindow(ISLAND_WINDOW_LABEL, ISLAND_ACTION_RESULT_EVENT, result)
}

export function sendIslandDetailResponse(response: IslandDetailResponse): Promise<boolean> {
  return emitToWindow(ISLAND_WINDOW_LABEL, ISLAND_DETAIL_RESPONSE_EVENT, response)
}

export function onIslandStateRequest(handler: () => void): Promise<() => void> {
  return listenHere<unknown>(ISLAND_STATE_REQUEST_EVENT, () => handler())
}

export function onIslandActionIntent(
  handler: (intent: IslandActionIntent) => void
): Promise<() => void> {
  return listenHere<IslandActionIntent>(ISLAND_ACTION_INTENT_EVENT, handler)
}

export function onIslandDetailRequest(
  handler: (request: IslandDetailRequest) => void
): Promise<() => void> {
  return listenHere<IslandDetailRequest>(ISLAND_DETAIL_REQUEST_EVENT, handler)
}

/* -- Island-window side -------------------------------------------------- */

export function requestIslandState(): Promise<boolean> {
  return emitToWindow(MAIN_WINDOW_LABEL, ISLAND_STATE_REQUEST_EVENT, null)
}

export function requestIslandAction(intent: IslandActionIntent): Promise<boolean> {
  return emitToWindow(MAIN_WINDOW_LABEL, ISLAND_ACTION_INTENT_EVENT, intent)
}

export function requestIslandDetail(request: IslandDetailRequest): Promise<boolean> {
  return emitToWindow(MAIN_WINDOW_LABEL, ISLAND_DETAIL_REQUEST_EVENT, request)
}

export function onIslandState(handler: (state: IslandState) => void): Promise<() => void> {
  return listenHere<IslandState>(ISLAND_STATE_EVENT, handler)
}

export function onIslandActionResult(
  handler: (result: IslandActionResult) => void
): Promise<() => void> {
  return listenHere<IslandActionResult>(ISLAND_ACTION_RESULT_EVENT, handler)
}

export function onIslandDetailResponse(
  handler: (response: IslandDetailResponse) => void
): Promise<() => void> {
  return listenHere<IslandDetailResponse>(ISLAND_DETAIL_RESPONSE_EVENT, handler)
}

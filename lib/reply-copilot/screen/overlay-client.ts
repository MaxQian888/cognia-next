"use client"

/**
 * Wire between the main window, which runs the desktop chat copilot, and the
 * `chat-copilot` overlay panel, which shows it (ADR-0194 §8).
 *
 * The pipeline has to run in the main window: decision providers from plugins
 * (laya) are registered in its runtime only. The overlay is presentation plus
 * intents, like the Capacity Dock (`lib/usage-dock/client.ts`), whose
 * `emitTo`-by-label pattern this follows. Every call is a no-op outside Tauri.
 */

import { loggers } from "@cognia/logging"

import type { CopilotKnowledge } from "@/lib/reply-copilot/knowledge"
import type { CopilotResult } from "@/lib/reply-copilot/run-copilot"
import { isTauri } from "@/lib/tauri"
import { transport } from "@/lib/tauri/transport-instance"
import type {
  ScreenAnchor,
  ScreenContactStatus,
  ScreenCopilotErrorKind,
} from "./run-screen-copilot"
import type { UnsidedReason } from "./screen-transcript"

/**
 * Command id the shortcut, the tray's command list and any other dispatcher
 * invoke (`lib/plugin/commands/registry.ts`). Registered in the main desktop
 * window only, by `ChatCopilotInitializer`. Lives here, not in the controller,
 * so Settings → Shortcuts can name it without importing the pipeline.
 */
export const CHAT_COPILOT_COMMAND_ID = "chat-copilot.capture"

export const CHAT_COPILOT_WINDOW_LABEL = "chat-copilot"
export const MAIN_WINDOW_LABEL = "main"
/** Main → overlay: the current view. */
export const CHAT_COPILOT_VIEW_EVENT = "chat-copilot://view"
/** Overlay → main: what the user did. */
export const CHAT_COPILOT_INTENT_EVENT = "chat-copilot://intent"

export interface ScreenReadSummary {
  appName: string
  windowTitle: string | null
  bubbleCount: number
  unsidedReason: UnsidedReason | null
  contact: ScreenContactStatus
}

export interface OverlayConsent {
  id: string
  processName: string | null
  windowTitle: string | null
  /** Wall-clock deadline of the host's auto-reject. */
  expiresAt: number
}

export type ChatCopilotViewError = ScreenCopilotErrorKind | "draft_failed"

export type ChatCopilotView =
  | { phase: "capturing"; runId: number }
  | { phase: "consent"; runId: number; consent: OverlayConsent }
  | { phase: "reading"; runId: number }
  | { phase: "thinking"; runId: number; read: ScreenReadSummary; instructions: string }
  | {
      phase: "done"
      runId: number
      read: ScreenReadSummary
      result: CopilotResult
      knowledge: CopilotKnowledge
      instructions: string
    }
  | {
      phase: "error"
      runId: number
      error: ChatCopilotViewError
      read?: ScreenReadSummary
      instructions?: string
    }

export type ChatCopilotIntent =
  | { kind: "ready" }
  | { kind: "consent"; id: string; allow: boolean; grantDurationMs?: number }
  | { kind: "redraft"; instructions: string }
  | { kind: "retry" }
  | { kind: "openScreenRecordingSettings" }
  | { kind: "close" }

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null
  try {
    return await transport.call<T>(command, args)
  } catch (error) {
    loggers.native.warn(`${command} failed`, { error: String(error) })
    return null
  }
}

async function emitToWindow(label: string, event: string, payload: unknown): Promise<void> {
  const { emitTo } = await import("@tauri-apps/api/event")
  await emitTo(label, event, payload)
}

/* ── Main-window side ──────────────────────────────────────────────────── */

/**
 * Open (or re-show) the overlay beside `anchor`, or at the top-right of the
 * screen under the cursor when the window is not known yet. Non-activating:
 * the chat app stays frontmost. Resolves false when the panel could not open.
 */
export async function openChatCopilotOverlay(anchor: ScreenAnchor | null): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await transport.call("chat_copilot_open", { anchor })
    return true
  } catch (error) {
    loggers.native.warn("chat_copilot_open failed", { error: String(error) })
    return false
  }
}

/** Move the open overlay beside the captured window. */
export async function placeChatCopilotOverlay(anchor: ScreenAnchor): Promise<void> {
  await call("chat_copilot_place", { anchor })
}

export async function closeChatCopilotOverlay(): Promise<void> {
  await call("chat_copilot_close")
}

export async function sendChatCopilotView(view: ChatCopilotView): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitToWindow(CHAT_COPILOT_WINDOW_LABEL, CHAT_COPILOT_VIEW_EVENT, view)
    return true
  } catch {
    // The overlay is usually closed; pushing to a missing window is normal.
    return false
  }
}

export async function onChatCopilotIntent(
  handler: (intent: ChatCopilotIntent) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  return transport.subscribe<ChatCopilotIntent>(CHAT_COPILOT_INTENT_EVENT, handler)
}

/* ── Overlay-window side ───────────────────────────────────────────────── */

/** First-paint reveal (a transparent window shown before paint renders black on Windows). */
export async function revealChatCopilotOverlay(): Promise<void> {
  await call("chat_copilot_reveal")
}

/** Fit the panel to its measured content, in logical px; Rust re-places it. */
export async function resizeChatCopilotOverlay(width: number, height: number): Promise<void> {
  await call("chat_copilot_resize", { width, height })
}

/**
 * Copy a candidate through the host clipboard. The panel never takes focus,
 * and `navigator.clipboard` refuses to write from an unfocused document.
 */
export async function copyFromChatCopilotOverlay(text: string): Promise<void> {
  if (!isTauri()) {
    await navigator.clipboard?.writeText(text)
    return
  }
  await transport.call("chat_copilot_copy", { text })
}

export async function sendChatCopilotIntent(intent: ChatCopilotIntent): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitToWindow(MAIN_WINDOW_LABEL, CHAT_COPILOT_INTENT_EVENT, intent)
    return true
  } catch (error) {
    loggers.native.warn("chat copilot intent failed", { error: String(error) })
    return false
  }
}

export async function onChatCopilotView(
  handler: (view: ChatCopilotView) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  return transport.subscribe<ChatCopilotView>(CHAT_COPILOT_VIEW_EVENT, handler)
}

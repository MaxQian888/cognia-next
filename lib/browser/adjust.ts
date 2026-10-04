import { browserClient } from "./client"
import type { BrowserAdjustmentChange, BrowserAdjustmentFeedback } from "@/types/browser-developer"

export interface BrowserAdjustmentDraft {
  font?: string
  text?: string
  spacing?: string
  color?: string
}

/** The two things Adjust asks of a page: try a draft on, and take it off again. */
export type BrowserAdjustAction = "preview" | "revert"

/**
 * Runs the injected overlay's `window.__cogniaAdjust(action, json)` in the page
 * a pane shows and resolves its JSON string. Each engine supplies one: the
 * embedded webview evaluates the call, local Chromium has a dedicated runtime
 * op (its `evaluate` is loopback-only), so the page code is the same for both.
 */
export interface BrowserAdjustDriver {
  run(action: BrowserAdjustAction, input: Record<string, unknown>): Promise<string>
}

/** The embedded webview's driver (the lightweight preview). */
export const embeddedAdjustDriver: BrowserAdjustDriver = {
  async run(action, input) {
    const result = await browserClient.embedEvaluate(
      `window.__cogniaAdjust(${JSON.stringify(action)}, ${JSON.stringify(JSON.stringify(input))})`
    )
    if (!result.ok) throw new Error(result.error ?? "Browser adjustment failed")
    if (typeof result.value !== "string") throw new Error("Browser adjustment failed")
    return result.value
  },
}

interface AdjustEnvelope {
  ok: boolean
  error?: string | null
  changes?: BrowserAdjustmentChange[]
}

async function runAdjust(
  driver: BrowserAdjustDriver,
  action: BrowserAdjustAction,
  input: Record<string, unknown>,
  failure: string
): Promise<AdjustEnvelope> {
  let envelope: AdjustEnvelope
  try {
    envelope = JSON.parse(await driver.run(action, input)) as AdjustEnvelope
  } catch (cause) {
    throw cause instanceof SyntaxError ? new Error(failure) : cause
  }
  if (!envelope || typeof envelope !== "object" || envelope.ok !== true) {
    throw new Error(envelope?.error || failure)
  }
  return envelope
}

export async function previewBrowserAdjustment(
  input: {
    previewId: string
    selector: string
    draft: BrowserAdjustmentDraft
  },
  driver: BrowserAdjustDriver = embeddedAdjustDriver
): Promise<BrowserAdjustmentChange[]> {
  const envelope = await runAdjust(driver, "preview", input, "Browser adjustment preview failed")
  return Array.isArray(envelope.changes) ? envelope.changes : []
}

export async function revertBrowserAdjustment(
  previewId: string,
  driver: BrowserAdjustDriver = embeddedAdjustDriver
): Promise<void> {
  await runAdjust(driver, "revert", { previewId }, "Browser adjustment revert failed")
}

export async function acceptBrowserAdjustment(
  input: {
    previewId: string
    sessionId: string
    browserSessionId: string
    pageUrl: string
    selector: string
    changes: BrowserAdjustmentChange[]
    now?: number
  },
  driver: BrowserAdjustDriver = embeddedAdjustDriver
): Promise<BrowserAdjustmentFeedback> {
  await revertBrowserAdjustment(input.previewId, driver)
  const now = input.now ?? Date.now()
  return {
    id: input.previewId,
    sessionId: input.sessionId,
    browserSessionId: input.browserSessionId,
    pageUrl: input.pageUrl,
    selector: input.selector,
    changes: input.changes,
    previewState: "accepted",
    createdAt: now,
    updatedAt: now,
  }
}

export function serializeBrowserAdjustmentFeedback(feedback: BrowserAdjustmentFeedback): string {
  return `<browser_adjustment_feedback>${JSON.stringify(feedback)}</browser_adjustment_feedback>`
}

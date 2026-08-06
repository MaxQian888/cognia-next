import { browserClient } from "./client"
import type { BrowserAdjustmentChange, BrowserAdjustmentFeedback } from "@/types/browser-developer"

export interface BrowserAdjustmentDraft {
  font?: string
  text?: string
  spacing?: string
  color?: string
}

interface PreviewResult {
  before: BrowserAdjustmentChange[]
  after: BrowserAdjustmentChange[]
}

function adjustmentExpression(
  previewId: string,
  selector: string,
  draft: BrowserAdjustmentDraft
): string {
  const payload = JSON.stringify({ previewId, selector, draft })
  return `(() => {
    const input = ${payload};
    const key = "__cogniaBrowserAdjust";
    const registry = window[key] || (window[key] = {});
    const previous = registry[input.previewId];
    if (previous?.element?.isConnected) {
      for (const [name, value] of Object.entries(previous.styles)) previous.element.style[name] = value;
      if (previous.text !== null) previous.element.textContent = previous.text;
    }
    const element = document.querySelector(input.selector);
    if (!element) throw new Error("selected element is no longer available");
    const computed = getComputedStyle(element);
    const styles = {
      fontFamily: element.style.fontFamily,
      fontSize: element.style.fontSize,
      padding: element.style.padding,
      color: element.style.color,
    };
    const before = [];
    if (input.draft.font) {
      before.push({property:"font",cssProperty:"font",before:computed.font,after:input.draft.font});
      element.style.font = input.draft.font;
    }
    if (input.draft.spacing) {
      before.push({property:"spacing",cssProperty:"padding",before:computed.padding,after:input.draft.spacing});
      element.style.padding = input.draft.spacing;
    }
    if (input.draft.color) {
      before.push({property:"color",cssProperty:"color",before:computed.color,after:input.draft.color});
      element.style.color = input.draft.color;
    }
    const originalText = input.draft.text !== undefined ? element.textContent : null;
    if (input.draft.text !== undefined) {
      before.push({property:"text",before:element.textContent || "",after:input.draft.text});
      element.textContent = input.draft.text;
    }
    registry[input.previewId] = { element, styles, text: originalText };
    return { before, after: before };
  })()`
}

function revertExpression(previewId: string): string {
  return `(() => {
    const registry = window.__cogniaBrowserAdjust || {};
    const previous = registry[${JSON.stringify(previewId)}];
    if (!previous) return false;
    if (previous.element?.isConnected) {
      for (const [name, value] of Object.entries(previous.styles)) previous.element.style[name] = value;
      if (previous.text !== null) previous.element.textContent = previous.text;
    }
    delete registry[${JSON.stringify(previewId)}];
    return true;
  })()`
}

export async function previewBrowserAdjustment(input: {
  previewId: string
  selector: string
  draft: BrowserAdjustmentDraft
}): Promise<BrowserAdjustmentChange[]> {
  const result = (await browserClient.embedEvaluate(
    adjustmentExpression(input.previewId, input.selector, input.draft)
  )) as { ok: boolean; value?: PreviewResult; error?: string }
  if (!result.ok) throw new Error(result.error ?? "Browser adjustment preview failed")
  return result.value?.before ?? []
}

export async function revertBrowserAdjustment(previewId: string): Promise<void> {
  const result = (await browserClient.embedEvaluate(revertExpression(previewId))) as {
    ok: boolean
    value?: boolean
    error?: string
  }
  if (!result.ok) throw new Error(result.error ?? "Browser adjustment revert failed")
}

export async function acceptBrowserAdjustment(input: {
  previewId: string
  sessionId: string
  browserSessionId: string
  pageUrl: string
  selector: string
  changes: BrowserAdjustmentChange[]
  now?: number
}): Promise<BrowserAdjustmentFeedback> {
  await revertBrowserAdjustment(input.previewId)
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

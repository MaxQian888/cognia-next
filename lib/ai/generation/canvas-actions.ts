/**
 * Canvas Actions — the one place a Canvas AI action turns into a model call.
 *
 * There used to be two. `useCanvasActions` built its own prompt with
 * `buildActionUserPrompt` and gated it with `hasNoLeakingPii`; the plugin API
 * called `executeCanvasAction`, which built a DIFFERENT prompt with
 * `buildCanvasPrompts` (attachments, per-action temperature) and gated nothing.
 * So a plugin got richer prompts and no redaction check, and a fix to either
 * half only reached one of them.
 *
 * Now both call `runCanvasAction` / `streamCanvasAction`. The PII gate lives
 * inside them rather than at each call site, which is what makes it
 * unskippable: a new caller cannot forget a step it never had to write.
 */

import { generateText, streamText } from "ai"
import { getProviderModel } from "@cognia/provider-core/core/client"
import type { CanvasActionAttachment } from "@/types/artifact/artifact"
import { webviewSafeTelemetry } from "@/lib/ai/webview-safe-telemetry"
import { hasNoLeakingPii } from "@cognia/redact"
import type { LanguageModel } from "ai"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import {
  definePrompt,
  type PromptDefinitionV1,
  type PromptResolutionContext,
} from "@/lib/prompts/types"
import type {
  CanvasActionConfig,
  CanvasActionExecutionOptions,
  CanvasActionResult,
  CanvasActionType,
  StreamingCallbacks,
} from "@cognia/plugin-contract/lib/ai/generation/canvas-actions"
export type {
  CanvasActionConfig,
  CanvasActionExecutionOptions,
  CanvasActionResult,
  CanvasActionType,
  StreamingCallbacks,
} from "@cognia/plugin-contract/lib/ai/generation/canvas-actions"

// The pure diff → hunk → apply engine was extracted to `canvas-review` (no
// `ai`/provider imports) so persisted/widely-imported consumers (the artifact
// store) can use it without pulling in the AI SDK. Import those functions from
// `@/lib/ai/generation/canvas-review` directly.

/** What the app's own runs add: cancellation and the document's prompt context. */
export interface CanvasActionRunOptions extends CanvasActionExecutionOptions {
  abortSignal?: AbortSignal
  /**
   * The canvas document's session and workspace, so a customized action
   * prompt for either applies (ADR-0236). The plugin path never sets it:
   * a plugin resolves at account scope only.
   */
  promptContext?: PromptResolutionContext
}

/** Actions whose output replaces the document (or selection) text. */
const CONTENT_ACTIONS: readonly CanvasActionType[] = [
  "custom",
  "fix",
  "improve",
  "simplify",
  "expand",
  "translate",
  "format",
]

/**
 * One editable template per action (ADR-0236). The host keeps everything
 * around it: the `Language:` / `Target language:` lines it prepends, the user
 * instruction and attachments it appends, and which half of the output it
 * applies, so an edited body can change the wording but not the plumbing.
 */
function canvasActionPrompt(action: CanvasActionType, defaultBody: string): PromptDefinitionV1 {
  const content = CONTENT_ACTIONS.includes(action)
  return definePrompt({
    id: `generation.canvas.${action}`,
    contractVersion: 1,
    kind: "feature-template",
    group: "generation",
    operation: "replace-template",
    scopes: ["account", "workspace", "session"],
    activation: "next-operation",
    risk: "ordinary",
    hosts: ["app"],
    maxChars: 8_000,
    outputContract: content
      ? "The reply replaces the document or selection text, so it should be the content alone."
      : "The reply is shown beside the document as an explanation; nothing is applied.",
    consumers: ["lib/ai/generation/canvas-actions.ts"],
    defaultBody,
  })
}

export const CANVAS_ACTION_PROMPTS: Readonly<Record<CanvasActionType, PromptDefinitionV1>> = {
  custom: canvasActionPrompt(
    "custom",
    `You are an expert editing assistant working inside a document canvas.
Apply the user's instruction to the provided content while preserving valid syntax, formatting, and intent.
Return ONLY the updated content without any explanation.`
  ),

  review: canvasActionPrompt(
    "review",
    `You are a code/text reviewer. Analyze the following content and provide a detailed review including:
- Overall quality assessment
- Potential issues or bugs
- Suggestions for improvement
- Best practices that could be applied

Provide your review in a clear, structured format.`
  ),

  fix: canvasActionPrompt(
    "fix",
    `You are an expert debugger and fixer. Analyze the following content and fix any issues you find:
- Fix bugs, errors, or logical issues
- Correct syntax errors
- Fix typos and grammatical errors
- Ensure proper formatting

Return ONLY the fixed content without any explanation. Preserve the original structure and style.`
  ),

  improve: canvasActionPrompt(
    "improve",
    `You are an expert at improving code and text quality. Enhance the following content by:
- Improving readability and clarity
- Optimizing performance (for code)
- Following best practices
- Enhancing structure and organization

Return ONLY the improved content without any explanation. Preserve the original intent.`
  ),

  explain: canvasActionPrompt(
    "explain",
    `You are an expert teacher. Explain the following content in detail:
- What it does and how it works
- Key concepts and components
- Step-by-step breakdown
- Any important considerations

Provide a clear, educational explanation suitable for someone learning.`
  ),

  simplify: canvasActionPrompt(
    "simplify",
    `You are an expert at simplification. Simplify the following content by:
- Reducing complexity while preserving meaning
- Using simpler language or constructs
- Removing unnecessary parts
- Making it more concise

Return ONLY the simplified content without any explanation.`
  ),

  expand: canvasActionPrompt(
    "expand",
    `You are an expert at elaboration. Expand the following content by:
- Adding more detail and context
- Including examples where helpful
- Elaborating on key points
- Adding documentation or comments (for code)

Return ONLY the expanded content without any explanation.`
  ),

  translate: canvasActionPrompt(
    "translate",
    `You are a professional translator. Translate the following content to the target language specified.
If no target language is specified, translate to English.
Preserve the original formatting, structure, and meaning.

Return ONLY the translated content without any explanation.`
  ),

  format: canvasActionPrompt(
    "format",
    `You are an expert at formatting. Format the following content properly:
- Apply consistent indentation
- Fix spacing and alignment
- Organize structure logically
- Follow standard formatting conventions

Return ONLY the formatted content without any explanation.`
  ),

  run: canvasActionPrompt(
    "run",
    `You are a code execution simulator. Analyze the following code and describe what would happen if it were executed:
- Expected output
- Side effects
- Potential runtime errors
- Performance considerations

Note: This is a simulation, not actual execution.`
  ),
}

function isContentAction(actionType: CanvasActionType): boolean {
  return CONTENT_ACTIONS.includes(actionType)
}

function buildAttachmentContext(attachments?: CanvasActionAttachment[]): string {
  if (!attachments || attachments.length === 0) {
    return ""
  }

  const sections = attachments.map((attachment) => {
    const flags = [
      attachment.isMissing ? "missing" : null,
      attachment.isTruncated ? "truncated" : null,
    ]
      .filter(Boolean)
      .join(", ")

    const suffix = flags ? ` (${flags})` : ""
    return `Attachment: ${attachment.label} [${attachment.sourceType}]${suffix}\n${attachment.snapshot}`
  })

  return `\n\nAdditional context:\n${sections.join("\n\n")}`
}

function buildInstructionContext(prompt?: string): string {
  if (!prompt || !prompt.trim()) {
    return ""
  }

  return `\n\nUser instruction:\n${prompt.trim()}`
}

async function buildCanvasPrompts(
  actionType: CanvasActionType,
  content: string,
  options?: CanvasActionRunOptions
): Promise<{
  systemPrompt: string
  userPrompt: string
}> {
  const { language, targetLanguage, selection, prompt, attachments, promptContext } = options || {}

  let systemPrompt = (
    await resolvePromptAsync(CANVAS_ACTION_PROMPTS[actionType], { context: promptContext })
  ).text
  const userPrompt = selection && selection.trim() ? selection : content

  if (
    language &&
    ["review", "fix", "improve", "explain", "format", "run", "custom"].includes(actionType)
  ) {
    systemPrompt = `Language: ${language}\n\n${systemPrompt}`
  }

  if (actionType === "translate" && targetLanguage) {
    systemPrompt = `Target language: ${targetLanguage}\n\n${systemPrompt}`
  }

  systemPrompt = `${systemPrompt}${buildInstructionContext(prompt)}${buildAttachmentContext(attachments)}`

  return {
    systemPrompt,
    userPrompt,
  }
}

/**
 * Thrown when the composed prompt trips the redaction gate. Named so callers
 * can tell a refusal apart from a provider failure and say so in the UI, rather
 * than showing "Action failed" for something the user can actually fix.
 */
export class CanvasActionPiiBlockedError extends Error {
  readonly code = "pii_blocked" as const

  constructor() {
    super("Canvas action blocked by PII gate")
    this.name = "CanvasActionPiiBlockedError"
  }
}

/** Deterministic actions get a low temperature; the rest keep some latitude. */
function temperatureFor(actionType: CanvasActionType): number {
  return actionType === "fix" || actionType === "format" ? 0.3 : 0.7
}

/**
 * The gate every Canvas action passes, on both halves of the prompt. Kept here
 * rather than at the call sites so a new caller inherits it for free.
 */
function assertPromptIsSendable(systemPrompt: string, userPrompt: string): void {
  if (!hasNoLeakingPii(systemPrompt) || !hasNoLeakingPii(userPrompt)) {
    throw new CanvasActionPiiBlockedError()
  }
}

/**
 * Run an action against an already-resolved model. This is the single
 * execution path: the hook resolves the user's configured provider, the plugin
 * API resolves the plugin's config, and both land here.
 *
 * Throws rather than returning a result envelope, because the two things a
 * caller must distinguish (a redaction refusal and a provider failure) are
 * error kinds, and swallowing them into `{ success: false }` is how the plugin
 * path ended up unable to explain itself.
 */
export async function runCanvasAction(
  model: LanguageModel,
  actionType: CanvasActionType,
  content: string,
  options?: CanvasActionRunOptions
): Promise<string> {
  const { systemPrompt, userPrompt } = await buildCanvasPrompts(actionType, content, options)
  // A cancel that landed while the prompt resolved never reaches the provider.
  options?.abortSignal?.throwIfAborted()
  assertPromptIsSendable(systemPrompt, userPrompt)

  const result = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    temperature: temperatureFor(actionType),
    abortSignal: options?.abortSignal,
  })
  return result.text
}

/**
 * Streaming half of {@link runCanvasAction}. Resolves with the full text once
 * the stream ends, so a caller that wants both the deltas and the final value
 * does not have to accumulate twice.
 */
export async function streamCanvasAction(
  model: LanguageModel,
  actionType: CanvasActionType,
  content: string,
  onDelta: (delta: string) => void,
  options?: CanvasActionRunOptions
): Promise<string> {
  const { systemPrompt, userPrompt } = await buildCanvasPrompts(actionType, content, options)
  // A cancel that landed while the prompt resolved never reaches the provider.
  options?.abortSignal?.throwIfAborted()
  assertPromptIsSendable(systemPrompt, userPrompt)

  const result = streamText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    temperature: temperatureFor(actionType),
    abortSignal: options?.abortSignal,
    // A failed or stopped canvas stream must not leak the SDK's tracing
    // promise in the webview (see webview-safe-telemetry).
    telemetry: webviewSafeTelemetry(),
  })

  let full = ""
  for await (const delta of result.textStream) {
    full += delta
    onDelta(delta)
  }
  return full
}

/**
 * The plugin-facing options, copied field by field: a plugin object carrying
 * `promptContext` at runtime must not pick a session's customized prompt.
 */
function pluginOptions(options?: CanvasActionExecutionOptions): CanvasActionExecutionOptions {
  if (!options) return {}
  const { language, targetLanguage, selection, prompt, attachments } = options
  return { language, targetLanguage, selection, prompt, attachments }
}

/**
 * Execute a canvas action from a provider config (the plugin-facing shape).
 * A thin wrapper over {@link runCanvasAction} that keeps the result-envelope
 * contract plugins are written against.
 */
export async function executeCanvasAction(
  actionType: CanvasActionType,
  content: string,
  config: CanvasActionConfig,
  options?: CanvasActionExecutionOptions
): Promise<CanvasActionResult> {
  const { provider, model, apiKey, baseURL, apiFlavor, headers } = config

  try {
    const modelInstance = getProviderModel({ provider, model, apiKey, baseURL, apiFlavor, headers })
    const text = await runCanvasAction(modelInstance, actionType, content, pluginOptions(options))

    return {
      success: true,
      result: text,
      explanation: isContentAction(actionType) ? undefined : text,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Action failed",
    }
  }
}

/**
 * Apply the result of a canvas action to the original content
 * Handles both full content replacement and selection replacement
 */
/**
 * The prompt pair a Canvas action sends, exposed for tests and for callers that
 * want to show or size the prompt before running it.
 *
 * This replaced a second builder (`buildActionUserPrompt`) that the UI hook
 * used while the plugin path used `buildCanvasPrompts`. The two disagreed about
 * attachments and about where the instruction went, so the same action produced
 * different prompts depending on who asked for it.
 */
export function buildCanvasActionPrompts(
  actionType: CanvasActionType,
  content: string,
  options?: CanvasActionRunOptions
): Promise<{ systemPrompt: string; userPrompt: string }> {
  return buildCanvasPrompts(actionType, content, options)
}

export function applyCanvasActionResult(
  originalContent: string,
  result: string,
  selection?: string
): string {
  if (!selection || !selection.trim()) {
    return result
  }

  const selectionIndex = originalContent.indexOf(selection)
  if (selectionIndex === -1) {
    return result
  }

  return (
    originalContent.slice(0, selectionIndex) +
    result +
    originalContent.slice(selectionIndex + selection.length)
  )
}

/**
 * Get a user-friendly description of what an action does
 */
export function getActionDescription(actionType: CanvasActionType): string {
  const descriptions: Record<CanvasActionType, string> = {
    custom: "Apply a custom editing instruction to the current content",
    review: "Analyze and review the content for issues and improvements",
    fix: "Automatically fix bugs, errors, and issues",
    improve: "Enhance quality, readability, and best practices",
    explain: "Get a detailed explanation of how the content works",
    simplify: "Make the content simpler and more concise",
    expand: "Add more detail, context, and documentation",
    translate: "Translate to another language",
    format: "Apply proper formatting and structure",
    run: "Simulate code execution and show expected output",
  }
  return descriptions[actionType]
}

/**
 * Execute a canvas action with streaming support for real-time display
 */
export async function executeCanvasActionStreaming(
  actionType: CanvasActionType,
  content: string,
  config: CanvasActionConfig,
  callbacks: StreamingCallbacks,
  options?: CanvasActionExecutionOptions
): Promise<void> {
  const { provider, model, apiKey, baseURL, apiFlavor, headers } = config

  try {
    const modelInstance = getProviderModel({ provider, model, apiKey, baseURL, apiFlavor, headers })
    const fullText = await streamCanvasAction(
      modelInstance,
      actionType,
      content,
      callbacks.onToken,
      pluginOptions(options)
    )
    callbacks.onComplete(fullText)
  } catch (error) {
    callbacks.onError(error instanceof Error ? error.message : "Streaming action failed")
  }
}

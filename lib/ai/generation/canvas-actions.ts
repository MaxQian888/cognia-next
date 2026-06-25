/**
 * Canvas Actions - AI-powered text/code processing for canvas
 */

import { generateText, streamText } from "ai"
import { getProviderModel, type ProviderName } from "@cognia/provider-core/core/client"
import type { CanvasActionAttachment, CanvasWorkbenchActionType } from "@/types/artifact/artifact"

// The pure diff → hunk → apply engine was extracted to `canvas-review` (no
// `ai`/provider imports) so persisted/widely-imported consumers (the artifact
// store) can use it without pulling in the AI SDK. Import those functions from
// `@/lib/ai/generation/canvas-review` directly.

export type CanvasActionType = CanvasWorkbenchActionType

export interface CanvasActionConfig {
  provider: ProviderName
  model: string
  apiKey: string
  baseURL?: string
}

export interface CanvasActionResult {
  success: boolean
  result?: string
  explanation?: string
  error?: string
}

export interface CanvasActionExecutionOptions {
  language?: string
  targetLanguage?: string
  selection?: string
  prompt?: string
  attachments?: CanvasActionAttachment[]
}

export const ACTION_PROMPTS: Record<CanvasActionType, string> = {
  custom: `You are an expert editing assistant working inside a document canvas.
Apply the user's instruction to the provided content while preserving valid syntax, formatting, and intent.
Return ONLY the updated content without any explanation.`,

  review: `You are a code/text reviewer. Analyze the following content and provide a detailed review including:
- Overall quality assessment
- Potential issues or bugs
- Suggestions for improvement
- Best practices that could be applied

Provide your review in a clear, structured format.`,

  fix: `You are an expert debugger and fixer. Analyze the following content and fix any issues you find:
- Fix bugs, errors, or logical issues
- Correct syntax errors
- Fix typos and grammatical errors
- Ensure proper formatting

Return ONLY the fixed content without any explanation. Preserve the original structure and style.`,

  improve: `You are an expert at improving code and text quality. Enhance the following content by:
- Improving readability and clarity
- Optimizing performance (for code)
- Following best practices
- Enhancing structure and organization

Return ONLY the improved content without any explanation. Preserve the original intent.`,

  explain: `You are an expert teacher. Explain the following content in detail:
- What it does and how it works
- Key concepts and components
- Step-by-step breakdown
- Any important considerations

Provide a clear, educational explanation suitable for someone learning.`,

  simplify: `You are an expert at simplification. Simplify the following content by:
- Reducing complexity while preserving meaning
- Using simpler language or constructs
- Removing unnecessary parts
- Making it more concise

Return ONLY the simplified content without any explanation.`,

  expand: `You are an expert at elaboration. Expand the following content by:
- Adding more detail and context
- Including examples where helpful
- Elaborating on key points
- Adding documentation or comments (for code)

Return ONLY the expanded content without any explanation.`,

  translate: `You are a professional translator. Translate the following content to the target language specified.
If no target language is specified, translate to English.
Preserve the original formatting, structure, and meaning.

Return ONLY the translated content without any explanation.`,

  format: `You are an expert at formatting. Format the following content properly:
- Apply consistent indentation
- Fix spacing and alignment
- Organize structure logically
- Follow standard formatting conventions

Return ONLY the formatted content without any explanation.`,

  run: `You are a code execution simulator. Analyze the following code and describe what would happen if it were executed:
- Expected output
- Side effects
- Potential runtime errors
- Performance considerations

Note: This is a simulation, not actual execution.`,
}

function isContentAction(actionType: CanvasActionType): boolean {
  return ["custom", "fix", "improve", "simplify", "expand", "translate", "format"].includes(
    actionType
  )
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

function buildCanvasPrompts(
  actionType: CanvasActionType,
  content: string,
  options?: CanvasActionExecutionOptions
): {
  systemPrompt: string
  userPrompt: string
} {
  const { language, targetLanguage, selection, prompt, attachments } = options || {}

  let systemPrompt = ACTION_PROMPTS[actionType]
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
 * Execute a canvas action on the given content
 */
export async function executeCanvasAction(
  actionType: CanvasActionType,
  content: string,
  config: CanvasActionConfig,
  options?: CanvasActionExecutionOptions
): Promise<CanvasActionResult> {
  const { provider, model, apiKey, baseURL } = config

  try {
    const modelInstance = getProviderModel({ provider, model, apiKey, baseURL })
    const { systemPrompt, userPrompt } = buildCanvasPrompts(actionType, content, options)

    const result = await generateText({
      model: modelInstance,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: actionType === "fix" || actionType === "format" ? 0.3 : 0.7,
    })

    return {
      success: true,
      result: result.text,
      explanation: isContentAction(actionType) ? undefined : result.text,
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
 * cognia-next helper. Builds the user prompt the model sees for a
 * given canvas action. Matches the structure of the executors in
 * Cognia but exposed as a pure function so cognia-next's slim hooks
 * can render the prompt themselves.
 */
export function buildActionUserPrompt(req: {
  actionType: CanvasActionType
  content: string
  language?: string
  selection?: string
  prompt?: string
  targetLanguage?: string
}): string {
  const lines: string[] = []
  if (req.language) lines.push(`Language: ${req.language}`)
  if (req.targetLanguage) lines.push(`Target language: ${req.targetLanguage}`)
  if (req.prompt) lines.push(`Instruction: ${req.prompt}`)
  if (req.selection) {
    lines.push("Selection:")
    lines.push(req.selection)
  } else {
    lines.push("Document:")
    lines.push(req.content)
  }
  return lines.join("\n\n")
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
 * Streaming callback for real-time AI action results
 */
export interface StreamingCallbacks {
  onToken: (token: string) => void
  onComplete: (fullText: string) => void
  onError: (error: string) => void
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
  const { provider, model, apiKey, baseURL } = config

  try {
    const modelInstance = getProviderModel({ provider, model, apiKey, baseURL })
    const { systemPrompt, userPrompt } = buildCanvasPrompts(actionType, content, options)

    const result = streamText({
      model: modelInstance,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: actionType === "fix" || actionType === "format" ? 0.3 : 0.7,
    })

    let fullText = ""
    for await (const textPart of result.textStream) {
      fullText += textPart
      callbacks.onToken(textPart)
    }

    callbacks.onComplete(fullText)
  } catch (error) {
    callbacks.onError(error instanceof Error ? error.message : "Streaming action failed")
  }
}

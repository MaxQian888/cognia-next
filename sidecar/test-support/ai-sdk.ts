import assert from "node:assert/strict"
import { dispatchAiSdk } from "../src/runtimes/ai-sdk/index.ts"
import type { DispatchAiSdkOptions } from "../src/runtimes/ai-sdk/index.ts"
/** Test observer projections; fixtures assert the event kind before reading its payload. */
export interface TestFrame extends Record<string, unknown> {
  type: string
  sessionId: string
  execId: string
  toolUseId: string
  args: Record<string, unknown>
  requestId: string
  reviewId: string
  conversationSnapshot: TestMessage[]
  logicalStepId: string
  estimatedInputTokens: number
  name: string
  error: string
  event: {
    type: string
    subtype: string
    message: {
      model: string
      content: { type: string; text: string; name: string; content: unknown }[]
    }
    usage: Record<string, number>
    compact_metadata: {
      frozenSummaryDecision: string
      pre_tokens: number
      optical: {
        frames: { base64: string }[]
        estImageTokens: number
        estTextTokens: number
        frameCount: number
        tokenSavings: number
        [key: string]: unknown
      }
      pre_messages: TestMessage[]
      [key: string]: unknown
    }
    [key: string]: unknown
  }
}
export interface TestPart {
  type: string
  text?: string
  toolCallId?: string
  toolName?: string
  output?: unknown
  [key: string]: unknown
}
export interface TestMessage extends Record<string, unknown> {
  role: string
  content: string | TestPart[]
  providerOptions?: { anthropic?: Record<string, unknown> }
}
export interface TestTool {
  execute(args: Record<string, unknown>, options?: unknown): Promise<unknown>
}
export interface TestStreamArgs extends Record<string, unknown> {
  model: { modelId: string; provider: string }
  instructions: TestMessage[]
  messages: TestMessage[]
  tools: Record<string, TestTool>
  abortSignal: AbortSignal
  stopWhen(input: { steps: unknown[] }): boolean
  prepareStep(): { activeTools: string[] }
  headers: Record<string, string>
  providerOptions: Record<string, Record<string, unknown>>
}
export const streamArgs = (value: Record<string, unknown>) => value as TestStreamArgs
export function captureEmit() {
  const events: TestFrame[] = []
  return { events, emit: (event: Record<string, unknown>) => events.push(event as TestFrame) }
}
export function startSession(options: DispatchAiSdkOptions) {
  const session = dispatchAiSdk(options)
  assert.ok(session, "expected a configured AI SDK session")
  return session
}

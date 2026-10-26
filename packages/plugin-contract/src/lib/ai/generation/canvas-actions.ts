/**
 * The plugin contract's share of `lib/ai/generation/canvas-actions.ts`, which re-exports these.
 */
import type { ApiFlavor } from "@cognia/provider-types/provider"
import type {
  CanvasActionAttachment,
  CanvasWorkbenchActionType,
} from "../../../types/artifact/artifact"
import type { ProviderName } from "@cognia/provider-core/core/client"

export type CanvasActionType = CanvasWorkbenchActionType

export interface CanvasActionConfig {
  provider: ProviderName
  model: string
  apiKey: string
  baseURL?: string
  apiFlavor?: ApiFlavor
  headers?: Record<string, string>
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

/**
 * Streaming callback for real-time AI action results
 */
export interface StreamingCallbacks {
  onToken: (token: string) => void
  onComplete: (fullText: string) => void
  onError: (error: string) => void
}
